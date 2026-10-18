"""Conservative local context estimates and lossless request packing.

Estimates are scheduling budgets, never provider token counts. Requirements and
evidence are split into more requests rather than clipped to fit a request.
"""
import json, math

INPUT_BUDGET = 12000
MERGE_BUDGET = 28000
READ_BUDGET = 14000
PDF_BATCH_BYTES = 6 * 1024 * 1024
MAX_REFERENCES = 8
SYSTEM_RESERVE = 2200

class ContextBudgetError(ValueError):
    pass

def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))

def estimate_tokens(value):
    text = value if isinstance(value, str) else encoded(value)
    ascii_count = sum(ord(c) < 128 for c in text)
    return math.ceil(ascii_count / 3 + (len(text) - ascii_count) * 1.2)

def reading_batches(texts, max_pages=12):
    start, used = 1, 0
    for page, text in enumerate(texts, 1):
        cost = estimate_tokens(text) + (500 if text.strip() else 1600)
        if page > start and (used + cost > READ_BUDGET or page - start >= max_pages):
            yield start, page - 1
            start, used = page, 0
        used += cost
    if texts:
        yield start, len(texts)

def shared_requirements(methods):
    """Move identical fields to shared; expanding restores every original field."""
    common = {}
    if len(methods) > 1:
        for key, value in methods[0].items():
            if key != 'id' and value not in ('', None, []) and all(m.get(key) == value for m in methods):
                common[key] = value
    return common, [{k: v for k, v in m.items() if k not in common} for m in methods]

def request_payload(criteria, evidence, project, reviews=None):
    methods = [{'id':f'C{i+1}', **c['criterion']} for i,c in enumerate(criteria)]
    shared, methods = shared_requirements(methods)
    sent = [{'id':f'E{i+1}', 'page':e['pdfPage'], 'source':e['filename'], 'text':e['text']} for i,e in enumerate(evidence)]
    payload = {'project':project, 'shared':shared, 'criteria':methods, 'evidence':sent}
    if reviews is not None:
        aliases={e['id']:f'E{i+1}' for i,e in enumerate(evidence)}
        payload['window_reviews'] = [{**r,'evidence_refs':[aliases[ref] for ref in r.get('evidence_refs',[]) if ref in aliases]} for r in reviews]
    return payload

def evidence_windows(criteria, evidence, project):
    """Cover each snippet exactly once. Never rank away the unselected tail."""
    if group_budget(criteria, [], project) > INPUT_BUDGET:
        raise ContextBudgetError('完整指标要求超过单批预算；已保留失败，不会截断要求后评估。')
    window = []
    for entry in evidence:
        if group_budget(criteria, window + [entry], project) > INPUT_BUDGET:
            if not window:
                raise ContextBudgetError('单条原文与完整指标要求超过预算，请检查异常长摘录。')
            yield window
            window = []
        window.append(entry)
        if group_budget(criteria, window, project) > INPUT_BUDGET:
            raise ContextBudgetError('单条原文与完整指标要求超过预算，请检查异常长摘录。')
    if window or not evidence:
        yield window

def group_budget(criteria, evidence, project):
    return estimate_tokens(request_payload(criteria, evidence, project)) + SYSTEM_RESERVE
