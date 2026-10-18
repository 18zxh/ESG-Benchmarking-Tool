"""Compatibility bindings. Standards and judgment validators stay upstream."""
from __future__ import annotations
import functools
import hashlib
import json
from pathlib import Path
import threading
from contextvars import copy_context

from .core import ACTIVE, LocalError, fingerprint, running
from .pdf_engine import evidence_windows, preflight_ranges, reading_batches, request_pdf, label_page


class Bindings:
    def __init__(self, modules, store, gateway):
        self.modules, self.store, self.gateway = modules, store, gateway
        root = Path(__file__).parent
        self.contract = fingerprint([(name, hashlib.sha256((root / name).read_bytes()).hexdigest()) for name in
            ('core.py', 'gateway.py', 'loader.py', 'adapters.py', 'pdf_engine.py', 'csa_windows.py', 'upstream.json')])
        gateway.listeners.append(self.sync_providers)
        self._csa()
        self._msci()
        self._exchange()
        self._shared_windows()
        self._shared_pdf()

    def sync_providers(self, provider):
        for ns in ('csa', 'msci'):
            models = self.modules.get(ns, 'model_proxy')
            with models.PROVIDER_LOCK:
                models.PROVIDERS.clear()
                models.PROVIDERS[provider['id']] = dict(provider)

    def cache_scope(self):
        run = ACTIVE.get()
        return run.scope if run else 'standalone'

    def _transport(self, ns, provider, payload):
        try:
            return self.gateway.send(provider, payload, namespace=ns)
        except LocalError as exc:
            error = self.modules.get(ns, 'errors').RequestError
            if ns == 'exchange':
                category = 'network' if '连接中断' in str(exc) else 'upstream'
                raise error(str(exc), category, exc.status) from None
            raise error(str(exc)) from None

    def _csa(self):
        native = self.modules.get('csa', 'native_pdf')
        runtime = self.modules.get('csa', 'workbench_runtime')
        bindings = self
        class CSAStore:
            def get(self, namespace, key):
                run = runtime.current()
                active = ACTIVE.get()
                scope = active.scope if active else run.scope if run else 'standalone'
                return bindings.store.get('csa', scope, 'native', key, bindings.contract)
            def put(self, namespace, key, value):
                run = runtime.current()
                active = ACTIVE.get()
                scope = active.scope if active else run.scope if run else 'standalone'
                bindings.store.put('csa', scope, 'native', key, bindings.contract, value)
            def clear(self, namespace='csa'):
                bindings.store.clear_cache('csa')
            def save_job(self, job_id, value):
                bindings.store.save_job('csa', job_id, value)
            def job(self, job_id):
                return bindings.store.job('csa', job_id)
            def record_usage(self, run_id, value):
                # Gateway is authoritative; upstream still accumulates UI totals.
                return None
        runtime.Store = CSAStore
        jobs = self.modules.get('csa', 'native_pdf_jobs')
        jobs.Store = CSAStore
        original_identity = jobs._identity
        def identity(value, provider):
            # Identical files/fields in two enterprise groups are still two jobs.
            return fingerprint([self.cache_scope(), original_identity(value, provider)])
        jobs._identity = identity
        original_create = jobs.create
        def create(value, provider):
            key = original_create(value, provider)
            with jobs._LOCK:
                if key in jobs._JOBS: jobs._JOBS[key]['_unifiedScope'] = self.cache_scope()
            return key
        jobs.create = create
        self._context_pool(jobs._POOL, 'csa')
        models = self.modules.get('csa', 'model_proxy')
        self._context_pool(models.POOL, 'csa')
        models._chat_request = lambda provider, payload, structured_reasoning=False: models._extract_content(
            json.dumps(self._transport('csa', provider, payload), ensure_ascii=False).encode(), structured_reasoning)
        def send(provider, payload):
            run = runtime.current()
            active = ACTIVE.get()
            with running('csa', active.scope if active else run.scope if run else 'manual', run.run_id if run else 'manual'):
                return self._transport('csa', provider, payload)
        native.call_model = send
        if self.gateway.allow_local:
            supported = native.supports_pdf
            native.supports_pdf = lambda p: supported(p) or (p.get('baseUrl', '').startswith('http://127.0.0.1:') and p.get('model') in native.SUPPORTED_MODELS)
        original_chunks = native._page_chunks
        def chunks(document, raw, pages):
            original = list(original_chunks(document, raw, pages))
            ranges = preflight_ranges([(c['start'] + 1, c['end']) for c in original])
            for start, end in ranges:
                yield {'start': start - 1, 'end': end, 'pdf': native._make_pdf_pages(raw, start - 1, end)}
        native._page_chunks = chunks
        from .csa_windows import install
        install(native)
        original_status = jobs.status
        def status(key):
            result = original_status(key)
            if result and result.get('status') == 'interrupted':
                result = {**result, 'status': 'failed', 'phase': '服务已重启，请继续初评'}
            return result
        jobs.status = status

    def _msci(self):
        native = self.modules.get('msci', 'pdf_assessment')
        self._context_pool(native.POOL, 'msci')
        models = self.modules.get('msci', 'model_proxy')
        self._context_pool(models.POOL, 'msci')
        models._send_chat = lambda provider, payload: (200, json.dumps(self._transport('msci', provider, payload), ensure_ascii=False).encode())
        cache = self.modules.get('msci', 'review_cache')
        for name, kind in [('load', 'read'), ('load_results', 'assessment')]:
            setattr(cache, name, lambda key, kind=kind: self.store.get('msci', self.cache_scope(), kind, key, self.contract))
        for name, kind in [('save', 'read'), ('save_results', 'assessment')]:
            setattr(cache, name, lambda key, value, kind=kind: self.store.put('msci', self.cache_scope(), kind, key, self.contract, value))
        class DiskOnly(dict):
            def get(self, key, default=None): return default
            def __setitem__(self, key, value): pass
        native.READ_CACHE = DiskOnly(); native.RESULT_CACHE = DiskOnly()
        original_run, original_call = native._run, native._json_call
        def persist(job):
            self.store.save_job('msci', job['jobId'], job)
        def work(job):
            parent = ACTIVE.get()
            with running('msci', parent.scope if parent else fingerprint(job['project']), job['jobId']):
                job['_unifiedScope'] = self.cache_scope()
                # Upstream memory caches did not include the project boundary.
                # Disk caches now bind it; do not bypass that boundary in RAM.
                with native.LOCK:
                    native.READ_CACHE.clear(); native.RESULT_CACHE.clear()
                persist(job)
                try:
                    return original_run(job)
                finally:
                    persist(job)
        def call(*args, **kwargs):
            job = kwargs.get('job')
            if job: persist(job)
            try:
                return original_call(*args, **kwargs)
            finally:
                if job: persist(job)
        native._run, native._json_call = work, call
        original_start_job = native.start_job
        def start_job(data):
            key = original_start_job(data)
            with native.LOCK:
                native.JOBS[key]['_unifiedScope'] = self.cache_scope()
            return key
        native.start_job = start_job
        self._msci_consolidation(native)
        original_batches = native.context.reading_batches
        native.context.reading_batches = lambda *args, **kwargs: preflight_ranges(original_batches(*args, **kwargs))
        original_status = native.job_status
        def status(key):
            if key not in native.JOBS:
                saved = self.store.job('msci', key)
                if saved: return {**saved, 'phase': 'failed'} if saved.get('status') == 'interrupted' else saved
            return original_status(key)
        native.job_status = status
        prepare = native.prepare_pdf
        def register(raw, name):
            result = prepare(raw, name)
            ref = result['meta']['nativeDocumentId']
            self.store.put_document('msci', 'uploads', raw, name, ref_id=ref)
            return result
        native.prepare_pdf = register
        self._msci_restore_documents(native, prepare)

    def _msci_consolidation(self, native):
        """Keep the original retry merge, adding the missing enterprise boundary."""
        def consolidate(job):
            provider = job['_provider']
            scope = job['_unifiedScope']
            combined = {}
            with native.LOCK:
                for old in native.JOBS.values():
                    previous_provider = old.get('_provider', {})
                    if (old.get('_unifiedScope') == scope
                            and old.get('readingComplete')
                            and old.get('documents') == job['documents']
                            and old.get('project') == job['project']
                            and old.get('_criteria') == job['_criteria']
                            and previous_provider.get('baseUrl') == provider['baseUrl']
                            and previous_provider.get('model') == provider['model']):
                        combined.update((row['criterionId'], row) for row in old['results'])
            grouped = {}
            for criterion in job['_criteria']:
                grouped.setdefault(criterion['issueId'], []).append(criterion)
            for issue, criteria in grouped.items():
                evidence = [entry for entry in job['evidence'] if issue in entry['issueIds']]
                for at in range(0, len(criteria), native.BATCH_CRITERIA):
                    group = criteria[at:at + native.BATCH_CRITERIA]
                    if all(criterion['id'] in combined for criterion in group):
                        rows = [combined[criterion['id']] for criterion in group]
                        key = native._result_key(provider, group, evidence, job['project'])
                        native.review_cache.save_results(key, rows)
        native._consolidate = consolidate

    def _msci_restore_documents(self, native, prepare):
        store = self.store
        class Documents(dict):
            def __init__(self, values):
                super().__init__(values)
                self.loading = set()
            def __missing__(self, key):
                if key in self.loading: raise KeyError(key)
                try:
                    self.loading.add(key)
                    original = store.document('msci', 'uploads', key)
                    prepare(original['bytes'], original['name'])
                    return dict.__getitem__(self, key)
                except (LocalError, KeyError):
                    raise KeyError(key) from None
                finally:
                    self.loading.discard(key)
            def __contains__(self, key):
                if dict.__contains__(self, key): return True
                if key in self.loading: return False
                try: self[key]; return True
                except KeyError: return False
        native.DOCUMENTS = Documents(native.DOCUMENTS)

    def _exchange(self):
        models = self.modules.get('exchange', 'model_proxy')
        gateway = self.gateway
        class Registry:
            def get(self, provider_id=None):
                try: return gateway.get(provider_id)
                except LocalError as exc: raise models.RequestError(str(exc), 'provider', exc.status) from None
            def public(self): return gateway.public()
            def redact(self, value): return self_store.secrets.clean(value)
            def register(self, data): return gateway.connect(data)
            def select(self, provider_id): self.get(provider_id); return self.public()
            @property
            def current_id(self): return gateway.public()['currentProviderId']
        self_store = self.store
        registry = Registry()
        # Imports bind singleton references, so update every exchange module.
        import sys
        prefix = self.modules.prefix + '.exchange.pipeline.'
        for name, module in list(sys.modules.items()):
            if name.startswith(prefix) and hasattr(module, 'PROVIDERS'):
                module.PROVIDERS = registry
        models.PROVIDERS = registry
        for module_name, attribute in [('pdf_assessment', 'REVIEWS'), ('topic_align', 'ALIGNMENTS'), ('benchmark', 'BENCHMARKS')]:
            getattr(self.modules.get('exchange', module_name), attribute).providers = registry
        models.transport = lambda provider, payload: self._transport('exchange', provider, payload)
        cache = self.modules.get('exchange', 'review_cache').CACHE
        cache.get = lambda kind, key: self.store.get('exchange', self.cache_scope(), kind, key, self.contract)
        cache.put = lambda kind, key, value: self.store.put('exchange', self.cache_scope(), kind, key, self.contract, value)
        jobs = self.modules.get('exchange', 'jobs')
        Task = jobs.Task
        for name in ('update', 'result', 'error', 'control'):
            original = getattr(Task, name)
            def changed(task, *args, original=original, **kwargs):
                result = original(task, *args, **kwargs)
                self.store.save_job('exchange', task.data['id'], task.snapshot())
                return result
            setattr(Task, name, changed)
        original_start = Task.start
        def start(task, worker, asynchronous=True):
            parent = ACTIVE.get()
            task._unifiedScope = parent.scope if parent else 'standalone'
            def work(current):
                context = getattr(current, 'context', {})
                scope = parent.scope if parent else fingerprint(context.get('context', context.get('project', {})))
                with running('exchange', scope, current.data['id']):
                    try: return worker(current)
                    finally: self.store.save_job('exchange', current.data['id'], current.snapshot())
            return original_start(task, work, asynchronous)
        Task.start = start
        docs = self.modules.get('exchange', 'pdf_pages').DOCUMENTS
        register, get = docs.register, docs.get
        def save(raw, name, source='main'):
            meta = register(raw, name, source)
            self.store.put_document('exchange', 'uploads', raw, name, ref_id=meta['id'], meta={'source': source})
            return meta
        def restore(key):
            if key not in docs.documents:
                try:
                    original = self.store.document('exchange', 'uploads', key)
                    new = register(original['bytes'], original['name'], original['meta'].get('source', 'main'))
                    item = docs.documents.pop(new['id']); item['meta']['id'] = key
                    docs.documents[key] = item
                    docs.parse(key, asynchronous=False)
                except LocalError:
                    pass
            return get(key)
        docs.register, docs.get = save, restore

    def _shared_windows(self):
        context = self.modules.get('exchange', 'pdf_context')
        def exchange_windows(base, topic, context=context):
            try:
                return evidence_windows(topic['evidence'], lambda entries: context.fits({**base, 'topics': [{**topic, 'evidence': entries}]}))
            except LocalError as exc:
                raise self.modules.get('exchange', 'errors').RequestError(str(exc), 'context_budget') from None
        context.evidence_windows = exchange_windows
        # pdf_assessment imported the function directly.
        self.modules.get('exchange', 'pdf_assessment').evidence_windows = exchange_windows
        self.modules.get('exchange', 'benchmark').evidence_windows = exchange_windows
        context = self.modules.get('msci', 'pdf_context')
        def msci_windows(criteria, entries, project):
            try:
                return evidence_windows(entries, lambda pool: context.group_budget(criteria, pool, project) <= context.INPUT_BUDGET)
            except LocalError as exc:
                raise context.ContextBudgetError(str(exc)) from None
        context.evidence_windows = msci_windows

    def _shared_pdf(self):
        """Every module now uses the same pypdf slicer and density scheduler."""
        from pypdf import PdfReader, PdfWriter
        csa = self.modules.get('csa', 'native_pdf')
        csa._make_pdf_pages = lambda raw, start, end: request_pdf(raw, start + 1, end)
        def chunks(document, raw, pages):
            texts = ['\n'.join(block['text'] for block in csa._anchors(page)) for page in pages]
            for first, last in preflight_ranges(reading_batches(texts)):
                start = first
                while start <= last:
                    end = last
                    data = request_pdf(raw, start, end)
                    while len(data) > csa.MAX_SCAN_PDF_BYTES and end > start:
                        end = start + (end - start) // 2
                        data = request_pdf(raw, start, end)
                    if len(data) > csa.MAX_SCAN_PDF_BYTES:
                        raise csa.RequestError('该单页超过原生PDF请求体积限制；未压缩或截断。')
                    yield {'start': start - 1, 'end': end, 'pdf': data}
                    start = end + 1
        csa._page_chunks = chunks
        msci = self.modules.get('msci', 'pdf_assessment')
        msci.PdfReader, msci.PdfWriter = PdfReader, PdfWriter
        msci.pdf_pages.label_page = label_page
        msci.context.reading_batches = lambda texts, max_pages=12: preflight_ranges(reading_batches(texts, max_pages))
        exchange_pages = self.modules.get('exchange', 'pdf_pages')
        exchange_pages.PdfReader = PdfReader
        exchange_pages.request_pdf = request_pdf
        exchange = self.modules.get('exchange', 'pdf_assessment')
        exchange.request_pdf = request_pdf
        self.modules.get('exchange', 'pdf_context').reading_batches = lambda pages, max_pages=12: reading_batches([p.get('text', '') for p in pages], max_pages)
        exchange.reading_batches = self.modules.get('exchange', 'pdf_context').reading_batches
        self.modules.get('exchange', 'benchmark').reading_batches = self.modules.get('exchange', 'pdf_context').reading_batches
        # Alignment has a separate imported alias and no explicit page-1 probe.
        self.modules.get('exchange', 'topic_align').reading_batches = lambda pages, max_pages=12: preflight_ranges(
            reading_batches([page.get('text', '') for page in pages], max_pages))

    def project_busy(self, scope):
        csa = self.modules.get('csa', 'native_pdf_jobs')
        with csa._LOCK:
            if any(job.get('_unifiedScope') == scope and job['status'] in {'queued', 'running'} for job in csa._JOBS.values()): return True
        msci = self.modules.get('msci', 'pdf_assessment')
        with msci.LOCK:
            if any(job.get('_unifiedScope') == scope and job['phase'] in {'reading', 'evaluating', 'paused'} for job in msci.JOBS.values()): return True
        server = self.modules.servers['exchange']
        for name in ('REVIEWS', 'ALIGNMENTS', 'BENCHMARKS'):
            registry = getattr(server, name).jobs
            with registry.lock:
                tasks = list(registry.tasks.values())
            for task in tasks:
                if getattr(task, '_unifiedScope', None) == scope and (
                        task.snapshot()['status'] in {'pending', 'in_progress', 'paused'} or task.thread and task.thread.is_alive()): return True
        return False

    @staticmethod
    def _context_pool(pool, namespace):
        original = pool.submit
        def submit(function, *args, **kwargs):
            parent = ACTIVE.get()
            context = copy_context()
            def work():
                if parent:
                    with running(namespace, parent.scope, parent.job_id):
                        return function(*args, **kwargs)
                return function(*args, **kwargs)
            return original(context.run, work)
        pool.submit = submit
