"""Loopback-only workbench service; API modules are added in subsequent steps."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit, parse_qs
from urllib.request import urlopen
import webbrowser

ROOT = Path(__file__).resolve().parents[1]
if __package__ in (None, ""):
    sys.path.insert(0, str(ROOT))
from pipeline.constants import APP_ID, APP_VERSION, API_VERSION, DEFAULT_PORT, MAX_JSON_BYTES, MAX_PDF_BYTES
from pipeline.errors import RequestError
from pipeline.pdf_pages import DOCUMENTS
from pipeline.model_proxy import PROVIDERS
from pipeline.topic_align import ALIGNMENTS
from pipeline.pdf_assessment import REVIEWS
from pipeline.benchmark import BENCHMARKS
from pipeline.rules import load_rules
from pipeline.assessment_reference import assessment_reference
WORKSPACE_ID = hashlib.sha256(str(ROOT).encode()).hexdigest()[:16]


class WorkbenchHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "site"), **kwargs)

    def log_message(self, fmt, *args):
        # Do not print request paths, parameters, payloads or credentials.
        return

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src blob:; object-src 'none'; base-uri 'none'")
        super().end_headers()

    def send_json(self, value, status=200):
        content = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def send_error(self, code, message=None, explain=None):
        self.send_json({"error": {"category": "not_found" if code == 404 else "request", "message": "资源不存在。" if code == 404 else "请求无法完成。"}}, code)

    def read_body(self, maximum):
        length = self.headers.get("Content-Length", "")
        if self.headers.get("Transfer-Encoding") or not length.isdigit():
            raise RequestError("请求须包含有效内容长度。", "request_size", 400)
        size = int(length)
        if size > maximum:
            raise RequestError("上传内容超过允许大小。", "pdf_size" if maximum == MAX_PDF_BYTES else "request_size", 413)
        value = self.rfile.read(size)
        if len(value) != size:
            raise RequestError("上传未完成，请重新上传。", "request_incomplete", 400)
        return value

    def read_json(self):
        try:
            value = json.loads(self.read_body(MAX_JSON_BYTES))
            if not isinstance(value, dict):
                raise ValueError
            return value
        except (ValueError, UnicodeError):
            raise RequestError("请求须为有效的 JSON 对象。", "request_json", 400) from None

    def dispatch(self, operation):
        try:
            operation()
        except RequestError as exc:
            self.send_json(exc.response(), exc.status)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception:
            self.send_json({"error": {"category": "internal", "message": "本机处理未完成，请重试；原文件及已保存草稿保留。"}}, 500)

    def local_request(self):
        port = self.server.server_port
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        origin = self.headers.get("Origin")
        if self.headers.get("Host") not in hosts or (origin and origin not in {f"http://{host}" for host in hosts}):
            self.send_json({"error": {"category": "request_origin", "message": "此服务仅接受本机同源请求。"}}, 403)
            return False
        return True

    def translate_path(self, path):
        relative = unquote(urlsplit(path).path).lstrip("/")
        if relative.startswith("data/"):
            base = ROOT / "data"
            relative = relative[5:]
        else:
            base = ROOT / "site"
        candidate = (base / relative).resolve()
        if not candidate.is_relative_to(base.resolve()):
            return str(base / "__unavailable__")
        return str(candidate)

    def list_directory(self, path):
        self.send_json({"error": {"category": "not_found", "message": "该资源不存在。"}}, 404)
        return None

    def do_GET(self):
        if not self.local_request():
            return
        if urlsplit(self.path).path.startswith("/api/"):
            self.dispatch(self.api_get)
            return
        super().do_GET()

    def api_get(self):
        path = urlsplit(self.path).path
        if path == "/api/status":
            self.send_json({"appId": APP_ID, "appVersion": APP_VERSION, "apiVersion": API_VERSION, "workspaceId": WORKSPACE_ID, "nativePdfReview": True, "markets": ["mainland", "hk"], "modules": ["mainland", "hk", "benchmark"], "port": self.server.server_port, **PROVIDERS.public()})
        elif path == "/api/assessment-reference":
            query = parse_qs(urlsplit(self.path).query)
            exchange = query.get('exchange', [''])[0]
            context = None
            if exchange == 'hk':
                category = query.get('issuerCategory', [''])[0]
                fiscal_year_start = query.get('fiscalYearStart', [''])[0]
                if category not in ('largecap', 'mainboard', 'gem') or not fiscal_year_start:
                    raise RequestError('港交所评估依据须指定发行人类别及财政年度开始日期。')
                context = {'issuerCategory': category, 'fiscalYearStart': fiscal_year_start,
                           'board': 'GEM' if category == 'gem' else '主板'}
            self.send_json(assessment_reference(load_rules(exchange, context)))
        elif path.startswith("/api/benchmark/"):
            self.send_json(BENCHMARKS.jobs.get(path.rsplit("/", 1)[-1]).snapshot())
        elif path.startswith("/api/pdf-jobs/"):
            self.send_json(DOCUMENTS.parse_status(path.rsplit("/", 1)[-1]))
        elif path.startswith("/api/topic-align/"):
            self.send_json(ALIGNMENTS.jobs.get(path.rsplit("/", 1)[-1]).snapshot())
        elif path.startswith("/api/pdf-review/"):
            self.send_json(REVIEWS.jobs.get(path.rsplit("/", 1)[-1]).snapshot())
        else:
            raise RequestError("该接口不存在。", "not_found", 404)

    def do_POST(self):
        if self.local_request():
            self.dispatch(self.api_post)

    def api_post(self):
        parsed = urlsplit(self.path)
        path = parsed.path
        if path == "/api/providers":
            data = self.read_json()
            self.send_json(PROVIDERS.select(data.get("providerId")) if data.get("action") == "select" else PROVIDERS.register(data), 200)
        elif path == "/api/native-documents":
            if self.headers.get_content_type() != "application/pdf":
                raise RequestError("请以 PDF 文件内容上传。", "pdf_type", 415)
            source = parse_qs(parsed.query).get("source", ["main"])[0]
            content = self.read_body(MAX_PDF_BYTES)
            self.send_json(DOCUMENTS.register(content, unquote(self.headers.get("X-Filename", "报告.pdf")), source), 201)
        elif path == "/api/parse-pdf":
            self.send_json(DOCUMENTS.parse(self.read_json().get("documentId")), 202)
        elif path == "/api/topic-align":
            self.send_json(ALIGNMENTS.create(self.read_json()), 202)
        elif path.startswith("/api/topic-align/"):
            self.send_json(ALIGNMENTS.jobs.get(path.rsplit("/", 1)[-1]).control(self.read_json().get('action')), 202)
        elif path == "/api/benchmark":
            self.send_json(BENCHMARKS.create(self.read_json()), 202)
        elif path.startswith("/api/benchmark/"):
            self.send_json(BENCHMARKS.jobs.get(path.rsplit("/", 1)[-1]).control(self.read_json().get('action')), 202)
        elif path == "/api/pdf-review":
            self.send_json(REVIEWS.create(self.read_json()), 202)
        elif path.startswith("/api/pdf-review/"):
            data = self.read_json()
            task_id = path.rsplit("/", 1)[-1]
            if data.get("action") == "retry":
                result = REVIEWS.retry(task_id, data.get("topicIds"))
            else:
                result = REVIEWS.jobs.get(task_id).control(data.get("action"))
            self.send_json(result, 202)
        elif path == "/api/pdf-page":
            data = self.read_json()
            self.send_json(DOCUMENTS.preview(data.get("documentId"), data.get("page")))
        else:
            raise RequestError("该接口不存在。", "not_found", 404)

    def do_OPTIONS(self):
        if self.local_request():
            self.send_json({"error": {"category": "method", "message": "该请求方法不受支持。"}}, 405)

    def do_HEAD(self):
        if self.local_request():
            super().do_HEAD()


def main():
    parser = argparse.ArgumentParser(description="三大交易所可持续发展报告工作台")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--open-browser", action="store_true")
    parser.add_argument("--allow-port-fallback", action="store_true")
    args = parser.parse_args()
    server = None
    for port in range(args.port, args.port + (20 if args.allow_port_fallback else 1)):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), WorkbenchHandler)
            break
        except OSError:
            try:
                with urlopen(f"http://127.0.0.1:{port}/api/status", timeout=0.5) as response:
                    existing = json.load(response)
                if existing.get("appId") == APP_ID and existing.get("workspaceId") == WORKSPACE_ID and existing.get("appVersion") == APP_VERSION:
                    address = f"http://127.0.0.1:{port}/#/markets"
                    print(f"工作台已在运行：{address}", flush=True)
                    if args.open_browser:
                        webbrowser.open(address)
                    return
            except Exception:
                continue
    if server is None:
        raise SystemExit("本机工作台端口无法使用，请关闭之前的工作台进程后重试。") from None
    if server.server_port != args.port:
        print(f"默认端口 {args.port} 被占用，本次使用 {server.server_port}。草稿按当前浏览器地址分别保存。", flush=True)
    print(f"工作台已启动：http://127.0.0.1:{server.server_port}/#/markets", flush=True)
    if args.open_browser:
        webbrowser.open(f"http://127.0.0.1:{server.server_port}/#/markets")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("工作台已停止。", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
