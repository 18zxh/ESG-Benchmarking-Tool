"""Bounded CPA reading, validated page checkpoints and observable native jobs.

The upstream reader and assessment validators remain authoritative. Only the
schedule changes: all covers first, then at most two small reads in flight.
"""
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from contextvars import copy_context
import hashlib
import json
from pathlib import Path
import re
import threading
import time

from .core import fingerprint
from .pdf_engine import reading_batches
from .anchored_reading import contains_source_quote, VERSION as QUOTE_VERSION

READ_WORKERS = 2
READ_PAGES = 3
# Exact U19 adapter contract; only its validated MSCI read artifacts are eligible.
U19_CONTRACT = '23974ba5f43ebc63fcc6b7b96795c34e9c62c65ebea3d8fdb17197c3c5a00479'


def reading_arguments(args, kwargs):
    """Clarify empty evidence and required fields; keep validators unchanged."""
    content = args[1] if len(args) > 1 else kwargs.get('content')
    system = args[2] if len(args) > 2 else kwargs.get('system', '')
    if isinstance(content, list) and any(p.get('type') == 'file' for p in content):
        system += '\n证据必须与导引issues中的至少一个议题直接相关。issue_ids必须使用issues的键，且不得为空；不相关内容不要放入evidence。封面的公司名称、报告标题、年度，以及系统加注的Source PDF physical page均不构成议题披露证据。已检查且无相关原文的页面仍须完整列入reviewed_pages并确认complete:true，此时返回evidence:[]；不得生成issue_ids:[]的占位证据，也不得为填满数组而强行归类。'
    elif isinstance(content, str):
        system += '\n每条results记录必须完整包含id、status、disclosure、missing、recommendation、evidence_ids、score、reason。除evidence_ids为字符串数组外，其余字段全部为字符串。特别是score键不得省略；无适用数值标尺时也必须显式返回"score":""，不能返回null或编造分数。status只能使用full、partial、not_found、conflicting、not_applicable之一；not_found的evidence_ids必须为[]。'
        system += '\n若window_reviews含criterion_id，该字段对应本次criteria中的C编号，只能用于对应指标；同一指标的全部窗口结论均须综合核对，不能用另一指标的子结论替代，不得投票或省略反向证据。'
        system += '\n所有说明文字使用中文，不把not_found等枚举当作披露内容；不要在说明文字中写临时E证据编号或自行写报告页码，来源只在evidence_ids填写。'
        system += '\nnot_found表示本指标没有直接支持材料，evidence_ids必须为空数组；相关背景不能当作该指标的直接证据。确实满足部分要求时才用partial并引用对应原文；不得为保留引用而改写判断。'
        system += '\n披露总结只能写直接引用中可核对的公司数字，保留原年度、单位和精度；不作换算或由人数推算比例。跨年度或跨栏表格无法明确配对时请说明待核验，不猜测列关系。'
        system += '\n数字不是必填项；直接引用没有该数字时，请用有依据的定性陈述，不从其他上下文抄入。原文以中文数词披露时保留中文数词。numeric_scale_available=false时，各说明字段也不能要求公司补充0–10分、官方评级或该项数值评分，只对照输入方法的披露要求。'
        system += '\nsource_page_text是同一原PDF页按文字流重取的完整上下文，用于避免跨栏混读；必须区分女性董事、女性独立董事、风险管理专家等角色，不能把另一个角色的数量或占比改写为本角色。正文和表格冲突或年度列不明时明确列入待核验。引用仍只能用evidence_ids，并选择能直接支持所写数字的摘录。'
        if '当前只评一个证据窗口' in system:
            system += '\n窗口子结论采用纯定性描述，不在disclosure、missing、recommendation、reason中重复数字、年度、人数、比例或金额。全部数字与单位仍完整保留在原文evidence中，最终综合时再核对；不得从相邻页背景抄入数字。'
        job = kwargs.get('job')
        if job and job.get('_numericCorrections'):
            system += '\n本次必须修复的事实依据问题：' + json.dumps(job['_numericCorrections'], ensure_ascii=False)
            system += '\n本次disclosure只用有直接依据的定性陈述，不输出任何数字或年度；相应数字完整保留在所附原文中。没有直接支持材料则明确未找到，不夹带背景事实。不要求公司提供官方评分。'
    else: return args, kwargs
    if len(args) > 2: args = (*args[:2], system, *args[3:])
    else: kwargs = {**kwargs, 'system': system}
    return args, kwargs


def read_key(native, provider, doc, source, issues, start, end):
    return hashlib.sha256(json.dumps([native.VERSION, doc['name'], hashlib.sha256(doc['bytes']).hexdigest(), source,
        provider['baseUrl'], provider['model'], issues, start, end], sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def valid_entries(value, doc, source, issues, start, end):
    return isinstance(value, list) and all(isinstance(e, dict) and isinstance(e.get('id'), str) and e['id']
        and isinstance(e.get('text'), str) and 1 <= len(e['text']) <= 1200 and e.get('source') == source
        and e.get('filename') == doc['name'] and type(e.get('pdfPage')) is int and start <= e['pdfPage'] <= end
        and isinstance(e.get('issueIds'), list) and e['issueIds'] and all(i in issues for i in e['issueIds']) for e in value)


class Reading:
    def __init__(self, native, bindings, job, persist):
        self.native, self.bindings, self.job, self.persist = native, bindings, job, persist
        self.provider = job['_provider']
        self.issues = {c['issueId']: c['criterion']['issue'] for c in job['_criteria']}
        self.pages, self.entries = set(), {}
        self.abort = job['_readAbort'] = threading.Event()
        self.contract = fingerprint(['msci-page-checkpoint-v2', QUOTE_VERSION, hashlib.sha256(Path(native.__file__).read_bytes()).hexdigest(),
            self.provider['baseUrl'], self.provider['model'], self.provider.get('readingEffort', 'low')])

    def key(self, doc, source, page):
        return fingerprint([hashlib.sha256(doc['bytes']).hexdigest(), doc['name'], source, self.issues, page])

    def load(self, doc, source, page):
        value = self.bindings.store.get('msci', self.job['_unifiedScope'], 'read-page', self.key(doc, source, page), self.contract)
        if isinstance(value, dict) and value.get('complete') is True and value.get('page') == page and valid_entries(value.get('evidence'), doc, source, self.issues, page, page) and all(
                contains_source_quote(doc['texts'][page - 1], e['text']) for e in value['evidence']):
            return self.native.pdf_pages.align_evidence(value['evidence'], doc['texts'], page, page)
        return None

    def record(self, doc, source, start, end, entries, *, cached=False):
        with self.native.LOCK:
            fresh = {(source, hashlib.sha256(doc['bytes']).hexdigest(), page) for page in range(start, end + 1)} - self.pages
            self.pages.update(fresh)
            for e in entries:
                self.entries[(e['source'], e['filename'], e['pdfPage'], e['text'], tuple(e['issueIds']))] = e
            self.job['processedPages'] = len(self.pages)
            self.job['evidence'] = sorted(self.entries.values(), key=lambda e: (e['source'], e['filename'], e['pdfPage'], e['id']))
            if cached: self.job['cachedPages'] = self.job.get('cachedPages', 0) + len(fresh)
            # Lock spans serialization so concurrently completed reads cannot regress the saved snapshot.
            for page in range(start, end + 1):
                self.bindings.store.put('msci', self.job['_unifiedScope'], 'read-page', self.key(doc, source, page), self.contract,
                    {'complete': True, 'page': page, 'evidence': [e for e in entries if e['pdfPage'] == page]})
            self.persist(self.job)

    def restore_u19(self, doc, source):
        legacy_provider = fingerprint([self.provider['baseUrl'], self.provider['model'], 'native', 'cpa', 'max', 'responses-v1'])
        contract = fingerprint([U19_CONTRACT, legacy_provider])
        from .pdf_engine import preflight_ranges
        for start, end in preflight_ranges(reading_batches(doc['texts'])):
            value = self.bindings.store.get('msci', self.job['_unifiedScope'], 'read',
                read_key(self.native, self.provider, doc, source, self.issues, start, end), contract)
            if valid_entries(value, doc, source, self.issues, start, end) and all(
                    contains_source_quote(doc['texts'][e['pdfPage'] - 1], e['text']) for e in value):
                entries = self.native.pdf_pages.align_evidence(value, doc['texts'], start, end)
                self.record(doc, source, start, end, entries, cached=True)

    def scan(self, original, provider, doc, source, issues, start, end, job):
        if self.abort.is_set() or not self.native._wait(job):
            raise self.native.RequestError(job.get('_readFailure') or '读取已停止，已完成页面保留。')
        pages = [self.load(doc, source, p) for p in range(start, end + 1)]
        if all(value is not None for value in pages):
            entries = [e for value in pages for e in value]
            self.record(doc, source, start, end, entries, cached=True)
            return entries
        # Resume only missing consecutive pages, including checkpoints from a
        # differently sized batch; never resend a previously validated page.
        if any(value is not None for value in pages):
            entries, at = [], start
            while at <= end:
                value = pages[at - start]
                if value is not None:
                    self.record(doc, source, at, at, value, cached=True); entries.extend(value); at += 1
                    continue
                last = at
                while last < end and pages[last + 1 - start] is None: last += 1
                entries.extend(self.native._scan(provider, doc, source, issues, at, last, job)); at = last + 1
            return entries
        try:
            entries = original(provider, doc, source, issues, start, end, job)
            self.record(doc, source, start, end, entries)
            return entries
        except Exception as exc:
            job.setdefault('_readFailure', str(exc))
            self.abort.set()
            raise

    def read(self):
        docs = [(self.native.DOCUMENTS[e['id']], e['source']) for e in self.job['documents']]
        for doc, source in docs: self.restore_u19(doc, source)
        # Every document's cover must pass before any further page is sent.
        for doc, source in docs:
            self.native._scan(self.provider, doc, source, self.issues, 1, 1, self.job)
        tasks = iter((doc, source, start + 1, end + 1) for doc, source in docs
            for start, end in reading_batches(doc['texts'][1:], READ_PAGES, budget=6000))
        with ThreadPoolExecutor(max_workers=READ_WORKERS, thread_name_prefix='cpa-read') as pool:
            pending, exhausted = set(), False
            while pending or not exhausted:
                while len(pending) < READ_WORKERS and not exhausted and not self.abort.is_set():
                    if not self.native._wait(self.job): self.abort.set(); break
                    try: doc, source, start, end = next(tasks)
                    except StopIteration: exhausted = True; break
                    self.job['phase'] = 'reading'
                    pending.add(pool.submit(copy_context().run, self.native._scan,
                        self.provider, doc, source, self.issues, start, end, self.job))
                if not pending: break
                done, pending = wait(pending, return_when=FIRST_COMPLETED)
                error = None
                for future in done:
                    try: future.result()
                    except Exception as exc: self.abort.set(); error = error or exc
                if error:
                    # Drain already sent work so its usage and valid checkpoints
                    # are retained; submit no new work after the first failure.
                    for future in pending:
                        try: future.result()
                        except Exception: pass
                    raise error
        if self.job.get('stop'): return False
        if len(self.pages) != self.job['totalPages']:
            raise self.native.RequestError('原文尚未完整读取，未生成全文评估结论。')
        return True


def run(native, bindings, job, persist):
    job['readPolicy'] = {'maxPages': READ_PAGES, 'maxConcurrent': READ_WORKERS,
        'readingEffort': job['_provider'].get('readingEffort', 'low'), 'assessmentEffort': job['_provider']['reasoningEffort']}
    reader = job['_reader'] = Reading(native, bindings, job, persist)
    try:
        if not reader.read(): job['phase'] = 'stopped'; return
        job['readingComplete'] = True
        grouped = {}
        for c in job['_criteria']:
            if not job.get('_retryIds') or c['id'] in job['_retryIds']: grouped.setdefault(c['issueId'], []).append(c)
        for issue, items in grouped.items():
            evidence = [e for e in job['evidence'] if issue in e['issueIds']]
            for at in range(0, len(items), native.BATCH_CRITERIA):
                if not native._wait(job): job['phase'] = 'stopped'; return
                group = items[at:at + native.BATCH_CRITERIA]
                job['phase'] = 'evaluating'
                try:
                    rows = native._group_assess(job['_provider'], group, evidence, job['project'], job)
                    with native.LOCK: job['results'].extend(rows); job['completed'] += len(rows)
                except Exception as exc:
                    with native.LOCK:
                        recorded = {e['criterionId'] for e in job['errors']}
                        job['errors'].extend({'criterionId': c['id'], 'error': str(exc)} for c in group if c['id'] not in recorded)
                persist(job)
        native._consolidate(job)
        job['phase'] = 'stopped' if job.get('stop') else 'completed'
    except Exception as exc:
        job['phase'] = 'stopped' if job.get('stop') else 'failed'
        if not job.get('stop'): job['error'] = str(exc) or 'PDF全文读取失败。'
    finally:
        job['updated'] = time.monotonic()
        persist(job)


def call(native, original, persist, *args, **kwargs):
    job = kwargs.get('job')
    if not job: return original(*args, **kwargs)
    content = args[1] if len(args) > 1 else kwargs.get('content')
    reading = isinstance(content, list) and any(p.get('type') == 'file' for p in content)
    if reading and job.get('_transportFailure'):
        raise native.RequestError(job['_transportFailure'])
    if job.get('_reader'):
        if not native._wait(job) or (reading and job['_readAbort'].is_set()):
            raise native.RequestError(job.get('_readFailure') or '读取已停止，已完成页面保留。')
    start = time.time(); request_id = str(time.monotonic_ns())
    label = ''
    if reading:
        name = next(p.get('file', {}).get('filename', '') for p in content if p.get('type') == 'file')
        match = re.fullmatch(r'pages-(\d+)-(\d+)\.pdf', name)
        if match: label = f'第{match[1]}–{match[2]}页'
    with native.LOCK:
        activity = job.setdefault('activity', {'requests': [], 'finished': 0})
        activity['requests'].append({'id': request_id, 'phase': 'reading' if reading else 'assessment', 'label': label, 'startedAt': start})
        persist(job)
    try:
        return original(*args, **kwargs)
    except Exception as exc:
        # The upstream reader retries output-format errors, but a transport
        # failure must not silently send the same expensive PDF again.
        if reading and not isinstance(exc, native.PdfFormatError):
            job.setdefault('_transportFailure', str(exc))
            if job.get('_reader'):
                job.setdefault('_readFailure', str(exc))
                job['_readAbort'].set()
        raise
    finally:
        with native.LOCK:
            activity['requests'] = [r for r in activity['requests'] if r['id'] != request_id]
            activity['finished'] += 1
            activity['lastResponseAt'] = time.time()
            activity['lastDurationSeconds'] = round(time.time() - start, 1)
            persist(job)
