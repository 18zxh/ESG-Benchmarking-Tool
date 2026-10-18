"""Bounded, in-memory local PDF jobs; no report text is written to logs."""
from concurrent.futures import ThreadPoolExecutor
import secrets, threading, time
try:
    from .errors import RequestError
    from .pdf_conversion import convert_pdf, ConversionError
except ImportError:
    from errors import RequestError
    from pdf_conversion import convert_pdf, ConversionError
PDF_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="pdf-reading")
PDF_JOBS = {}
PDF_JOB_LOCK = threading.Lock()

def _expire_pdf_jobs():
    now = time.monotonic()
    for job_id, job in list(PDF_JOBS.items()):
        if job["status"] in {"completed", "failed"} and now - job["updated"] > 300:
            del PDF_JOBS[job_id]


def _parse_pdf_job(job_id, content, filename):
    def progress(value):
        with PDF_JOB_LOCK:
            job = PDF_JOBS[job_id]
            job.update(phase=value.get("phase", "逐页识别"), completed=value.get("completed", 0), total=value.get("total", 0), updated=time.monotonic())
    try:
        result = convert_pdf(content, filename, progress)
        with PDF_JOB_LOCK:
            PDF_JOBS[job_id].update(status="completed", result=result, phase="解析完成", updated=time.monotonic())
    except ConversionError as exc:
        with PDF_JOB_LOCK:
            PDF_JOBS[job_id].update(status="failed", error=str(exc), updated=time.monotonic())
    except Exception:
        with PDF_JOB_LOCK:
            PDF_JOBS[job_id].update(status="failed", error="PDF 解析失败，请检查报告是否损坏或重新初始化识别环境。", updated=time.monotonic())


def create_pdf_job(content, filename):
    if not content.startswith(b"%PDF-"):
        raise RequestError("文件不是有效的 PDF。")
    with PDF_JOB_LOCK:
        _expire_pdf_jobs()
        if any(job["status"] == "running" for job in PDF_JOBS.values()):
            raise RequestError("已有报告正在解析，请等待完成后再上传。")
        # Only retain bounded recent results in memory; private reports never enter logs.
        if len(PDF_JOBS) >= 3:
            oldest = min(PDF_JOBS, key=lambda key: PDF_JOBS[key]["updated"])
            del PDF_JOBS[oldest]
        job_id = secrets.token_urlsafe(24)
        PDF_JOBS[job_id] = {"status":"running", "phase":"准备逐页识别", "completed":0, "total":0, "updated":time.monotonic()}
        PDF_POOL.submit(_parse_pdf_job, job_id, content, filename)
    return job_id
