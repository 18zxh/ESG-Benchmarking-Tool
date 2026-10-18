"""Independent quote anchors from PDF bytes, with a bounded in-memory cache."""
from collections import OrderedDict
import io
import threading

import pdfplumber

if __package__:
    from .pdf_conversion import convert_pdf, ConversionError, _ocr_reading
else:
    from pdf_conversion import convert_pdf, ConversionError, _ocr_reading

_CACHE = OrderedDict()
_LOCK = threading.RLock()
_MAX_CHARS = 32 * 1024 * 1024


def cache_ready(sha):
    with _LOCK:
        return sha in _CACHE


def _remember(sha, pages):
    with _LOCK:
        _CACHE[sha] = pages
        _CACHE.move_to_end(sha)
        while len(_CACHE) > 6 or sum(len(b['text']) for p in _CACHE.values() for row in p for b in row) > _MAX_CHARS:
            _CACHE.popitem(last=False)


def _text_variants(raw):
    pages = []
    with pdfplumber.open(io.BytesIO(raw)) as pdf:
        for page in pdf.pages:
            variants = []
            def add(kind, text):
                text = (text or '').strip()
                if text and not any(b['text'] == text for b in variants):
                    variants.append({'kind': kind, 'text': text, 'requiresReview': False})
            # Keep each ordering separate: a quote must never cross variants.
            if page.width > page.height * 1.3:
                for side, bounds in [('left', (page.bbox[0], page.bbox[1], page.bbox[0] + page.width / 2, page.bbox[3])),
                                     ('right', (page.bbox[0] + page.width / 2, page.bbox[1], page.bbox[2], page.bbox[3]))]:
                    add(side, page.crop(bounds).extract_text())
            add('text-flow', page.extract_text(use_text_flow=True))
            add('text-layer', page.extract_text())
            pages.append(variants)
            page.close()
    return pages


def remember_conversion(raw, result):
    """Accept only a server-created parse of these exact bytes, never client text."""
    import hashlib
    sha = hashlib.sha256(raw).hexdigest()
    meta = result['meta']
    if meta.get('originalSha256') != sha:
        raise ConversionError('引文定位与原 PDF 指纹不一致。')
    pages = _text_variants(raw)
    if len(pages) != len(meta['pages']):
        raise ConversionError('引文定位与原 PDF 页数不一致。')
    for index, parsed in enumerate(meta['pages']):
        row = pages[index]
        for block in parsed.get('blocks', []):
            if block.get('type') in {'text', 'layout-text'}:
                text = block.get('text', '').strip()
                if text and not any(b['text'] == text for b in row):
                    row.append({'kind': 'pdfkit-text', 'text': text, 'requiresReview': False})
        observations = parsed.get('ocrObservations', [])
        # OCR is a source locator, not proof of correct recognition. Preserve
        # its provenance and require original-image review for every OCR quote.
        for region in ('left', 'right', 'full'):
            subset = [o for o in observations if o.get('region') == region]
            if not subset:
                continue
            text = _ocr_reading(subset, float(parsed['width']), float(parsed['height'])).strip()
            if text and not any(b['text'] == text for b in row):
                row.append({'kind': 'image-ocr-' + region, 'text': text, 'requiresReview': True})
    _remember(sha, pages)
    return pages


def quote_pages(raw, sha, filename):
    with _LOCK:
        cached = _CACHE.get(sha)
        if cached is not None:
            _CACHE.move_to_end(sha)
            return cached
    # Restored browser projects may outlive the local service. Rebuild anchors
    # from the actual PDF instead of trusting the backup's extracted text.
    return remember_conversion(raw, convert_pdf(raw, filename))
