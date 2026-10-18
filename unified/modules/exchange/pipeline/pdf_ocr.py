"""Optional local macOS Vision OCR; failure leaves pages explicitly unreadable."""
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

_LOCK = threading.Lock()
ROOT = Path(__file__).resolve().parents[1]


def recognize_page(content, number):
    if sys.platform != "darwin":
        return ""
    binary = ROOT / ".runtime" / "pdf-text-ocr"
    with _LOCK:
        if not binary.is_file():
            binary.parent.mkdir(exist_ok=True)
            subprocess.run(["/usr/bin/clang", "-fobjc-arc", "-O2", str(ROOT / "pipeline/pdf_convert.m"), "-framework", "Foundation", "-framework", "AppKit", "-framework", "PDFKit", "-framework", "Vision", "-o", str(binary)], check=True, capture_output=True, timeout=90)
    with tempfile.TemporaryDirectory(prefix="exchange-ocr-") as directory:
        path = Path(directory) / "source.pdf"
        path.write_bytes(content)
        result = subprocess.run([str(binary), str(path), str(number)], check=True, capture_output=True, timeout=45)
        return result.stdout.decode("utf-8").strip()
