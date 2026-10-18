"""Shared local persistence. Original bytes and human work are never cache entries."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import threading
import time
import uuid

NAMESPACES = frozenset({'csa', 'msci', 'exchange'})
ACTIVE = ContextVar('unified_workbench_run', default=None)


def packed(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def fingerprint(value):
    return hashlib.sha256(packed(value).encode()).hexdigest()


class LocalError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class Secrets:
    """Process-only registry; also removes known secrets echoed in arbitrary text."""
    def __init__(self):
        self._values = set()
        self._lock = threading.RLock()

    def remember(self, value):
        if value:
            with self._lock:
                self._values.add(value)

    def clean(self, value):
        with self._lock:
            secrets = tuple(self._values)
        def visit(item):
            if isinstance(item, str):
                for secret in secrets:
                    item = item.replace(secret, '[已隐藏连接凭据]')
                return item
            if isinstance(item, dict):
                return {k: visit(v) for k, v in item.items()
                        if str(k).lower().replace('_', '').replace('-', '')
                        not in {'apikey', 'authorization', 'password', 'secret', 'token', 'bearer'}}
            if isinstance(item, (list, tuple)):
                return [visit(v) for v in item]
            return item
        return visit(value)


@dataclass(frozen=True)
class Run:
    namespace: str
    scope: str
    job_id: str


@contextmanager
def running(namespace, scope, job_id):
    token = ACTIVE.set(Run(namespace, scope, job_id))
    try:
        yield
    finally:
        ACTIVE.reset(token)


class Store:
    SCHEMA = 1
    def __init__(self, root, secrets=None, *, cache_bytes=256 * 1024 * 1024):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)
        self.path = self.root / 'workbench.sqlite3'
        self.blobs = self.root / 'originals'
        self.blobs.mkdir(exist_ok=True, mode=0o700)
        self.secrets = secrets or Secrets()
        self.session = uuid.uuid4().hex
        self.cache_bytes = cache_bytes
        self.cache_ttl = 30 * 86400
        with self.connect() as db:
            version = db.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0, self.SCHEMA):
                raise LocalError('本机资料库版本不兼容；原资料保留。', 409)
            db.executescript('''
                CREATE TABLE IF NOT EXISTS blobs(sha TEXT PRIMARY KEY, size INTEGER, mime TEXT, pages INTEGER);
                CREATE TABLE IF NOT EXISTS documents(namespace TEXT, scope TEXT, id TEXT, sha TEXT,
                    name TEXT, meta TEXT, PRIMARY KEY(namespace,scope,id));
                CREATE TABLE IF NOT EXISTS projects(namespace TEXT, bucket TEXT, key TEXT,
                    group_id TEXT, revision INTEGER, value TEXT, updated REAL,
                    PRIMARY KEY(namespace,bucket,key));
                CREATE TABLE IF NOT EXISTS history(namespace TEXT,bucket TEXT,key TEXT,
                    revision INTEGER,value TEXT,updated REAL,PRIMARY KEY(namespace,bucket,key,revision));
                CREATE TABLE IF NOT EXISTS archived(namespace TEXT,bucket TEXT,key TEXT,updated REAL,
                    PRIMARY KEY(namespace,bucket,key));
                CREATE TABLE IF NOT EXISTS artifacts(namespace TEXT,scope TEXT,kind TEXT,key TEXT,
                    contract TEXT,value TEXT,updated REAL,PRIMARY KEY(namespace,scope,kind,key,contract));
                CREATE TABLE IF NOT EXISTS jobs(namespace TEXT,id TEXT,owner TEXT,value TEXT,updated REAL,
                    PRIMARY KEY(namespace,id));
                CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY,namespace TEXT,scope TEXT,run_id TEXT,
                    phase TEXT,value TEXT,updated REAL);
            ''')
            db.execute(f'PRAGMA user_version={self.SCHEMA}')
        self.path.chmod(0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=20)
        try:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('PRAGMA busy_timeout=20000')
            with db:
                yield db
        finally:
            db.close()
            for suffix in ('', '-wal', '-shm'):
                path = Path(str(self.path) + suffix)
                if path.exists():
                    path.chmod(0o600)

    @staticmethod
    def namespace(value):
        if value not in NAMESPACES:
            raise LocalError('未知工作台。')
        return value

    def put_document(self, namespace, scope, raw, name, *, ref_id=None, mime='application/pdf', meta=None):
        self.namespace(namespace)
        if not isinstance(raw, bytes) or not 0 < len(raw) <= 80 * 1024 * 1024:
            raise LocalError('原件为空或超过80 MiB。', 413)
        if raw.startswith(b'%PDF-'):
            mime = 'application/pdf'
        pages = None
        if mime == 'application/pdf':
            if not raw.startswith(b'%PDF-'):
                raise LocalError('文件不是PDF。')
            import io
            from pypdf import PdfReader
            try:
                reader = PdfReader(io.BytesIO(raw), strict=False)
                if reader.is_encrypted or not 1 <= len(reader.pages) <= 500:
                    raise ValueError()
                pages = len(reader.pages)
            except Exception:
                raise LocalError('PDF已加密、损坏或超出1–500物理页。') from None
        elif mime not in {'image/png', 'image/jpeg', 'application/octet-stream'}:
            raise LocalError('不支持的原件类型。')
        sha = hashlib.sha256(raw).hexdigest()
        path = self.blobs / sha
        if not path.exists():
            temporary = self.blobs / ('.' + uuid.uuid4().hex)
            try:
                with temporary.open('xb') as stream:
                    os.chmod(temporary, 0o600)
                    stream.write(raw)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
        else:
            if hashlib.sha256(path.read_bytes()).hexdigest() != sha:
                raise LocalError('原件指纹校验失败；已停止使用该文件。', 409)
        ref_id = ref_id or uuid.uuid4().hex
        with self.connect() as db:
            db.execute('INSERT OR IGNORE INTO blobs VALUES(?,?,?,?)', (sha, len(raw), mime, pages))
            old = db.execute('SELECT sha FROM documents WHERE namespace=? AND scope=? AND id=?',
                             (namespace, scope, ref_id)).fetchone()
            if old and old[0] != sha:
                raise LocalError('文档身份对应的原件已改变。', 409)
            db.execute('INSERT OR REPLACE INTO documents VALUES(?,?,?,?,?,?)',
                       (namespace, scope, ref_id, sha, self.secrets.clean(str(name))[:500], packed(self.secrets.clean(meta or {}))))
        return {'id': ref_id, 'sha256': sha, 'name': str(name)[:500], 'bytes': len(raw), 'pageCount': pages, 'mime': mime}

    def document(self, namespace, scope, ref_id):
        self.namespace(namespace)
        with self.connect() as db:
            row = db.execute('SELECT d.sha,d.name,d.meta,b.mime,b.pages FROM documents d JOIN blobs b ON b.sha=d.sha '
                             'WHERE namespace=? AND scope=? AND id=?', (namespace, scope, ref_id)).fetchone()
        if not row:
            raise LocalError('本项目没有该原件。', 404)
        raw = (self.blobs / row[0]).read_bytes()
        if hashlib.sha256(raw).hexdigest() != row[0]:
            raise LocalError('原件指纹校验失败。', 409)
        return {'sha256': row[0], 'name': row[1], 'meta': json.loads(row[2]), 'mime': row[3], 'pageCount': row[4], 'bytes': raw}

    def save_project(self, namespace, bucket, key, value, group_id='', expected=None):
        self.namespace(namespace)
        if not isinstance(value, dict) or not all(isinstance(v, str) and 0 < len(v) <= 4096 for v in (bucket, key)):
            raise LocalError('项目记录格式无效。')
        body = packed(self.secrets.clean(value))
        now = time.time()
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT revision,value FROM projects WHERE namespace=? AND bucket=? AND key=?',
                             (namespace, bucket, key)).fetchone()
            revision = row[0] if row else 0
            if expected is not None and expected != revision:
                raise LocalError('项目已有更新，请重新读取后保存；旧版本保留。', 409)
            if row:
                db.execute('INSERT OR IGNORE INTO history VALUES(?,?,?,?,?,?)',
                           (namespace, bucket, key, revision, row[1], now))
            db.execute('INSERT OR REPLACE INTO projects VALUES(?,?,?,?,?,?,?)',
                       (namespace, bucket, key, str(group_id)[:100], revision + 1, body, now))
            db.execute('DELETE FROM archived WHERE namespace=? AND bucket=? AND key=?', (namespace, bucket, key))
        return {'revision': revision + 1, 'key': key, 'groupId': str(group_id)[:100]}

    def project(self, namespace, bucket, key, revision=None):
        self.namespace(namespace)
        with self.connect() as db:
            if revision is None:
                row = db.execute('SELECT value FROM projects p WHERE namespace=? AND bucket=? AND key=? AND NOT EXISTS '
                                 '(SELECT 1 FROM archived a WHERE a.namespace=p.namespace AND a.bucket=p.bucket AND a.key=p.key)',
                                 (namespace, bucket, key)).fetchone()
            else:
                row = db.execute('SELECT value FROM history WHERE namespace=? AND bucket=? AND key=? AND revision=?',
                                 (namespace, bucket, key, revision)).fetchone()
        return json.loads(row[0]) if row else None

    def list_projects(self, namespace=None, bucket=None):
        if namespace:
            self.namespace(namespace)
        clauses, args = ['NOT EXISTS (SELECT 1 FROM archived a WHERE a.namespace=projects.namespace AND a.bucket=projects.bucket AND a.key=projects.key)'], []
        for field, value in (('namespace', namespace), ('bucket', bucket)):
            if value is not None:
                clauses.append(field + '=?'); args.append(value)
        where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
        with self.connect() as db:
            rows = db.execute('SELECT namespace,bucket,key,group_id,revision,value,updated FROM projects' + where + ' ORDER BY updated DESC', args).fetchall()
        return [{'namespace': r[0], 'bucket': r[1], 'key': r[2], 'groupId': r[3], 'revision': r[4],
                 'value': json.loads(r[5]), 'updated': r[6]} for r in rows]

    def archive_project(self, namespace, bucket, key, restore=False):
        self.namespace(namespace)
        with self.connect() as db:
            if restore:
                db.execute('DELETE FROM archived WHERE namespace=? AND bucket=? AND key=?', (namespace, bucket, key))
            else:
                db.execute('INSERT OR REPLACE INTO archived VALUES(?,?,?,?)', (namespace, bucket, key, time.time()))
        return {'key': key, 'archived': not restore}

    def get(self, namespace, scope, kind, key, contract):
        self.namespace(namespace)
        with self.connect() as db:
            row = db.execute('SELECT value,updated FROM artifacts WHERE namespace=? AND scope=? AND kind=? AND key=? AND contract=?',
                             (namespace, scope, kind, key, contract)).fetchone()
        return json.loads(row[0]) if row and row[1] >= time.time() - self.cache_ttl else None

    def put(self, namespace, scope, kind, key, contract, value):
        self.namespace(namespace)
        body = packed(self.secrets.clean(value))
        if len(body.encode()) > self.cache_bytes: return False
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO artifacts VALUES(?,?,?,?,?,?,?)',
                       (namespace, scope, kind, key, contract, body, time.time()))
            db.execute('DELETE FROM artifacts WHERE updated<?', (time.time() - self.cache_ttl,))
            total = db.execute('SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) FROM artifacts').fetchone()[0]
            while total > self.cache_bytes:
                row = db.execute('SELECT rowid,length(CAST(value AS BLOB)) FROM artifacts ORDER BY updated LIMIT 1').fetchone()
                db.execute('DELETE FROM artifacts WHERE rowid=?', (row[0],))
                total -= row[1]
        return True

    def clear_cache(self, namespace):
        self.namespace(namespace)
        with self.connect() as db:
            db.execute('DELETE FROM artifacts WHERE namespace=?', (namespace,))

    def save_job(self, namespace, job_id, value):
        self.namespace(namespace)
        safe = {k: v for k, v in value.items() if not k.startswith('_') and k not in {'provider', 'request', 'context', 'updated'}}
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO jobs VALUES(?,?,?,?,?)',
                       (namespace, job_id, self.session, packed(self.secrets.clean(safe)), time.time()))

    def job(self, namespace, job_id):
        self.namespace(namespace)
        with self.connect() as db:
            row = db.execute('SELECT owner,value FROM jobs WHERE namespace=? AND id=?', (namespace, job_id)).fetchone()
        if not row:
            return None
        value = json.loads(row[1])
        if row[0] != self.session and value.get('status', value.get('phase')) in {
                'queued', 'running', 'pending', 'in_progress', 'paused', 'reading', 'evaluating'}:
            value.update(status='interrupted', phase='interrupted',
                         error='服务已重启。重新连接模型并从已保存项目继续，已验证页段和结果将复用。')
        return value

    def record_usage(self, namespace, scope, run_id, phase, *, response=None, error=False, model='', host=''):
        self.namespace(namespace)
        usage = response.get('usage') if isinstance(response, dict) else None
        accepted = {}
        if isinstance(usage, dict):
            for key in ('prompt_tokens', 'completion_tokens', 'total_tokens'):
                if type(usage.get(key)) is int and usage[key] >= 0:
                    accepted[key] = usage[key]
            for parent, key, target in (('prompt_tokens_details', 'cached_tokens', 'cached_tokens'),
                                        ('completion_tokens_details', 'reasoning_tokens', 'reasoning_tokens')):
                value = (usage.get(parent) or {}).get(key) if isinstance(usage.get(parent), dict) else None
                if type(value) is int and value >= 0:
                    accepted[target] = value
        value = {'usage': accepted, 'usageKnown': bool(accepted), 'status': 'failed' if error else 'responded',
                 'model': model, 'host': host}
        with self.connect() as db:
            db.execute('INSERT INTO usage VALUES(?,?,?,?,?,?,?)',
                       (uuid.uuid4().hex, namespace, scope, run_id, phase, packed(self.secrets.clean(value)), time.time()))

    def usage(self):
        with self.connect() as db:
            rows = db.execute('SELECT namespace,scope,run_id,phase,value,updated FROM usage ORDER BY updated').fetchall()
        return [{'namespace': r[0], 'scope': r[1], 'runId': r[2], 'phase': r[3], **json.loads(r[4]), 'at': r[5]} for r in rows]
