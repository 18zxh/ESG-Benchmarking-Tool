"""Conservative density scheduling and lossless JSON context budgets."""
import json
import math
from pipeline.errors import RequestError

READ_BUDGET = 14000
INPUT_BUDGET = 12000
MERGE_BUDGET = 28000
PDF_BATCH_BYTES = 6 * 1024 * 1024
MAX_REFERENCES = 8
SYSTEM_RESERVE = 2200


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def estimate_tokens(value):
    text = value if isinstance(value, str) else encoded(value)
    ascii_count = sum(ord(c) < 128 for c in text)
    return math.ceil(ascii_count / 3 + (len(text) - ascii_count) * 1.2)


def reading_batches(pages, max_pages=12):
    start, used = 1, 0
    for number, page in enumerate(pages, 1):
        text = page.get("text", "")
        cost = estimate_tokens(text) + (500 if text.strip() else 1600)
        if number > start and (used + cost > READ_BUDGET or number - start >= max_pages):
            yield start, number - 1
            start, used = number, 0
        used += cost
    if pages:
        yield start, len(pages)


def fits(value, budget=INPUT_BUDGET):
    return estimate_tokens(value) + SYSTEM_RESERVE <= budget


def evidence_windows(base, topic):
    """Keep the complete question/method in every request; never trim evidence tails."""
    current, windows = [], []
    def guide(items):
        return {**base, "topics": [{**topic, "evidence": items}]}
    if not fits(guide([])):
        raise RequestError("完整指标条文与方法超过输入预算，请拆分指标方法后重试；未截断原文。", "context_budget")
    for item in topic["evidence"]:
        if current and not fits(guide(current + [item])):
            windows.append(current)
            current = []
        if not fits(guide(current + [item])):
            raise RequestError("单条证据及完整方法超过输入预算，未截断原文。", "context_budget")
        current.append(item)
    return windows + [current] if current or not windows else windows
