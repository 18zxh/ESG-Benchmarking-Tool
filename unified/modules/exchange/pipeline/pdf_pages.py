"""In-memory PDF documents, asynchronous text parsing and unchanged page previews."""
from __future__ import annotations

import base64
import hashlib
import io
import re
import threading
import uuid
from pathlib import Path
from datetime import datetime, timezone
import pdfplumber
from PyPDF2 import PdfReader, PdfWriter, Transformation
from PyPDF2.generic import NameObject, DictionaryObject, DecodedStreamObject, ArrayObject
from .constants import MAX_PDF_BYTES, MAX_PDF_PAGES
from .errors import RequestError

_PREVIEW_LOCK = threading.Lock()


def clean_filename(value):
    value = str(value or "报告.pdf").replace("\\", "/").split("/")[-1]
    return re.sub(r"[\x00-\x1f\x7f]", "", value)[:240] or "报告.pdf"


def inspect_pdf(content):
    if not isinstance(content, bytes) or len(content) > MAX_PDF_BYTES:
        raise RequestError("PDF 超过单份 30 MB 上限。", "pdf_size", 413)
    if not content.startswith(b"%PDF-"):
        raise RequestError("文件不是有效的 PDF。", "pdf_type")
    try:
        reader = PdfReader(io.BytesIO(content), strict=False)
        if reader.is_encrypted:
            raise RequestError("PDF 已加密，请上传未加密文件。", "pdf_encrypted")
        count = len(reader.pages)
        if not 1 <= count <= MAX_PDF_PAGES:
            raise RequestError("PDF 页数须为 1–500 页。", "pdf_pages")
        return count, hashlib.sha256(content).hexdigest()
    except RequestError:
        raise
    except Exception:
        raise RequestError("PDF 无法打开，可能损坏或格式不受支持。", "pdf_invalid") from None


def label_page(page, number):
    """Label a request copy; the original bytes and physical page remain intact."""
    if page.rotation:
        page.transfer_rotation_to_content()
    left, bottom = map(float, page.mediabox.lower_left)
    width, height = float(page.mediabox.width), float(page.mediabox.height)
    if left or bottom:
        page.add_transformation(Transformation().translate(-left, -bottom))
    writer = PdfWriter()
    labelled = writer.add_blank_page(width=width, height=height + 24)
    labelled.merge_page(page)
    resources = labelled[NameObject("/Resources")]
    if "/Font" not in resources:
        resources[NameObject("/Font")] = DictionaryObject()
    resources[NameObject("/Font")][NameObject("/SourcePageLabel")] = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
    stream = DecodedStreamObject()
    stream.set_data(f"q 0 0 0 rg BT /SourcePageLabel 12 Tf 8 {height + 7:g} Td (Source PDF physical page {number}) Tj ET Q".encode("ascii"))
    existing = labelled.get("/Contents")
    streams = list(existing) if isinstance(existing, ArrayObject) else [existing] if existing is not None else []
    labelled[NameObject("/Contents")] = ArrayObject([writer._add_object(item.get_object()) for item in [*streams, stream]])
    return labelled


def request_pdf(content, start, end):
    reader = PdfReader(io.BytesIO(content), strict=False)
    if not 1 <= start <= end <= len(reader.pages):
        raise RequestError("请求的 PDF 页段无效。", "pdf_page")
    writer = PdfWriter()
    for number in range(start, end + 1):
        writer.add_page(label_page(reader.pages[number - 1], number))
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


class DocumentStore:
    def __init__(self):
        self.documents = {}
        self.jobs = {}
        self.lock = threading.RLock()

    def register(self, content, filename, source="main"):
        if source not in {"main", "annual"}:
            raise RequestError("报告来源须为主报告或年报。", "pdf_source")
        count, fingerprint = inspect_pdf(content)
        document_id = uuid.uuid4().hex
        meta = {"id": document_id, "name": clean_filename(filename), "source": source, "pageCount": count, "sha256": fingerprint, "registeredAt": datetime.now(timezone.utc).isoformat(), "status": "registered"}
        with self.lock:
            self.documents[document_id] = {"meta": meta, "content": content, "pages": None, "parseJobId": None}
        return dict(meta)

    def get(self, document_id):
        with self.lock:
            doc = self.documents.get(document_id)
        if doc is None:
            raise RequestError("原 PDF 已不在服务内存中，请重新上传或恢复草稿。", "document_missing", 404)
        return doc

    def public(self, document_id):
        return dict(self.get(document_id)["meta"])

    def preview(self, document_id, number):
        doc = self.get(document_id)
        if isinstance(number, bool) or not isinstance(number, int) or not 1 <= number <= doc["meta"]["pageCount"]:
            raise RequestError("PDF 物理页号超出原文件范围。", "pdf_page")
        try:
            with pdfplumber.open(io.BytesIO(doc["content"])) as pdf:
                page = pdf.pages[number - 1]
                if not 0 < max(page.width, page.height) <= 12000:
                    raise RequestError("PDF 页面尺寸不受支持。", "pdf_page")
                with _PREVIEW_LOCK:
                    image = page.to_image(resolution=72 * min(2.5, 1800 / max(page.width, page.height))).original
                    buffer = io.BytesIO()
                    image.save(buffer, "PNG")
            return {"documentId": document_id, "source": doc["meta"]["source"], "page": number, "dataUrl": "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")}
        except RequestError:
            raise
        except Exception:
            raise RequestError("原页无法渲染，请检查文件或换一页重试。", "pdf_render") from None

    def parse(self, document_id, asynchronous=True):
        doc = self.get(document_id)
        with self.lock:
            if doc["parseJobId"]:
                return dict(self.jobs[doc["parseJobId"]])
            job_id = uuid.uuid4().hex
            job = {"id": job_id, "documentId": document_id, "status": "in_progress", "processedPages": 0, "pageCount": doc["meta"]["pageCount"], "readablePages": 0, "issues": []}
            doc["parseJobId"] = job_id
            self.jobs[job_id] = job
        if asynchronous:
            threading.Thread(target=self._parse, args=(doc, job), daemon=True, name="pdf-parse").start()
        else:
            self._parse(doc, job)
        return dict(job)

    def _parse(self, doc, job):
        # Local text is a density/quote-check aid, never a prerequisite for native PDF reading.
        pages = []
        try:
            with pdfplumber.open(io.BytesIO(doc["content"])) as pdf:
                for number, page in enumerate(pdf.pages, 1):
                    try:
                        text = page.extract_text() or ""
                    except Exception:
                        text = ""
                    blocks = [{"id": f"p{number}-text", "type": "text", "text": text, "method": "text_layer"}] if text.strip() else []
                    if not text.strip():
                        job["issues"].append({"page": number, "message": "本页无可用文字层，将由 GLM 直接读取原 PDF。"})
                    pages.append({"page": number, "text": text, "blocks": blocks})
                    with self.lock:
                        job["processedPages"] = number
                        job["readablePages"] += bool(text.strip())
        except Exception:
            job["issues"].append({"message": "本机文字提取未完成，将由 GLM 直接读取原 PDF。"})
        # A failed helper extractor must not discard readable original pages or invoke local OCR.
        by_page = {p["page"]: p for p in pages}
        with self.lock:
            doc["pages"] = [by_page.get(n, {"page": n, "text": "", "blocks": []}) for n in range(1, job["pageCount"] + 1)]
            doc["meta"]["status"] = "parsed"
            job.update(status="success", processedPages=job["pageCount"], hasUnreadablePages=job["readablePages"] < job["pageCount"], localTextOnly=True)

    def parse_status(self, job_id):
        with self.lock:
            if job_id not in self.jobs:
                raise RequestError("解析任务不存在。", "job_missing", 404)
            return dict(self.jobs[job_id])

    def parsed(self, document_id):
        doc = self.get(document_id)
        if doc["pages"] is None:
            raise RequestError("请等待本机 PDF 解析完成。", "parse_required", 409)
        return doc


DOCUMENTS = DocumentStore()
