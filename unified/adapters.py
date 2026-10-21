"""Compatibility bindings. Standards and judgment validators stay upstream."""
from __future__ import annotations
import functools
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import threading
from contextvars import copy_context

from .core import ACTIVE, LocalError, fingerprint, running
from .pdf_engine import evidence_windows, preflight_ranges, reading_batches, request_pdf, label_page
from . import anchored_reading


class Bindings:
    def __init__(self, modules, store, gateway):
        self.modules, self.store, self.gateway = modules, store, gateway
        root = Path(__file__).parent
        self.contract = fingerprint([(name, hashlib.sha256((root / name).read_bytes()).hexdigest()) for name in
            ('core.py', 'gateway.py', 'loader.py', 'adapters.py', 'pdf_engine.py', 'csa_windows.py', 'csa_quality.py', 'responses.py', 'msci_runner.py', 'msci_windows.py', 'msci_guard.py', 'result_text.py', 'source_layout.py', 'exchange_windows.py', 'anchored_reading.py', 'chat_stream.py', 'upstream.json')])
        # Read keys already include the full module/method/document/project.
        # A transport or batch-size edit must not discard validated pages.
        self.read_contract = fingerprint(['validated-source-pages-v1', anchored_reading.VERSION,
            *[(name, hashlib.sha256((root / name).read_bytes()).hexdigest()) for name in ('pdf_engine.py', 'upstream.json')]])
        self.csa_contract = fingerprint([self.read_contract, hashlib.sha256((root / 'csa_windows.py').read_bytes()).hexdigest()])
        gateway.listeners.append(self.sync_providers)
        self._csa()
        self._msci()
        self._exchange()
        self._shared_windows()
        self._shared_pdf()
        gateway.request_ready = self.request_ready

    def request_ready(self, run):
        """Recheck native controls after waiting for the shared GLM gate."""
        if not run:
            return True
        if run.namespace == 'csa':
            jobs = self.modules.get('csa', 'native_pdf_jobs')
            with jobs._LOCK:
                job = jobs._JOBS.get(run.job_id)
                if job and job.get('stopRequested'):
                    raise jobs.RequestError('已停止后续调用；排队请求未发送，已完成结果保留。')
                return not (job and job.get('paused'))
        if run.namespace == 'msci':
            native = self.modules.get('msci', 'pdf_assessment')
            with native.LOCK:
                job = native.JOBS.get(run.job_id)
                if job and job.get('stop'):
                    raise native.RequestError('已停止后续调用；排队请求未发送，已完成结果保留。')
                return not (job and job.get('pause'))
        if run.namespace == 'exchange':
            server = self.modules.servers['exchange']
            for name in ('REVIEWS', 'ALIGNMENTS', 'BENCHMARKS'):
                registry = getattr(server, name).jobs
                with registry.lock:
                    task = registry.tasks.get(run.job_id)
                if task:
                    with task.condition:
                        if task.data['status'] == 'stopped':
                            task.checkpoint()
                        return task.data['status'] != 'paused'
        return True

    def sync_providers(self, provider):
        for ns in ('csa', 'msci'):
            models = self.modules.get(ns, 'model_proxy')
            with models.PROVIDER_LOCK:
                models.PROVIDERS.clear()
                models.PROVIDERS[provider['id']] = dict(provider)

    def cache_scope(self):
        run = ACTIVE.get()
        return run.scope if run else 'standalone'

    def cache_contract(self, kind='all'):
        run = ACTIVE.get()
        base = self.read_contract if kind == 'read' else self.csa_contract if kind == 'csa' else self.contract
        return fingerprint([base, run.provider_contract if run else ""])

    def _transport(self, ns, provider, payload):
        try:
            return anchored_reading.translate(self.gateway.send(provider, payload, namespace=ns), payload)
        except LocalError as exc:
            if ns == 'msci' and '模型原文编号' in str(exc):
                raise self.modules.get('msci', 'pdf_assessment').PdfFormatError(str(exc)) from None
            error = self.modules.get(ns, 'errors').RequestError
            if ns == 'exchange':
                category = ('network' if '连接中断' in str(exc) else
                            'model_contract' if '模型原文编号' in str(exc) else 'upstream')
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
                return bindings.store.get('csa', scope, 'native', key, bindings.cache_contract('csa'))
            def put(self, namespace, key, value):
                run = runtime.current()
                active = ACTIVE.get()
                scope = active.scope if active else run.scope if run else 'standalone'
                bindings.store.put('csa', scope, 'native', key, bindings.cache_contract('csa'), value)
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
            return fingerprint([self.cache_scope(), provider.get("fingerprint"), original_identity(value, provider)])
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
        quotes = self.modules.get('csa', 'pdf_quotes')
        original_quotes = native.quote_pages
        def quote_pages(raw, sha, filename):
            if quotes.cache_ready(sha):
                return original_quotes(raw, sha, filename)
            # Native PDF reading needs source anchors, not an unconditional
            # second image-OCR/table reconstruction pass over a readable PDF.
            try:
                variants = quotes._text_variants(raw)
            except Exception:
                return original_quotes(raw, sha, filename)
            if variants and all(any(len(native.normalized(b['text'])) >= 16
                    and '\ufffd' not in b['text'] and '(cid:' not in b['text'] for b in page) for page in variants):
                quotes._remember(sha, variants)
                return variants
            return original_quotes(raw, sha, filename)
        native.quote_pages = quote_pages
        original_payload = native._scan_payload
        def scan_payload(provider, document, questions, pages, start, end, pdf_bytes, max_tokens=8192):
            payload = original_payload(provider, document, questions, pages, start, end, pdf_bytes, max_tokens)
            blocks = {}
            for page in range(start, end):
                trusted = [b for b in pages[page] if not b.get('requiresReview')]
                halves = [b for b in trusted if b.get('kind') in {'left', 'right'}]
                blocks[page + 1] = [b['text'] for b in (halves or trusted[:1])]
            with anchored_reading.source_pages(blocks):
                content, system = anchored_reading.prepare(payload['messages'][1]['content'], payload['messages'][0]['content'], 'csa')
            payload['messages'] = [{'role': 'system', 'content': system}, {'role': 'user', 'content': content}]
            return payload
        native._scan_payload = scan_payload
        original_verify = native._verify_scan_evidence
        def verify_evidence(items, document, pages, start, end, question_ids):
            if not isinstance(items, list) or len(items) > 4096:
                raise native.RequestError('页段证据数量超过本机有界处理容量，未接受该批结果。')
            accepted, rejected = {}, {}
            # The old two-excerpts-per-question cap cannot be recovered by
            # splitting questions when one question genuinely needs 3+ excerpts.
            # Validate every item with the unchanged exact-source validator;
            # only the obsolete count cap is bypassed, never source/page checks.
            for item in items:
                rows, misses = original_verify([item], document, pages, start, end, question_ids)
                accepted.update({row['id']: row for row in rows})
                for qid, count in misses.items():
                    rejected[qid] = rejected.get(qid, 0) + count
            return list(accepted.values()), rejected
        native._verify_scan_evidence = verify_evidence
        original_evaluate = native.evaluate
        def evaluate(value, provider, *args, **kwargs):
            parent = ACTIVE.get()
            with running('csa', parent.scope if parent else 'standalone', parent.job_id if parent else 'manual', provider.get('fingerprint', '')):
                return original_evaluate(value, provider, *args, **kwargs)
        native.evaluate = evaluate
        supported = native.supports_pdf
        native.supports_pdf = lambda p: supported(p) or (p.get('service') == 'cpa' and p.get('model') == 'gpt-6-luna') or (self.gateway.allow_local and p.get('baseUrl', '').startswith('http://127.0.0.1:') and p.get('model') in native.SUPPORTED_MODELS)
        from .csa_quality import install as install_quality
        install_quality(native)
        from .source_layout import install_csa
        install_csa(native)
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
        original_native = native.native_provider
        native.native_provider = lambda p: original_native(p) or (p.get('service') == 'cpa' and p.get('model') == 'gpt-6-luna')
        self._context_pool(native.POOL, 'msci')
        models = self.modules.get('msci', 'model_proxy')
        self._context_pool(models.POOL, 'msci')
        models._send_chat = lambda provider, payload: (200, json.dumps(self._transport('msci', provider, payload), ensure_ascii=False).encode())
        cache = self.modules.get('msci', 'review_cache')
        for name, kind in [('load', 'read'), ('load_results', 'assessment')]:
            setattr(cache, name, lambda key, kind=kind: self.store.get('msci', self.cache_scope(), kind, key, self.cache_contract(kind)))
        for name, kind in [('save', 'read'), ('save_results', 'assessment')]:
            setattr(cache, name, lambda key, value, kind=kind: self.store.put('msci', self.cache_scope(), kind, key, self.cache_contract(kind), value))
        class DiskOnly(dict):
            def get(self, key, default=None): return default
            def __setitem__(self, key, value): pass
        native.READ_CACHE = DiskOnly(); native.RESULT_CACHE = DiskOnly()
        original_run, original_call = native._run, native._json_call
        from . import msci_runner
        original_scan = native._scan
        def scan(provider, doc, source, issues, start, end, job):
            reader = job.get('_reader')
            with anchored_reading.source_pages({p: [doc['texts'][p - 1]] for p in range(start, end + 1)}):
                rows = reader.scan(original_scan, provider, doc, source, issues, start, end, job) if reader else original_scan(provider, doc, source, issues, start, end, job)
            for row in rows:
                local = doc['texts'][row['pdfPage'] - 1]
                if local.strip() and not anchored_reading.contains_source_quote(local, row['text']):
                    raise native.PdfFormatError('MSCI摘录未在所标物理页连续核对到；未接受该批证据。')
                row['verification'] = 'source_text_checked' if local.strip() else 'model_pdf'
                row['requiresReview'] = not bool(local.strip())
            return rows
        native._scan = scan
        def persist(job):
            with native.LOCK: self.store.save_job('msci', job['jobId'], job)
        def work(job):
            parent = ACTIVE.get()
            with running('msci', parent.scope if parent else fingerprint(job['project']), job['jobId'], job['_provider'].get('fingerprint', '')):
                job['_unifiedScope'] = self.cache_scope()
                # Upstream memory caches did not include the project boundary.
                # Disk caches now bind it; do not bypass that boundary in RAM.
                with native.LOCK:
                    native.READ_CACHE.clear(); native.RESULT_CACHE.clear()
                persist(job)
                try:
                    if job['_provider'].get('service') == 'cpa':
                        return msci_runner.run(native, self, job, persist)
                    return original_run(job)
                finally:
                    persist(job)
        def call(*args, **kwargs):
            args, kwargs = msci_runner.reading_arguments(args, kwargs)
            content = args[1] if len(args) > 1 else kwargs.get('content')
            if isinstance(content, list) and any(p.get('type') == 'file' for p in content):
                system = args[2] if len(args) > 2 else kwargs.get('system', '')
                content, system = anchored_reading.prepare(content, system, 'msci')
                if len(args) > 2: args = (*args[:1], content, system, *args[3:])
                elif len(args) > 1: args, kwargs = (*args[:1], content), {**kwargs, 'system': system}
                else: kwargs = {**kwargs, 'content': content, 'system': system}
            job = kwargs.get('job')
            if job:
                result = msci_runner.call(native, original_call, persist, *args, **kwargs)
            else:
                result = original_call(*args, **kwargs)
            if isinstance(content, str):
                from .result_text import normalize
                try:
                    return normalize(result[0], content), result[1]
                except ValueError as exc:
                    raise native.PdfFormatError(str(exc)) from None
            return result
        native._run, native._json_call = work, call
        original_start_job = native.start_job
        def start_job(data):
            key = original_start_job(data)
            with native.LOCK:
                native.JOBS[key]['_unifiedScope'] = self.cache_scope()
            return key
        native.start_job = start_job
        self._msci_consolidation(native)
        from .msci_windows import install
        install(native)
        from .msci_guard import install as install_guard
        install_guard(native)
        from .source_layout import install as install_layout
        install_layout(native)
        original_batches = native.context.reading_batches
        native.context.reading_batches = lambda *args, **kwargs: preflight_ranges(original_batches(*args, **kwargs))
        original_status = native.job_status
        def status(key):
            if key not in native.JOBS:
                saved = self.store.job('msci', key)
                if saved: return {**saved, 'phase': 'failed'} if saved.get('status') == 'interrupted' else saved
            with native.LOCK:
                return deepcopy(original_status(key))
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
                            and previous_provider.get('model') == provider['model']
                            and previous_provider.get('fingerprint') == provider.get('fingerprint')):
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
        cache.get = lambda kind, key: self.store.get('exchange', self.cache_scope(), kind, key, self.cache_contract(kind))
        cache.put = lambda kind, key, value: self.store.put('exchange', self.cache_scope(), kind, key, self.cache_contract(kind), value)
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
                with running('exchange', scope, current.data['id'], context.get('provider', {}).get('fingerprint', '')):
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
        exchange = self.modules.get('exchange', 'pdf_assessment')
        original_rows = exchange.assessment_rows
        def clean_prose(value, evidence):
            if not isinstance(value, dict) or not isinstance(value.get('assessments'), list):
                return value
            allowed = {e['id'] for e in evidence}
            result = deepcopy(value)
            import re
            for row in result['assessments']:
                if not isinstance(row, dict) or not isinstance(row.get('evidenceIds'), list):
                    continue
                selected = {ref for ref in row['evidenceIds'] if isinstance(ref, str) and ref in allowed}
                def strip_refs(match):
                    content = re.sub(r'\b(?:id|evidence(?:_?ids?)?)\s*[:：]\s*', '', match.group(1), flags=re.I)
                    refs = re.split(r'[、,，;；/\s]+', content.strip())
                    return '' if refs and all(ref in selected for ref in refs) else match.group(0)
                for field in ('disclosedContent','gap','suggestion'):
                    if isinstance(row.get(field), str):
                        row[field] = re.sub(r'[（(]([^（）()]*)[）)]', strip_refs, row[field])
            return result
        exchange.clean_assessment_prose = clean_prose
        def checked_rows(value, *args, **kwargs):
            # Keep the original validator; give bounded retries the actual
            # failing field instead of the legacy generic contract error.
            evidence = args[1] if len(args)>1 else kwargs.get('evidence', [])
            value = clean_prose(value, evidence)
            for row in value.get('assessments', []) if isinstance(value, dict) and isinstance(value.get('assessments'), list) else []:
                if not isinstance(row, dict):
                    continue
                refs = row.get('evidenceIds')
                if isinstance(refs, list) and len(refs) > exchange.MAX_REFERENCES:
                    raise exchange.contract(f"议题{row.get('topicId', '')}返回了{len(refs)}条引用，最多{exchange.MAX_REFERENCES}条；请合并重复依据并选取直接支持本项的引用，不得省略矛盾材料。")
                for field in ('disclosedContent', 'gap', 'suggestion'):
                    text = row.get(field)
                    limit = exchange.ASSESSMENT_LIMITS['textCharsPerField']
                    if isinstance(text, str) and len(text) > limit:
                        raise exchange.contract(f"议题{row.get('topicId', '')}的{field}为{len(text)}字，上限{limit}字；请简明重写该字段，保留年度、边界和必要条件。")
            return original_rows(value, *args, **kwargs)
        exchange.assessment_rows = checked_rows
        from .exchange_windows import install as install_exchange_windows
        install_exchange_windows(exchange)
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
            for first, last in preflight_ranges(reading_batches(texts, 1, budget=6000)):
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
        msci.context.reading_batches = lambda texts, max_pages=12: preflight_ranges(reading_batches(texts, min(max_pages, 2), budget=6000))
        exchange_pages = self.modules.get('exchange', 'pdf_pages')
        exchange_pages.PdfReader = PdfReader
        exchange_pages.request_pdf = request_pdf
        exchange = self.modules.get('exchange', 'pdf_assessment')
        original_ask = exchange.Reader.ask
        original_range = exchange.Reader.native_range
        def native_range(reader, doc, start, end):
            pages = {p['page']: [p.get('text', '')] for p in doc.get('pages', []) if start <= p['page'] <= end}
            with anchored_reading.source_pages(pages if len(pages) == end - start + 1 else {}):
                return original_range(reader, doc, start, end)
        exchange.Reader.native_range = native_range
        def ask(reader, content, system='', max_tokens=8192):
            if isinstance(content, list) and any(p.get('type') == 'file' for p in content):
                system += '\n必须实际打开并检查所附PDF，再返回本次检查结果。输入JSON的output仅为格式说明，不是现成结果；不得原样回传输入的task、physicalPages、topics、instruction、output、limits。结果根对象直接包含complete、reviewed_pages、incomplete_reason、evidence，不使用output/data/result包装。封面只有公司名、标题和年度且无议题披露时，返回已检查页号、complete:true和evidence:[]；有相关原文时必须按输入议题编号逐字提取，不得复制格式示例作为证据。'
                content, system = anchored_reading.prepare(content, system, 'exchange')
            return original_ask(reader, content, system=system, max_tokens=max_tokens)
        exchange.Reader.ask = ask
        exchange.request_pdf = request_pdf
        self.modules.get('exchange', 'pdf_context').reading_batches = lambda pages, max_pages=12: reading_batches([p.get('text', '') for p in pages], min(max_pages, 2), budget=6000)
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
