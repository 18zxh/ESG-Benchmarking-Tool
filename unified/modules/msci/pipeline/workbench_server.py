"""Local HTTP routes; model and PDF work live in dedicated service modules."""
from __future__ import annotations
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, unquote
import json, argparse, webbrowser, secrets
try:
    from . import model_proxy as models, pdf_jobs as jobs, pdf_assessment as native
    from .errors import RequestError
    from .pdf_conversion import convert_pdf, ConversionError, MAX_PDF_BYTES
except ImportError:
    import model_proxy as models, pdf_jobs as jobs, pdf_assessment as native
    from errors import RequestError
    from pdf_conversion import convert_pdf, ConversionError, MAX_PDF_BYTES
ROOT = Path(__file__).resolve().parents[1]
SITE = (ROOT / "site").resolve()
DEFAULT_PORT = 8770
APP_ID = "msci-esg-pdf-workbench"
MAX_REQUEST_BYTES = models.MAX_REQUEST_BYTES
MAX_FIGURE_REQUEST_BYTES = models.MAX_FIGURE_REQUEST_BYTES

def resolve_static_path(request_path: str):
    if "\\" in request_path or "\x00" in request_path:
        return None
    if request_path == "/":
        request_path = "/index.html"
    target = (SITE / request_path.lstrip("/")).resolve()
    return target if target.is_relative_to(SITE) and target.is_file() else None


class Handler(SimpleHTTPRequestHandler):
    server_version = "ESGWorkbench/1.0"
    sys_version = ""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE), **kwargs)

    def log_message(self, format, *args):
        # Do not log request bodies, headers, keys, provider URLs, or excerpts.
        return

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()

    def _local_host_allowed(self) -> bool:
        host = (self.headers.get("Host") or "").lower()
        return host in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}", f"[::1]:{self.server.server_port}"}

    def _origin_allowed(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        host = (self.headers.get("Host") or "").lower()
        return origin == "http://" + host

    def _json(self, status: int, value: dict) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self, max_bytes: int = MAX_REQUEST_BYTES) -> dict:
        length_text = self.headers.get("Content-Length", "")
        if not length_text.isdigit():
            raise RequestError("请求内容长度无效。")
        length = int(length_text)
        if length < 1 or length > max_bytes:
            raise RequestError("请求内容为空或超过 " + str(max_bytes // 1024) + " KB 限制。")
        if "application/json" not in self.headers.get("Content-Type", "").lower():
            raise RequestError("请求必须使用 JSON 格式。")
        try:
            data = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise RequestError("请求 JSON 无效。") from None
        if not isinstance(data, dict):
            raise RequestError("请求 JSON 必须是对象。")
        return data

    def do_GET(self):
        if not self._local_host_allowed():
            self._json(403, {"error": "仅允许从本机访问。"})
            return
        if self.path == "/api/status":
            with models.PROVIDER_LOCK:
                providers = [models._public_provider(item) for item in models.PROVIDERS.values()]
            self._json(200, {"ok": True, "providers": providers, "mode": "local-only", "version": 6, "appId": APP_ID, "pdfConversion": "local-text-image-tables", "nativePdfReview": True})
            return
        if self.path.startswith("/api/pdf-review/"):
            if not self._origin_allowed():
                self._json(403, {"error":"请求来源未通过本机校验。"}); return
            try: self._json(200, native.job_status(self.path.rsplit("/",1)[-1]))
            except RequestError as exc: self._json(404, {"error":str(exc)})
            return
        if self.path.startswith("/api/pdf-jobs/"):
            if not self._origin_allowed():
                self._json(403, {"error":"请求来源未通过本机校验。"})
                return
            job_id = urlsplit(self.path).path.rsplit("/", 1)[-1]
            with jobs.PDF_JOB_LOCK:
                jobs._expire_pdf_jobs()
                job = jobs.PDF_JOBS.get(job_id)
                value = {key:value for key,value in job.items() if key != "updated"} if job else None
            self._json(200 if value else 404, value or {"error":"解析任务已过期，请重新上传 PDF。"})
            return
        request_path = unquote(urlsplit(self.path).path)
        target = resolve_static_path(request_path)
        if target is None:
            self.send_error(404)
            return
        self.path = request_path
        return super().do_GET()

    def do_POST(self):
        if not self._local_host_allowed() or not self._origin_allowed():
            self._json(403, {"error": "请求来源未通过本机校验。"})
            return
        try:
            if self.path in {"/api/convert-pdf", "/api/parse-pdf", "/api/native-documents", "/api/pdf-page"}:
                length_text = self.headers.get("Content-Length", "")
                if not length_text.isdigit() or not 1 <= int(length_text) <= MAX_PDF_BYTES:
                    raise RequestError("PDF 为空、长度无效或超过 30 MB。")
                if self.headers.get("Content-Type", "").split(";")[0].lower() != "application/pdf":
                    raise RequestError("此接口只接受 PDF 文件。")
                filename = unquote(self.headers.get("X-File-Name", "report.pdf"))
                filename = filename.replace("\\", "/").split("/")[-1][:200]
                if not filename.lower().endswith(".pdf"):
                    raise RequestError("PDF 文件名须以 .pdf 结尾。")
                content = self.rfile.read(int(length_text))
                if self.path == "/api/pdf-page":
                    number=self.headers.get('X-PDF-Page','')
                    if not number.isdigit():raise RequestError('PDF 页码无效。')
                    try:self._json(200,native.pdf_pages.preview_page(content,int(number)))
                    except ValueError as exc:raise RequestError(str(exc)) from None
                elif self.path == "/api/native-documents":
                    self._json(200, native.prepare_pdf(content, filename))
                elif self.path == "/api/parse-pdf":
                    self._json(202, {"jobId":jobs.create_pdf_job(content, filename)})
                else:
                    self._json(200, convert_pdf(content, filename))
                return
            if self.path == "/api/figure-text":
                # Figure images are larger than ordinary JSON; only this route raises the cap.
                data = self._read_json(MAX_FIGURE_REQUEST_BYTES)
                with models.PROVIDER_LOCK:
                    provider = models.PROVIDERS.get(str(data.get("providerId") or ""))
                    provider = dict(provider) if provider else None
                if not provider:
                    raise RequestError("模型连接已失效；请重新添加连接。")
                image = models.validate_figure_image(data.get("image"))
                page = data.get("page")
                if not isinstance(page, int) or isinstance(page, bool) or page < 1:
                    raise RequestError("图片页码无效。")
                self._json(200, {"text": models._figure_text_call(provider, image, page)})
                return
            data = self._read_json(2*1024*1024) if self.path.startswith("/api/pdf-review") else self._read_json()
            if self.path == "/api/pdf-review":
                self._json(202, {"jobId":native.start_job(data)}); return
            if self.path.startswith("/api/pdf-review/"):
                try:native.job_status(self.path.rsplit("/",1)[-1])
                except RequestError as exc:
                    self._json(404,{"error":str(exc)});return
                native.control_job(self.path.rsplit("/",1)[-1],data.get("action"))
                self._json(200, {"ok":True}); return
            if self.path == "/api/providers":
                name = models._safe_text(data.get("name"), 48)
                model = models._safe_text(data.get("model"), 120)
                api_key = str(data.get("apiKey") or "").strip()
                base_url = models.normalize_base_url(data.get("baseUrl", ""))
                if not name or not model or (api_key and not models.KEY_PATTERN.fullmatch(api_key)) or (not api_key and not models.is_local_url(base_url)):
                    raise RequestError("请检查服务名称、模型名称与连接密钥格式。")
                with models.PROVIDER_LOCK:
                    matches = [item for item in models.PROVIDERS.values() if item["baseUrl"] == base_url and item["model"] == model]
                    if matches:
                        provider_id = matches[0]["id"]
                    else:
                        if len(models.PROVIDERS) >= models.MAX_PROVIDERS:
                            raise RequestError("最多同时连接 3 个模型；请重启本机服务清除连接。")
                        provider_id = secrets.token_urlsafe(12)
                    models.PROVIDERS[provider_id] = {"id": provider_id, "name": name, "baseUrl": base_url, "model": model, "apiKey": api_key}
                    result = models._public_provider(models.PROVIDERS[provider_id])
                self._json(200, {"provider": result})
                return
            if self.path == "/api/evaluate":
                ids = data.get("providerIds")
                if not isinstance(ids, list) or not ids or len(ids) > models.MAX_PROVIDERS or not all(isinstance(item, str) for item in ids) or len(set(ids)) != len(ids):
                    raise RequestError("请从已连接模型中选择 1–3 个。")
                evaluation = models.validate_evaluation(data.get("evaluation"))
                with models.PROVIDER_LOCK:
                    providers = [models.PROVIDERS.get(str(provider_id)) for provider_id in ids]
                    providers = [dict(provider) for provider in providers if provider]
                if len(providers) != len(ids):
                    raise RequestError("模型连接已失效；请重新添加密钥。")
                futures = [models.POOL.submit(models._run_provider, provider, evaluation) for provider in providers]
                results = [future.result(timeout=models.provider_timeout(provider) * 2 + 10) for future, provider in zip(futures, providers)]
                self._json(200, {"results": results, "completedAt": datetime.now(timezone.utc).isoformat()})
                return
            self._json(404, {"error": "未找到本机 API。"})
        except (RequestError, ConversionError) as exc:
            self._json(400, {"error": str(exc)})
        except Exception:
            self._json(500, {"error": "本机代理处理失败；请重试。"})


def main() -> None:
    parser = argparse.ArgumentParser(description="Start the local ESG assessment workbench.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--open-browser", action="store_true")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        raise SystemExit("端口范围须为 1024–65535。")
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as exc:
        raise SystemExit(f"无法启动本机工作台（端口 {args.port}）：{exc}") from None
    server.daemon_threads = True
    url = f"http://127.0.0.1:{args.port}/"
    print(f"智能评估工作台已在本机启动：{url}")
    print("连接密钥只保存在此进程内存；停止服务后会清除。按 Ctrl+C 停止。")
    if args.open_browser:
        webbrowser.open(url + "#/workbench")
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\n正在停止本机工作台…")
    finally:
        with models.PROVIDER_LOCK:
            models.PROVIDERS.clear()
        server.server_close()
        models.POOL.shutdown(wait=False, cancel_futures=True)
        jobs.PDF_POOL.shutdown(wait=False, cancel_futures=True)
        for job in native.JOBS.values(): job["stop"]=True; job["pause"]=False
        native.POOL.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    main()
