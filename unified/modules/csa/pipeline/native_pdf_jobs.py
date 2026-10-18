"""Bounded asynchronous jobs for GLM's long-running page-by-page PDF reads."""
from concurrent.futures import ThreadPoolExecutor
import secrets
import sqlite3
import threading
import time

if __package__:
    from . import native_pdf
    from .errors import RequestError
    from .workbench_runtime import Store, fingerprint
else:
    import native_pdf
    from errors import RequestError
    from workbench_runtime import Store, fingerprint

_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix='glm-pdf-reading')
_JOBS = {}
_LOCK = threading.RLock()
_CONTROL = threading.Condition(_LOCK)
_TTL = 900


def _persist(job_id, job, required=True):
    try:
        Store().save_job(job_id, job)
    except (OSError, sqlite3.Error, RuntimeError):
        if required:
            raise RequestError('本机断点保存失败，请检查磁盘空间和缓存目录权限；已停止后续调用。') from None


def _expire():
    now = time.monotonic()
    for job_id, job in list(_JOBS.items()):
        if job['status'] in {'completed', 'failed', 'stopped'} and now - job['updated'] > _TTL:
            del _JOBS[job_id]


def _identity(value, provider):
    project = value.get('project')
    if not isinstance(project, dict):
        raise RequestError('项目背景缺失。')
    methods = native_pdf.read_questions(value.get('questionIds'), project)
    items = native_pdf._document_items(value.get('documents'))
    docs = [{k: d.get(k) for k in ('id', 'name', 'sha256', 'pageCount', 'public',
             'sourceUrl', 'documentType', 'documentPeriod')} for d in items]
    return fingerprint([provider.get('baseUrl'), provider.get('model'), value.get('project'),
                        [native_pdf._assessment_method_record(q) for q in methods],
                        native_pdf._source_contract(), docs, value.get('cacheMode', 'normal')])


def create(value: dict, provider: dict) -> str:
    identity = _identity(value, provider)
    with _LOCK:
        _expire()
        for active_id, active in _JOBS.items():
            if active['status'] in {'queued', 'running'} and active.get('requestIdentity') == identity:
                return active_id
        if any(job['status'] in {'queued', 'running'} for job in _JOBS.values()):
            raise RequestError('已有 GLM PDF 读取任务正在运行，请完成后再开始下一项。')
        if len(_JOBS) >= 3:
            oldest = min(_JOBS, key=lambda key: _JOBS[key]['updated'])
            del _JOBS[oldest]
        job_id = secrets.token_urlsafe(24)
        _JOBS[job_id] = {'status': 'queued', 'phase': '等待 GLM PDF 读取', 'completed': 0,
                         'total': 0, 'detail': '', 'result': None, 'error': '',
                         'paused': False, 'stopRequested': False,
                         'request': value, 'provider': provider, 'requestIdentity': identity, 'updated': time.monotonic()}
        value['_runId'] = job_id
        _JOBS[job_id]['runId'] = job_id
        _JOBS[job_id]['usage'] = {}
        try:
            _persist(job_id, _JOBS[job_id])
        except RequestError:
            del _JOBS[job_id]
            raise
        _POOL.submit(_run, job_id)
    return job_id


def _run(job_id: str):
    with _LOCK:
        job = _JOBS.get(job_id)
        if not job or job['status'] != 'queued':
            return
        job['status'] = 'running'
        value, provider = job['request'], job['provider']
        job['updated'] = time.monotonic()

    def progress(state):
        with _LOCK:
            current = _JOBS.get(job_id)
            if current:
                current.update(state)
                current['updated'] = time.monotonic()
                _persist(job_id, current)

    try:
        _persist(job_id, job)
        result = native_pdf.evaluate(value, provider, progress=progress, before_request=lambda: _boundary(job_id))
        with _LOCK:
            current = _JOBS.get(job_id)
            if current:
                current.update(status='completed', phase='初评完成', result=result,
                               request=None, provider=None, updated=time.monotonic())
                _persist(job_id, current)
    except RequestError as error:
        message = str(error)
        with _LOCK:
            current = _JOBS.get(job_id)
            if current:
                current.update(status='stopped' if current.get('stopRequested') else 'failed',
                               phase='已停止' if current.get('stopRequested') else '读取失败', error=message,
                               request=None, provider=None, updated=time.monotonic())
                _persist(job_id, current, required=False)
    except Exception:
        with _LOCK:
            current = _JOBS.get(job_id)
            if current:
                current.update(status='failed', phase='读取失败',
                               error='GLM PDF 处理失败；没有写入未核验的初评。请检查文件后重试。',
                               request=None, provider=None, updated=time.monotonic())
                _persist(job_id, current, required=False)


def status(job_id: str):
    with _LOCK:
        _expire()
        job = _JOBS.get(job_id)
        if not job:
            return Store().job(job_id)
        return {key: job.get(key) for key in ('status', 'phase', 'completed', 'total', 'detail', 'result', 'error', 'usage', 'runId', 'paused')}


def clear_cache():
    with _LOCK:
        if any(j['status'] in {'queued', 'running'} for j in _JOBS.values()):
            raise RequestError('任务进行中，请完成后再清理缓存。')
        Store().clear('csa')



def control(job_id, action):
    if action not in {'pause', 'resume', 'stop'}:
        raise RequestError('任务控制指令无效。')
    with _CONTROL:
        job = _JOBS.get(job_id)
        if not job or job['status'] not in {'queued', 'running'}:
            raise RequestError('任务已结束或不在本服务中运行；可通过继续初评恢复断点。')
        if action == 'stop':
            job['stopRequested'] = True
            job['paused'] = False
        else:
            job['paused'] = action == 'pause'
        _persist(job_id, job)
        _CONTROL.notify_all()


def _boundary(job_id):
    with _CONTROL:
        while True:
            job = _JOBS.get(job_id)
            if not job or job.get('stopRequested'):
                raise RequestError('已停止后续调用，已完成题目和页段保存在本机，可继续初评。')
            if not job.get('paused'):
                return
            _CONTROL.wait(timeout=0.5)


def shutdown():
    with _CONTROL:
        for job_id, job in _JOBS.items():
            if job['status'] in {'queued', 'running'}:
                job.update(stopRequested=True, paused=False)
                if job['status'] == 'queued':
                    job.update(status='stopped', phase='已停止', request=None, provider=None)
                _persist(job_id, job, required=False)
        _CONTROL.notify_all()
    _POOL.shutdown(wait=False, cancel_futures=True)
