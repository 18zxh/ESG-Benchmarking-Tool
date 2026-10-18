"""PDF glyph equivalence for matching, without changing source text or numbers."""
from pathlib import Path
import re
import unicodedata


def _radical_equivalents():
    # Pinned Unicode 17 data; only CJK radicals, not the separate strokes block.
    mapping = {}
    for line in Path(__file__).with_name("unicode-equivalents.txt").read_text(encoding="utf-8").splitlines():
        fields = line.split("#", 1)[0].strip()
        if not fields:
            continue
        source, target = (part.strip() for part in fields.split(";"))
        first, _, last = source.partition("..")
        for point in range(int(first, 16), int(last or first, 16) + 1):
            if 0x2E80 <= point <= 0x2FD5:
                mapping[point] = int(target, 16)
    return mapping


_RADICALS = _radical_equivalents()


def normalize_pdf_text(text):
    return unicodedata.normalize("NFKC", text).translate(_RADICALS)


def quote_key(text):
    return re.sub(r"[\s\x00-\x1f\x7f]+", "", normalize_pdf_text(text))


def contains_pdf_quote(source, quote):
    key = quote_key(quote)
    return bool(key) and key in quote_key(source)
