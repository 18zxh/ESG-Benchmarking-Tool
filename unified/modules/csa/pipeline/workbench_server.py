"""Local HTTP transport, static sources and downloads; services live in separate modules."""
from __future__ import annotations
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import argparse
import io
import json
import re
from pathlib import Path
import secrets
import threading
import time
from urllib.parse import urlsplit, unquote, quote
import webbrowser
if __package__:
    from . import model_proxy as model_service
    from . import pdf_jobs as jobs
    from . import native_pdf
    from . import native_pdf_jobs
    from . import pdf_quotes
    from .errors import RequestError
    from .pdf_conversion import convert_pdf, ConversionError, MAX_PDF_BYTES
else:
    import model_proxy as model_service
    import pdf_jobs as jobs
    import native_pdf
    import native_pdf_jobs
    import pdf_quotes
    from errors import RequestError
    from pdf_conversion import convert_pdf, ConversionError, MAX_PDF_BYTES

ROOT = Path(__file__).resolve().parents[1]
SITE = (ROOT / "site").resolve()
DEFAULT_PORT = 8781
APP_ID = "csa-pdf-workbench"
MAX_REQUEST_BYTES = 512 * 1024
EXPORTS = {}
EXPORT_LOCK = threading.Lock()
MAX_EXPORT_BYTES = 80 * 1024 * 1024


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

    def _read_json(self, limit=MAX_REQUEST_BYTES) -> dict:
        length_text = self.headers.get("Content-Length", "")
        if not length_text.isdigit():
            raise RequestError("请求内容长度无效。")
        length = int(length_text)
        if length < 1 or length > limit:
            raise RequestError("请求内容为空或超过本接口的大小限制。")
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
            with model_service.PROVIDER_LOCK:
                providers = [{**model_service._public_provider(item), 'nativePdf': True}
                             for item in model_service.PROVIDERS.values() if native_pdf.supports_pdf(item)]
            self._json(200, {"ok": True, "providers": providers, "mode": "local-only", "version": 6, "appId": APP_ID, "pdfConversion": "local-text-image-tables", "nativePdf": True})
            return
        if self.path.startswith('/api/exports/'):
            key=urlsplit(self.path).path.rsplit('/',1)[-1]
            with EXPORT_LOCK:
                item=EXPORTS.get(key)
            if not item or time.monotonic()-item['created']>600:
                self._json(404,{'error':'下载链接已过期，请重新生成导出文件。'})
                return
            self.send_response(200)
            self.send_header('Content-Type',item['type'])
            self.send_header('Content-Disposition',"attachment; filename=\"CSA-export."+item['extension']+"\"; filename*=UTF-8''"+quote(item['filename']))
            self.send_header('Content-Length',str(len(item['bytes'])))
            self.end_headers()
            self.wfile.write(item['bytes'])
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
        if self.path.startswith('/api/native-pdf-jobs/'):
            if not self._origin_allowed():
                self._json(403, {'error': '请求来源未通过本机校验。'})
                return
            job_id = urlsplit(self.path).path.rsplit('/', 1)[-1]
            value = native_pdf_jobs.status(job_id)
            self._json(200 if value else 404, value or {'error': 'GLM PDF 任务已过期，请重新运行。'})
            return
        if self.path.startswith('/api/pdf-quotes/'):
            sha = urlsplit(self.path).path.rsplit('/', 1)[-1]
            if not self._origin_allowed() or not re.fullmatch(r'[0-9a-f]{64}', sha):
                self._json(400, {'error': '引文定位请求无效。'})
                return
            self._json(200, {'ready': pdf_quotes.cache_ready(sha)})
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
            if self.path.startswith('/api/native-pdf-jobs/') and self.path.endswith('/control'):
                body = self._read_json(2048)
                native_pdf_jobs.control(self.path.split('/')[-2], body.get('action'))
                self._json(200, {'ok': True})
                return
            if self.path == '/api/native-pdf-cache/clear':
                native_pdf_jobs.clear_cache()
                self._json(200, {'cleared': True})
                return
            if self.path == '/api/evaluate-pdf':
                value = self._read_json(native_pdf.MAX_REQUEST_BYTES)
                with model_service.PROVIDER_LOCK:
                    stored = model_service.PROVIDERS.get(value.get('providerId'))
                    provider = dict(stored) if stored else None
                if not provider:
                    raise RequestError('模型连接已失效；请在模型连接设置重新填写密钥。')
                if not native_pdf.supports_pdf(provider):
                    raise RequestError('仅支持智谱 GLM-5.3-Flash 系列与官方 PDF 接口。')
                job_id = native_pdf_jobs.create(value, provider)
                self._json(202, {'jobId': job_id, 'status': 'queued'})
                return
            if self.path=='/api/export-file':
                length=self.headers.get('Content-Length','')
                if not length.isdigit() or not 1<=int(length)<=MAX_EXPORT_BYTES:
                    raise RequestError('导出文件为空或超过 80 MB。')
                name=unquote(self.headers.get('X-File-Name','')).replace('\\','/').split('/')[-1][:220]
                extension=name.rsplit('.',1)[-1].lower()
                if extension not in {'xlsx','json'}:
                    raise RequestError('仅支持 Excel 或 JSON 项目备份。')
                body=self.rfile.read(int(length))
                if extension=='xlsx' and not body.startswith(b'PK\x03\x04'):
                    raise RequestError('Excel 文件格式无效。')
                if extension=='json':
                    try: json.loads(body)
                    except (ValueError,UnicodeDecodeError):raise RequestError('项目 JSON 无效。') from None
                with EXPORT_LOCK:
                    now=time.monotonic()
                    for key in list(EXPORTS):
                        if now-EXPORTS[key]['created']>600:del EXPORTS[key]
                    if len(EXPORTS)>=5:del EXPORTS[min(EXPORTS,key=lambda k:EXPORTS[k]['created'])]
                    key=secrets.token_urlsafe(24)
                    EXPORTS[key]={'bytes':body,'filename':name,'extension':extension,'created':now,'type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' if extension=='xlsx' else 'application/json; charset=utf-8'}
                self._json(200,{'url':'/api/exports/'+key,'filename':name})
                return
            if self.path=='/api/render-pdf-page':
                length=self.headers.get('Content-Length','')
                page_text=self.headers.get('X-PDF-Page','')
                if not length.isdigit() or not 1<=int(length)<=MAX_PDF_BYTES:
                    raise RequestError('原 PDF 为空或超过 80 MB。')
                if not page_text.isdigit() or not 1<=int(page_text)<=10000:
                    raise RequestError('请输入有效的 PDF 物理页码。')
                if self.headers.get('Content-Type','').split(';')[0].lower()!='application/pdf':
                    raise RequestError('原页预览只接受 PDF。')
                content=self.rfile.read(int(length))
                if not content.lstrip().startswith(b'%PDF-'):
                    raise RequestError('文件不是可识别的 PDF。')
                try:
                    import pdfplumber
                    with pdfplumber.open(io.BytesIO(content)) as document:
                        page=int(page_text)
                        if page>len(document.pages):
                            raise RequestError('页码超出原 PDF 范围。')
                        sheet=document.pages[page-1]
                        if sheet.width*sheet.height*(120/72)**2>16000000:
                            raise RequestError('原页尺寸过大，请打开完整原 PDF 对照。')
                        preview=sheet.to_image(resolution=120).original
                        buffer=io.BytesIO()
                        preview.save(buffer,format='PNG')
                        body=buffer.getvalue()
                except RequestError:
                    raise
                except Exception:
                    raise RequestError('无法生成原页预览；请确认 PDF 未加密，或打开完整原文件。') from None
                self.send_response(200)
                self.send_header('Content-Type','image/png')
                self.send_header('Content-Length',str(len(body)))
                self.send_header('Cache-Control','no-store')
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path in {"/api/convert-pdf", "/api/parse-pdf"}:
                length_text = self.headers.get("Content-Length", "")
                if not length_text.isdigit() or not 1 <= int(length_text) <= MAX_PDF_BYTES:
                    raise RequestError("PDF 为空、长度无效或超过 80 MB。")
                if self.headers.get("Content-Type", "").split(";")[0].lower() != "application/pdf":
                    raise RequestError("此接口只接受 PDF 文件。")
                filename = unquote(self.headers.get("X-File-Name", "report.pdf"))
                filename = filename.replace("\\", "/").split("/")[-1][:200]
                if not filename.lower().endswith(".pdf"):
                    raise RequestError("PDF 文件名须以 .pdf 结尾。")
                content = self.rfile.read(int(length_text))
                if self.path == "/api/parse-pdf":
                    self._json(202, {"jobId":jobs.create_pdf_job(content, filename)})
                else:
                    self._json(200, convert_pdf(content, filename))
                return
            data = self._read_json()
            if self.path == "/api/providers":
                name = model_service._safe_text(data.get("name"), 48)
                model = model_service._safe_text(data.get("model"), 120)
                api_key = str(data.get("apiKey") or "").strip()
                base_url = model_service.normalize_base_url(data.get("baseUrl", ""))
                if not name or not model or (api_key and not model_service.KEY_PATTERN.fullmatch(api_key)) or (not api_key and not model_service.is_local_url(base_url)):
                    raise RequestError("请检查服务名称、模型名称与连接密钥格式。")
                if not native_pdf.supports_pdf({'baseUrl': base_url, 'model': model}):
                    raise RequestError('本工作台仅连接智谱 GLM-5.3-Flash 系列；请使用智谱或 Z.ai 官方 HTTPS 接口。')
                with model_service.PROVIDER_LOCK:
                    matches = [item for item in model_service.PROVIDERS.values() if item["baseUrl"] == base_url and item["model"] == model]
                    if matches:
                        provider_id = matches[0]["id"]
                    else:
                        if len(model_service.PROVIDERS) >= model_service.MAX_PROVIDERS:
                            raise RequestError("最多同时连接 3 个模型；请重启本机服务清除连接。")
                        provider_id = secrets.token_urlsafe(12)
                    model_service.PROVIDERS[provider_id] = {"id": provider_id, "name": name, "baseUrl": base_url, "model": model, "apiKey": api_key}
                    saved = model_service.PROVIDERS[provider_id]
                    result = {**model_service._public_provider(saved), 'nativePdf': native_pdf.supports_pdf(saved)}
                self._json(200, {"provider": result})
                return
            if self.path == "/api/evaluate":
                ids = data.get("providerIds")
                if not isinstance(ids, list) or not ids or len(ids) > model_service.MAX_PROVIDERS or not all(isinstance(item, str) for item in ids) or len(set(ids)) != len(ids):
                    raise RequestError("请从已连接模型中选择 1–3 个。")
                evaluation = model_service.validate_evaluation(data.get("evaluation"))
                with model_service.PROVIDER_LOCK:
                    providers = [model_service.PROVIDERS.get(str(provider_id)) for provider_id in ids]
                    providers = [dict(provider) for provider in providers if provider]
                if len(providers) != len(ids):
                    raise RequestError("模型连接已失效；请重新添加密钥。")
                if any(not native_pdf.supports_pdf(provider) for provider in providers):
                    raise RequestError('本工作台仅允许使用智谱 GLM-5.3-Flash 系列模型。')
                futures = [model_service.POOL.submit(model_service._run_provider, provider, evaluation) for provider in providers]
                results = [future.result(timeout=model_service.provider_timeout(provider) * 2 + 10) for future, provider in zip(futures, providers)]
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
        with model_service.PROVIDER_LOCK:
            model_service.PROVIDERS.clear()
        native_pdf_jobs.shutdown()
        server.server_close()
        model_service.POOL.shutdown(wait=False, cancel_futures=True)
        jobs.PDF_POOL.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    main()
