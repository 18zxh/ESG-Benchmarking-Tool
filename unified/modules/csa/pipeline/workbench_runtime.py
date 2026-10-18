"""Local, rating-neutral storage for verified artifacts, checkpoints and API usage.

No provider credentials, request bodies or original files belong in this store.
Each operation has its own SQLite connection, suitable for the HTTP/worker threads.
"""
from __future__ import annotations

from contextvars import ContextVar
from contextlib import contextmanager
from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import uuid


def packed(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def fingerprint(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def cache_enabled() -> bool:
    return os.environ.get('WORKBENCH_CACHE_ENABLED', os.environ.get('CSA_PDF_CACHE', '1')) != '0'


def compact_enabled() -> bool:
    return os.environ.get('WORKBENCH_COMPACT_ENABLED', os.environ.get('CSA_PDF_COMPACT', '0')) != '0'


class Store:
    SCHEMA = 1

    def __init__(self, path=None):
        default = Path.home() / 'Library/Application Support/CSA-评级工作台/pipeline-cache.sqlite3'
        self.path = Path(path or os.environ.get('WORKBENCH_CACHE_PATH') or default).expanduser()
        self.max_bytes = max(1024 * 1024, int(os.environ.get('WORKBENCH_CACHE_MB', '256')) * 1024 * 1024)
        self.ttl = max(1, int(os.environ.get('WORKBENCH_CACHE_DAYS', '30'))) * 86400
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.connect() as db:
            version = db.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0, self.SCHEMA):
                raise RuntimeError('缓存数据库版本不兼容，请指定新的缓存目录。')
            db.execute('CREATE TABLE IF NOT EXISTS artifacts '
                       '(namespace TEXT, key TEXT, value TEXT, bytes INTEGER, updated REAL, '
                       'PRIMARY KEY(namespace,key))')
            db.execute('CREATE TABLE IF NOT EXISTS jobs '
                       '(id TEXT PRIMARY KEY, owner INTEGER, value TEXT, updated REAL)')
            db.execute('CREATE TABLE IF NOT EXISTS usage '
                       '(id TEXT PRIMARY KEY, run_id TEXT, value TEXT, updated REAL)')
            db.execute(f'PRAGMA user_version={self.SCHEMA}')
        os.chmod(self.path, 0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(str(self.path), timeout=20)
        try:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('PRAGMA busy_timeout=20000')
            with db:
                yield db
        finally:
            db.close()

    def get(self, namespace, key):
        with self.connect() as db:
            row = db.execute('SELECT value,updated FROM artifacts WHERE namespace=? AND key=?',
                             (namespace, key)).fetchone()
        if not row or row[1] < time.time() - self.ttl:
            return None
        try:
            return json.loads(row[0])
        except (ValueError, TypeError):
            return None

    def put(self, namespace, key, value):
        body = packed(value)
        size = len(body.encode())
        if size > self.max_bytes:
            return
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO artifacts VALUES (?,?,?,?,?)',
                       (namespace, key, body, size, time.time()))
            db.execute('DELETE FROM artifacts WHERE updated < ?', (time.time() - self.ttl,))
            total = db.execute('SELECT COALESCE(SUM(bytes),0) FROM artifacts').fetchone()[0]
            while total > self.max_bytes:
                row = db.execute('SELECT namespace,key,bytes FROM artifacts ORDER BY updated LIMIT 1').fetchone()
                db.execute('DELETE FROM artifacts WHERE namespace=? AND key=?', row[:2])
                total -= row[2]

    def clear(self, namespace='csa'):
        with self.connect() as db:
            db.execute('DELETE FROM artifacts WHERE namespace=?', (namespace,))
        # Reclaim free pages without removing jobs, usage or browser-saved projects.
        with self.connect() as db:
            db.execute('PRAGMA incremental_vacuum')

    def save_job(self, job_id, value):
        allowed = ('status', 'phase', 'completed', 'total', 'detail', 'result', 'error', 'usage', 'runId', 'paused', 'stopRequested')
        safe = {key: value[key] for key in allowed if key in value}
        safe.setdefault('usage', {})
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO jobs VALUES (?,?,?,?)',
                       (job_id, os.getpid(), packed(safe), time.time()))
            db.execute('DELETE FROM jobs WHERE updated < ?', (time.time() - self.ttl,))

    def job(self, job_id):
        with self.connect() as db:
            row = db.execute('SELECT owner,value FROM jobs WHERE id=? AND updated>=?',
                             (job_id, time.time() - self.ttl)).fetchone()
        if not row:
            return None
        value = json.loads(row[1])
        if value.get('status') in {'queued', 'running'}:
            try:
                os.kill(row[0], 0)
            except ProcessLookupError:
                value.update(status='interrupted', phase='任务中断',
                             error='服务已重启；请重新连接 GLM 并关联原 PDF，继续生成初评会复用已完成部分。')
                self.save_job(job_id, value)
        return value

    def record_usage(self, run_id, value):
        with self.connect() as db:
            db.execute('INSERT INTO usage VALUES (?,?,?,?)',
                       (uuid.uuid4().hex, run_id, packed(value), time.time()))
            db.execute('DELETE FROM usage WHERE updated < ?', (time.time() - self.ttl,))


@dataclass
class Run:
    store: Store
    run_id: str
    scope: str
    contract: str
    mode: str = 'normal'
    namespace: str = 'csa'
    usage: dict = field(default_factory=dict)
    stages: dict = field(default_factory=dict)
    calls: int = 0
    failed_calls: int = 0
    progress: object = None
    before_request: object = None

    def get(self, key, result=False):
        if (not cache_enabled() or self.mode in {'off', 'refresh-all'}
                or (result and self.mode == 'refresh-results')):
            return None
        return self.store.get(self.namespace, key)

    def put(self, key, value):
        if cache_enabled() and self.mode != 'off':
            self.store.put(self.namespace, key, value)

    def record(self, phase, usage=None, error=False, model=None, host=None):
        self.calls += 1
        self.failed_calls += int(error)
        current = usage if isinstance(usage, dict) else {}
        accepted = {k: int(current[k]) for k in ('prompt_tokens', 'completion_tokens', 'total_tokens')
                    if isinstance(current.get(k), (int, float)) and not isinstance(current[k], bool)
                    and current[k] >= 0}
        for source, source_key, key in [('prompt_tokens_details', 'cached_tokens', 'cached_prompt_tokens'),
                                         ('completion_tokens_details', 'reasoning_tokens', 'reasoning_tokens')]:
            detail = current.get(source)
            value = detail.get(source_key) if isinstance(detail, dict) else None
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                accepted[key] = value
        target = self.stages.setdefault(phase, {'calls': 0, 'failedCalls': 0})
        target['calls'] += 1
        target['failedCalls'] += int(error)
        for key, val in accepted.items():
            target[key] = target.get(key, 0) + val
        self.store.record_usage(self.run_id, {'phase': phase, 'status': 'failed' if error else 'responded',
                                            'usage': accepted, 'usageKnown': bool(accepted),
                                            'model': model, 'host': host})
        if self.progress:
            self.progress({'usage': dict(self.usage), 'runId': self.run_id})


CURRENT_RUN = ContextVar('workbench_pdf_run', default=None)


def current():
    return CURRENT_RUN.get()
