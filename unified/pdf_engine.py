"""Method-neutral scheduling; adapters retain their own prompts and verdicts."""
from __future__ import annotations

from .core import LocalError
import io
import math


def estimate_tokens(text):
    ascii_count = sum(ord(c) < 128 for c in text)
    return math.ceil(ascii_count / 3 + (len(text) - ascii_count) * 1.2)


def reading_batches(texts, max_pages=12, *, budget=14000):
    """Shared conservative density policy; no text layer still has a cost."""
    start, used = 1, 0
    for number, text in enumerate(texts, 1):
        cost = estimate_tokens(text) + (500 if text.strip() else 1600)
        if number > start and (used + cost > budget or number - start >= max_pages):
            yield start, number - 1
            start, used = number, 0
        used += cost
    if texts:
        yield start, len(texts)


def label_page(page, number):
    """pypdf 6 request copy; the original PDF bytes remain immutable."""
    from pypdf import PdfWriter, Transformation
    from pypdf.generic import NameObject, DictionaryObject, DecodedStreamObject, ArrayObject
    if page.rotation: page.transfer_rotation_to_content()
    left, bottom = map(float, page.mediabox.lower_left)
    width, height = float(page.mediabox.width), float(page.mediabox.height)
    if left or bottom: page.add_transformation(Transformation().translate(-left, -bottom))
    writer = PdfWriter()
    labelled = writer.add_blank_page(width=width, height=height + 24)
    labelled.merge_page(page)
    resources = labelled[NameObject('/Resources')]
    if '/Font' not in resources: resources[NameObject('/Font')] = DictionaryObject()
    resources[NameObject('/Font')][NameObject('/SourcePhysicalPage')] = DictionaryObject({
        NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
    stream = DecodedStreamObject()
    stream.set_data(f'q 0 0 0 rg BT /SourcePhysicalPage 12 Tf 8 {height+7:g} Td (Source PDF physical page {number}) Tj ET Q'.encode('ascii'))
    contents = labelled.get('/Contents')
    if contents is not None:
        contents = contents.get_object()
    streams = list(contents) if isinstance(contents, ArrayObject) else [contents] if contents is not None else []
    labelled[NameObject('/Contents')] = ArrayObject([writer._add_object(item.get_object()) for item in [*streams, stream]])
    return labelled


def request_pdf(raw, start, end):
    from pypdf import PdfReader, PdfWriter
    reader, writer = PdfReader(io.BytesIO(raw), strict=False), PdfWriter()
    if not 1 <= start <= end <= len(reader.pages): raise LocalError('请求物理页段无效。')
    for number in range(start, end + 1): writer.add_page(label_page(reader.pages[number - 1], number))
    stream = io.BytesIO(); writer.write(stream)
    return stream.getvalue()


def preflight_ranges(ranges):
    """One-based inclusive ranges, with physical page 1 checked first exactly once."""
    ranges = list(ranges)
    if not ranges:
        return []
    if ranges[0][0] != 1:
        raise LocalError('阅读计划必须从物理第1页开始。')
    result = [(1, 1)]
    for start, end in ranges:
        if start <= 1 <= end:
            start = 2
        if start <= end:
            result.append((start, end))
    expected = 1
    for start, end in result:
        if start != expected or end < start:
            raise LocalError('阅读计划存在重复或缺页。')
        expected = end + 1
    return result


def evidence_windows(entries, fits):
    """Every entry is scheduled, with the full method included in each fit check."""
    if not fits([]):
        raise LocalError('完整方法本身超过输入预算；未截断方法。')
    windows, current = [], []
    for entry in entries:
        if not fits([entry]):
            raise LocalError('完整方法或单条证据超过输入预算；未截断内容。')
        if current and not fits(current + [entry]):
            windows.append(current)
            current = []
        current.append(entry)
    if current or not windows:
        windows.append(current)
    return windows


def reduce_windows(windows, evaluate, merge, checkpoint=lambda: None):
    """No final result exists unless every window and merge completed successfully."""
    nodes = []
    for index, window in enumerate(windows):
        checkpoint()
        nodes.append(evaluate(window, index, len(windows)))
    while len(nodes) > 1:
        combined = []
        for index in range(0, len(nodes), 2):
            checkpoint()
            pair = nodes[index:index + 2]
            combined.append(pair[0] if len(pair) == 1 else merge(pair, len(nodes) == 2))
        nodes = combined
    return nodes[0]
