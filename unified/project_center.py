"""Recoverable project lifecycle and atomic legacy-draft indexing."""
from collections import Counter
from contextlib import contextmanager
from copy import deepcopy
import json
import re
import time

from .core import LocalError, packed

BUCKET = 'workspace-projects'
LABELS = {'csa': 'CSA', 'msci': 'MSCI', 'mainland': '大陆交易所', 'hkex': '港交所', 'benchmark': '横向对标'}


class ProjectCenter:
    def __init__(self, workspace):
        self.workspace, self.app, self.store = workspace, workspace.app, workspace.store
        self.requests = Counter()

    def _row(self, db, key):
        return db.execute('SELECT p.revision,p.value,a.updated FROM projects p LEFT JOIN archived a '
                          'ON a.namespace=p.namespace AND a.bucket=p.bucket AND a.key=p.key '
                          'WHERE p.namespace=? AND p.bucket=? AND p.key=?', ('exchange', BUCKET, key)).fetchone()

    def check(self, key):
        with self.store.connect() as db:
            row = self._row(db, key)
        if row and row[2] is not None:
            raise LocalError('该项目已移入回收站，请先在项目中心恢复。', 410)

    @contextmanager
    def access(self, key):
        with self.workspace.lock:
            self.check(key)
            self.requests[key] += 1
        try:
            yield
        finally:
            with self.workspace.lock:
                self.requests[key] -= 1
                if not self.requests[key]: del self.requests[key]

    def context(self, key):
        with self.workspace.lock, self.store.connect() as db:
            row = self._row(db, key)
            if row and row[2] is not None:
                raise LocalError('该项目已移入回收站，请先在项目中心恢复。', 410)
            return {'project': {**json.loads(row[1]), 'revision': row[0]} if row else None}

    def trash(self):
        with self.store.connect() as db:
            rows = db.execute('SELECT p.value,p.revision,a.updated FROM projects p JOIN archived a '
                              'ON a.namespace=p.namespace AND a.bucket=p.bucket AND a.key=p.key '
                              'WHERE p.namespace=? AND p.bucket=? ORDER BY a.updated DESC', ('exchange', BUCKET)).fetchall()
        return [{**json.loads(row[0]), 'revision': row[1], 'deletedAt': row[2]} for row in rows]

    def busy(self, key):
        if self.requests.get(key) or any(r.get('projectId') == key and r['status'] in {'running', 'queued', 'paused'}
                                         for r in self.workspace.live.values()):
            return True
        return self.app.bindings.project_busy(key)

    @staticmethod
    def _revision(row, expected):
        if not isinstance(expected, int) or isinstance(expected, bool) or expected != row[0]:
            raise LocalError('项目已有更新，请刷新项目列表后再操作。', 409)

    def _write(self, db, namespace, bucket, key, value, group, expected=None):
        row = db.execute('SELECT revision,value FROM projects WHERE namespace=? AND bucket=? AND key=?',
                         (namespace, bucket, key)).fetchone()
        revision = row[0] if row else 0
        if expected is not None and expected != revision:
            raise LocalError('项目已有更新，请重新读取后保存。', 409)
        stamp = time.time()
        if row:
            db.execute('INSERT OR IGNORE INTO history VALUES(?,?,?,?,?,?)', (namespace, bucket, key, revision, row[1], stamp))
        db.execute('INSERT OR REPLACE INTO projects VALUES(?,?,?,?,?,?,?)',
                   (namespace, bucket, key, group, revision + 1, packed(self.store.secrets.clean(value)), stamp))
        db.execute('DELETE FROM archived WHERE namespace=? AND bucket=? AND key=?', (namespace, bucket, key))
        return revision + 1

    def transition(self, key, action, data):
        if not isinstance(data, dict): raise LocalError('项目操作数据无效。')
        with self.workspace.lock, self.store.connect() as db:
            if self.busy(key): raise LocalError('该项目仍有任务正在运行，请结束任务后再操作。', 409)
            db.execute('BEGIN IMMEDIATE')
            row = self._row(db, key)
            if not row: raise LocalError('项目不存在。', 404)
            self._revision(row, data.get('revision'))
            deleted = row[2] is not None
            if action not in {'rename', 'archive', 'restore'}: raise LocalError('不支持此项目操作。')
            if deleted != (action == 'restore'):
                raise LocalError('项目状态已改变，请刷新列表后再操作。', 409)
            value = json.loads(row[1])
            if action == 'rename':
                name = data.get('name')
                if not isinstance(name, str) or not name.strip() or len(name.strip()) > 160:
                    raise LocalError('项目名称须为1至160个字符。')
                value.update(name=name.strip(), autoName=False, updatedAt=time.time())
                if value['module'] == 'benchmark' and value.get('nativeBucket'):
                    native = db.execute('SELECT value FROM projects WHERE namespace=? AND bucket=? AND key=?',
                                        ('exchange', value['nativeBucket'], value['nativeKey'])).fetchone()
                    if native:
                        draft = json.loads(native[0]); draft['name'] = name.strip()
                        self._write(db, 'exchange', value['nativeBucket'], value['nativeKey'], draft, key)
            revision = self._write(db, 'exchange', BUCKET, key, value, key, row[0])
            deleted_at = time.time() if action == 'archive' else None
            if deleted_at is not None:
                db.execute('INSERT INTO archived VALUES(?,?,?,?)', ('exchange', BUCKET, key, deleted_at))
            result = {**value, 'revision': revision}
            if deleted_at is not None: result['deletedAt'] = deleted_at
            return {'project': result, 'trashed': action == 'archive'}

    @staticmethod
    def native_metadata(namespace, value):
        if namespace == 'csa':
            return 'csa', value.get('name', ''), value.get('reportPeriod', ''), value.get('targetPeriod', ''), ''
        if namespace == 'msci':
            project = value.get('project', {})
            return 'msci', project.get('client_name', ''), project.get('report_period', ''), project.get('target_period', ''), ''
        if value.get('frameworkVersion') or value.get('framework'):
            periods = list(dict.fromkeys(str(r.get('reportYear', '')) for r in value.get('reports', []) if r.get('reportYear')))
            return 'benchmark', '', '、'.join(periods), '', value.get('name', '')
        return ('hkex' if value.get('exchange') == 'hk' else 'mainland', value.get('customerName', ''),
                value.get('reportYear', ''), value.get('targetYear', ''), '')

    def save_native(self, namespace, data):
        group, bucket, key, value = (data.get(k) for k in ('groupId', 'bucket', 'key', 'value'))
        if not isinstance(group, str) or not re.fullmatch(r'[a-f0-9]{32}', group):
            raise LocalError('项目身份无效，请从项目中心重新打开。')
        if not isinstance(bucket, str) or not bucket.endswith('::' + group) or not isinstance(key, str) or not key or len(key) > 4096:
            raise LocalError('草稿位置无效。')
        if not isinstance(value, dict): raise LocalError('草稿数据无效。')
        allowed = {'csa': 'csa-local-workbench', 'msci': 'msci-workbench', 'exchange': 'exchange-sustainability-workbench'}
        prefix = bucket.split('::')[0]
        if prefix != allowed.get(namespace) and not (namespace == 'exchange' and prefix == 'exchange-peer-benchmark'):
            raise LocalError('草稿类型无效。')
        module, company, period, target, native_name = self.native_metadata(namespace, value)
        if module not in LABELS: raise LocalError('项目模块无效。')
        with self.workspace.lock, self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = self._row(db, group)
            if row and row[2] is not None: raise LocalError('该项目已移入回收站，请先恢复。', 410)
            center = json.loads(row[1]) if row else {'id': group, 'module': module, 'name': native_name or company or LABELS[module] + '项目',
                'company': '', 'reportPeriod': '', 'targetPeriod': '', 'options': {}, 'documents': [], 'selected': [], 'comments': {},
                'createdAt': time.time(), 'autoName': True}
            if center['module'] != module:
                raise LocalError('草稿模块与项目不一致，请从对应项目重新打开。', 409)
            if center.get('autoName'): center['name'] = native_name or company or center['name']
            center.update(company=str(company), reportPeriod=str(period), targetPeriod=str(target),
                          updatedAt=time.time(), lastSavedAt=time.time(), hasNativeDraft=True, nativeBucket=bucket, nativeKey=key)
            revision = self._write(db, namespace, bucket, key, deepcopy(value), group, data.get('expectedRevision'))
            center_revision = self._write(db, 'exchange', BUCKET, group, center, group, row[0] if row else 0)
            return {'revision': revision, 'key': key, 'groupId': group, 'projectRevision': center_revision}
