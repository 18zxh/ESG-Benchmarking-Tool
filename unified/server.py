"""One loopback HTTP server: shared APIs and three unchanged legacy surfaces."""
from __future__ import annotations
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import hashlib
from pathlib import Path
import re
import sys
from urllib.parse import parse_qs, unquote, urlsplit
import webbrowser

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    __package__ = 'unified'
from .adapters import Bindings
from .core import LocalError, Store, running
from .gateway import Gateway
from .loader import Modules
from .ui_copy import simplify_interface_copy

ROOT = Path(__file__).resolve().parent
APP_ID = 'unified-esg-workbench'
VERSION = '0.4.0'


class Application:
    def __init__(self, data_dir=None, *, allow_local_models=False, sender=None):
        self.store = Store(data_dir or ROOT.parent / '.runtime' / 'unified-data')
        self.gateway = Gateway(self.store, allow_local=allow_local_models, sender=sender)
        self.modules = Modules()
        self.bindings = Bindings(self.modules, self.store, self.gateway)
        from .workspace import Workspace
        self.workspace = Workspace(self)

    def close(self):
        self.workspace.close()
        self.modules.close()


class Handler(BaseHTTPRequestHandler):
    server_version = 'UnifiedESG/0.1'
    sys_version = ''

    @property
    def app(self):
        return self.server.app

    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'")
        BaseHTTPRequestHandler.end_headers(self)

    def send(self, body, mime='application/json; charset=utf-8', status=200):
        if not isinstance(body, bytes):
            body = json.dumps(self.app.store.secrets.clean(body), ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def body(self, maximum=64 * 1024 * 1024):
        text = self.headers.get('Content-Length', '')
        if self.headers.get('Transfer-Encoding') or not text.isdigit():
            raise LocalError('请求缺少有效长度。')
        size = int(text)
        if size > maximum:
            raise LocalError('请求超过容量上限。', 413)
        raw = self.rfile.read(size)
        if len(raw) != size:
            raise LocalError('请求未完整传输。')
        return raw

    def json_body(self):
        if 'application/json' not in self.headers.get('Content-Type', ''):
            raise LocalError('本接口要求JSON。')
        try:
            value = json.loads(self.body())
            if not isinstance(value, dict): raise ValueError()
            return value
        except (ValueError, UnicodeError):
            raise LocalError('JSON对象无效。') from None

    def allowed(self):
        port = self.server.server_port
        host = self.headers.get('Host')
        if host not in {f'127.0.0.1:{port}', f'localhost:{port}'}:
            return False
        origin = self.headers.get('Origin')
        return (not origin or origin == 'http://' + host) and self.headers.get('Sec-Fetch-Site') not in {'cross-site'}

    def handle_request(self):
        if not self.allowed():
            self.send({'error': '仅接受本机同源请求。'}, status=403)
            return
        try:
            parsed = urlsplit(self.path)
            path = unquote(parsed.path)
            if '\\' in path or '\x00' in path or '..' in path.split('/'):
                raise LocalError('路径无效。', 404)
            query = parse_qs(parsed.query)
            if path.startswith('/api/'):
                return self.shared_api(path, query)
            if path.startswith('/_app/'):
                return self.app_static(path[len('/_app/'):])
            if path.startswith('/_unified/'):
                return self.shared_static(path[len('/_unified/'):])
            if path == '/':
                if (ROOT / 'app-dist/index.html').exists():return self.app_static('index.html')
                return self.shared_static('index.html')
            if path == '/classic/':return self.shared_static('index.html')
            match = re.fullmatch(r'/(csa|msci|exchange)(/.*)?', path)
            if not match:
                raise LocalError('资源不存在。', 404)
            namespace, suffix = match.groups()
            if suffix is None:
                self.send_response(302); self.send_header('Location', path + '/' + ('?' + parsed.query if parsed.query else '')); self.end_headers()
                return
            if suffix == '/api/providers' and self.command == 'POST':
                self.app.gateway.connect(self.json_body())
                status = self.app.gateway.public()
                return self.send(status if namespace == 'exchange' else {'provider': {**status['providers'][0], 'nativePdf': True}})
            if suffix.startswith('/api/'):
                return self.delegate(namespace, suffix + ('?' + parsed.query if parsed.query else ''))
            return self.legacy_static(namespace, suffix)
        except LocalError as exc:
            self.send({'error': str(exc)}, status=exc.status)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.send({'error': '本机处理未完成。原件和已保存版本保留。'}, status=500)

    do_GET = handle_request
    do_POST = handle_request
    do_HEAD = handle_request

    def shared_api(self, path, query):
        if path.startswith('/api/workspace/'):
            from .workspace_api import route
            return route(self,path,query)
        read = self.command in {'GET', 'HEAD'}
        get = lambda name, default='': query.get(name, [default])[0]
        if path in {'/api/status', '/api/v1/status'} and read:
            return self.send({'appId': APP_ID, 'version': VERSION, 'port': self.server.server_port,
                              'workspaceId': hashlib.sha256(str(ROOT).encode()).hexdigest()[:16],
                              'storeId': hashlib.sha256(str(self.app.store.root).encode()).hexdigest()[:16],
                              'modules': ['csa', 'msci', 'exchange'], 'storage': 'sqlite',
                              'realModelValidated': False, **self.app.gateway.public()})
        if path == '/api/v1/providers':
            return self.send(self.app.gateway.public() if read else self.app.gateway.connect(self.json_body()))
        if path == '/api/v1/usage' and read:
            return self.send({'calls': self.app.store.usage()})
        if path == '/api/v1/backup' and read:
            import tempfile
            from .backup import create_backup
            with tempfile.TemporaryDirectory(prefix='esg-download-') as folder:
                archive = create_backup(self.app.store, Path(folder) / 'ESG-workbench-backup.zip')
                self.send_response(200)
                self.send_header('Content-Type', 'application/zip')
                self.send_header('Content-Disposition', 'attachment; filename="ESG-workbench-backup.zip"')
                self.send_header('Content-Length', str(archive.stat().st_size))
                self.end_headers()
                if self.command != 'HEAD':
                    with archive.open('rb') as stream:
                        import shutil
                        shutil.copyfileobj(stream, self.wfile)
            return
        if path == '/api/v1/projects' and read:
            return self.send({'projects': self.app.store.list_projects()})
        match = re.fullmatch(r'/api/v1/projects/(csa|msci|exchange)', path)
        if match:
            namespace = match[1]
            if read:
                parts = get('bucket').split('::')
                if len(parts) > 1: self.app.workspace.center.check(parts[1])
                if get('key'):
                    revision = int(get('revision')) if get('revision') else None
                    return self.send({'value': self.app.store.project(namespace, get('bucket'), get('key'), revision)})
                return self.send({'projects': self.app.store.list_projects(namespace, get('bucket'))})
            data = self.json_body()
            scope = data.get('groupId') or (str(data.get('bucket', '')).split('::') + [''])[1]
            with self.app.workspace.center.access(scope):
                if data.get('action') in {'archive', 'restore'}:
                    return self.send(self.app.store.archive_project(namespace, data['bucket'], data['key'], data['action'] == 'restore'))
                if data.get('registerEntry') is True:
                    return self.send(self.app.workspace.center.save_native(namespace, data))
                return self.send(self.app.store.save_project(namespace, data['bucket'], data['key'], data['value'],
                                                            data.get('groupId', ''), data.get('expectedRevision')))
        match = re.fullmatch(r'/api/v1/documents/(csa|msci|exchange)(?:/([A-Za-z0-9_-]+))?', path)
        if match:
            namespace, ref = match.groups()
            scope = get('scope')
            if not scope or len(scope) > 8192: raise LocalError('缺少项目范围。')
            parts = scope.split('::')
            if len(parts) > 1: self.app.workspace.center.check(parts[1])
            if read and ref:
                document = self.app.store.document(namespace, scope, ref)
                return self.send(document['bytes'], document['mime'])
            if self.command == 'POST' and ref is None:
                name = unquote(self.headers.get('X-File-Name', 'report.pdf'))
                mime = self.headers.get('Content-Type', 'application/pdf').split(';')[0]
                return self.send(self.app.store.put_document(namespace, scope, self.body(80 * 1024 * 1024), name, mime=mime))
        match = re.fullmatch(r'/api/v1/jobs/(csa|msci|exchange)/([A-Za-z0-9_-]+)', path)
        if read and match:
            value = self.app.store.job(match[1], match[2])
            return self.send({'job': value}, status=200 if value else 404)
        raise LocalError('接口不存在。', 404)

    def shared_static(self, relative):
        if relative not in {'index.html', 'bridge.js', 'home.js', 'home.css', 'entry.css', 'shell.js'}:
            raise LocalError('资源不存在。', 404)
        path = ROOT / 'site' / relative
        if not path.is_file(): raise LocalError('资源不存在。', 404)
        mime = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8'}[path.suffix]
        self.send(path.read_bytes(), mime)

    def app_static(self,relative):
        import mimetypes
        base=ROOT/'app-dist';target=(base/relative).resolve()
        if not target.is_relative_to(base.resolve()) or not target.is_file():raise LocalError('应用资源不存在，请先构建前端。',404)
        mime=mimetypes.guess_type(target.name)[0] or 'application/octet-stream'
        self.send(target.read_bytes(),mime+('; charset=utf-8' if mime.startswith('text/') else ''))

    def legacy_static(self, namespace, suffix):
        root = ROOT / 'modules' / namespace
        if namespace == 'exchange' and suffix.startswith('/data/'):
            base, relative = root / 'data', suffix[len('/data/'):]
        else:
            base, relative = root / 'site', suffix.lstrip('/') or 'index.html'
        target = (base / relative).resolve()
        if not target.is_relative_to(base.resolve()) or not target.is_file():
            raise LocalError('资源不存在。', 404)
        raw = target.read_bytes()
        import mimetypes
        mime = mimetypes.guess_type(str(target))[0] or 'application/octet-stream'
        if target.suffix == '.html':
            text = raw.decode()
            text = text.replace('保存草稿后可在此浏览器继续', '保存到统一本机资料库后可恢复继续')
            text = text.replace('原报告与对标结果保存到当前浏览器', '原报告与对标结果保存到统一本机资料库')
            text = re.sub(r'''(\b(?:src|href)=["'])/(?!/)([^"']*)''',
                          lambda m: m[1] + '/' + namespace + '/' + m[2], text)
            script = f'<script src="/_unified/bridge.js" data-module="{namespace}"></script>'
            text = text.replace('<head>', '<head>' + script, 1)
            text = text.replace('</head>', f'<link rel="stylesheet" href="/_unified/entry.css"><script defer src="/_unified/shell.js" data-module="{namespace}"></script></head>', 1)
            text = text.replace('报告审阅工作台', '报告评估工作台')
            if namespace == 'exchange':
                text = text.replace('</svg>工作台</a>', '</svg>报告评估工作台</a>')
            text = simplify_interface_copy(namespace, target.name, text)
            raw = text.encode()
        elif target.suffix == '.js':
            text = raw.decode()
            def seam(old, new):
                nonlocal text
                if text.count(old) != 1:
                    raise LocalError('原版保存接口已改变，请先更新兼容适配。', 409)
                text = text.replace(old, new, 1)
            # Runtime presentation and storage seams leave the source snapshots intact.
            for old in ('报告披露评估工作台', '智能评估工作台', '报告审阅工作台'):
                text = text.replace(old, '报告评估工作台')
            if namespace == 'csa' and target.name in {'reports.js', 'workbench.js', 'workbench-view.js'}:
                # PDF upload UI must respect the actual native assessment limit.
                text = text.replace('file.size === 0 || file.size > 80 * 1024 * 1024', 'file.size === 0 || file.size > 50 * 1024 * 1024')
                text = text.replace('单个文件最多 80 MB', '单个文件最多 50 MB').replace('每份不超过 80 MB', '每份不超过 50 MB')
                text = text.replace('style="max-height:450px;overflow:auto"', 'class="u-check-scroll"')
            if namespace == 'msci' and target.name == 'app.js':
                # CSP rejects HTML style attributes. Keep placement data, then let
                # the shared shell apply only validated grid coordinates via CSSOM.
                text = text.replace('style="grid-column:', 'data-grid-placement="grid-column:')
            if namespace == 'csa' and target.name == 'weights.js':
                text = text.replace('style="width:${d.weight}%"', 'data-weight="${d.weight}"')
            text = text.replace('启动报告评估工作台', '启动统一ESG工作台').replace('启动 CSA 工作台.command', '启动统一ESG工作台.command')
            if namespace == 'csa' and target.name == 'project.js':
                seam('export async function saveProject(p) {', "export async function saveProject(p) { if (globalThis.__unified) return __unified.put('csa-local-workbench', 'current', p);")
                seam('export async function loadProject() {', "export async function loadProject() { if (globalThis.__unified) { const p=await __unified.get('csa-local-workbench', 'current'); return p ? validateProject(p) : __unified.seed('csa', blankProject()); }")
            if namespace == 'msci' and target.name == 'workbench.js':
                seam('function wbDatabase(mode, operation) {', "function wbDatabase(mode, operation) { if(globalThis.__unified) return __unified.database('msci-workbench', mode, operation);")
                text = text.replace('草稿、报告与评论已保存到此浏览器本机。密钥未保存。', '草稿、原报告与评论已保存到统一本机资料库。密钥未保存。').replace('此浏览器没有保存的草稿。', '当前企业项目没有保存的MSCI草稿。')
                seam('  await wbLoadProviders();\n}', "  await wbLoadProviders();\n  if (globalThis.__unified && __unified.firstMount('msci')) {\n    if (await __unified.latest('msci-workbench')) await wbRestore();\n    else { wbWorkspace = await __unified.seed('msci', wbWorkspace); wbSyncInputs(); }\n    __unified.restored();\n  }\n}")
                text = text.replace('const needsPdf = !wbWorkspace.originalPdf || ![', 'const needsPdf = Boolean(wbWorkspace.documentName) && (!wbWorkspace.originalPdf || ![').replace('.includes(wbWorkspace.documentMeta?.converterVersion);', '.includes(wbWorkspace.documentMeta?.converterVersion));')
            if namespace == 'exchange' and target.name == 'workbench.js':
                seam('  return controller;\n}', "  if (globalThis.__unified && __unified.moduleId() !== 'benchmark') {\n    const saved = await __unified.latest('exchange-sustainability-workbench');\n    if (saved) await restore(saved);\n    else {\n      project = await __unified.seed('exchange', project);\n      if (project.exchange) { rules = projectRules(rulesets[project.exchange], project); applyRules(project, rules);\n        if (project.exchange === 'hk') project.topics.forEach(t => t.selected = rules.topics.find(r => r.id === t.topicId).part === 'B' || t.topicId === 'hk_ghg12');\n      }\n      configureMarket(); renderBoards(); fill(); renderTopics(); renderReports(); renderMapping(); refresh();\n    }\n    __unified.restored();\n  }\n  return controller;\n}")
            if namespace == 'exchange' and target.name == 'benchmark.js':
                seam(' fields();render();\n return', " if (globalThis.__unified && __unified.moduleId() === 'benchmark') {\n   const saved = await __unified.latest('exchange-peer-benchmark');\n   if (saved) await restore(saved); else project = await __unified.seed('benchmark', project);\n   __unified.restored();\n }\n fields();render();\n return")
            if namespace == 'exchange' and target.name == 'workbench-core.js':
                seam('async run(mode,action){', "async run(mode,action){ if(globalThis.__unified) return __unified.database(this.name,mode,action);")
            text = text.replace('项目、原 PDF 和人工意见已保存到当前浏览器。', '项目、原 PDF 和人工意见已保存到统一本机资料库。')
            text = text.replace('保存会将原 PDF、解析文本、初评及人工意见存到当前浏览器。换浏览器／端口会进入独立存储。', '保存会将原 PDF、解析文本、初评及人工意见存入统一本机资料库。连接同一资料库并选择同一企业项目即可恢复。')
            text = text.replace('草稿已保存到当前浏览器。换浏览器、端口或清理站点数据后需使用原地址查找。', '草稿、原报告及评论已保存到统一本机资料库。')
            text = text.replace('横向对标草稿已保存到当前浏览器，包含原报告、映射和已完成结果。', '横向对标草稿已保存到统一本机资料库，包含原报告、映射和已完成结果。')
            text = text.replace('当前浏览器地址下尚无已保存草稿。', '当前企业项目尚无已保存草稿。').replace('当前浏览器尚无已保存对标草稿。', '当前企业项目尚无已保存对标草稿。')
            text = simplify_interface_copy(namespace, target.name, text)
            raw = text.encode()
            mime = 'text/javascript'
        self.send(raw, mime + ('; charset=utf-8' if mime.startswith('text/') else ''))

    def delegate(self, namespace, path):
        server = self.app.modules.servers[namespace]
        if namespace == 'exchange' and self.command == 'GET':
            match = re.fullmatch(r'/api/(pdf-review|topic-align|benchmark)/([A-Za-z0-9_-]+)', path)
            if match:
                service = getattr(server, {'pdf-review': 'REVIEWS', 'topic-align': 'ALIGNMENTS', 'benchmark': 'BENCHMARKS'}[match[1]])
                try:
                    service.jobs.get(match[2])
                except Exception:
                    saved = self.app.store.job('exchange', match[2])
                    if saved:
                        if saved.get('status') == 'interrupted':
                            saved = {**saved, 'status': 'failed', 'error': {'category': 'interrupted', 'message': saved['error']}}
                        return self.send(saved)
        cls = server.WorkbenchHandler if namespace == 'exchange' else server.Handler
        delegate = cls.__new__(cls)
        delegate.__dict__.update(self.__dict__)
        delegate.path = path
        delegate.directory = str(ROOT / 'modules' / namespace / 'site')
        # Keep one central set of response headers, without changing business routes.
        delegate.end_headers = Handler.end_headers.__get__(delegate)
        scope = self.headers.get('X-Workbench-Project') or 'default'
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', scope): raise LocalError('项目范围无效。')
        with self.app.workspace.center.access(scope), running(namespace, scope, 'request'):
            method = getattr(delegate, 'do_' + self.command, None)
            if method is None: raise LocalError('不支持此方法。', 405)
            method()
        self.close_connection = delegate.close_connection


class Server(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, app):
        self.app = app
        super().__init__(address, Handler)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8791)
    parser.add_argument('--data-dir')
    parser.add_argument('--open-browser', action='store_true')
    args = parser.parse_args()
    app = Application(args.data_dir)
    server = None
    for port in range(args.port, min(args.port + 20, 65536)):
        try:
            server = Server(('127.0.0.1', port), app)
            break
        except OSError:
            continue
    if server is None:
        app.close(); raise SystemExit('8791起的候选端口均无法使用。')
    url = f'http://127.0.0.1:{server.server_port}/'
    print('统一ESG工作台：' + url, flush=True)
    print('单服务已启动。停止请按 Control-C。密钥仅存进程内存。', flush=True)
    if args.open_browser: webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close(); app.close()


if __name__ == '__main__':
    main()
