"""Original PDF text-flow context supplements interleaved spatial excerpts."""
import io
from contextvars import ContextVar
import json
import threading

import pdfplumber

from .core import ACTIVE


def install_csa(native):
    documents = ContextVar('csa_source_flow_documents', default={})
    original_evaluate, original_payload, original_key = native.evaluate, native._assessment_payload, native._result_cache_key
    original_decode = native._decode_document

    def decode(item):
        document, raw, count = original_decode(item)
        # Upstream clears fileData after verification to release base64 memory.
        # Retain the same validated byte object only until assessment finishes.
        doc = documents.get().get(document['id'])
        if doc is not None:
            doc['bytes'] = raw
        return document, raw, count

    def evaluate(value, provider, *args, **kwargs):
        items = value.get('documents')
        inventory = {item.get('id'):{'pages':{}} for item in items if isinstance(item,dict) and isinstance(item.get('id'),str)} if isinstance(items,list) else {}
        token = documents.set(inventory)
        try:
            return original_evaluate(value, provider, *args, **kwargs)
        finally:
            documents.reset(token)

    def payload(provider, questions, evidence_by_question, project):
        result = original_payload(provider, questions, evidence_by_question, project)
        pages = {}
        for question in questions:
            for entry in evidence_by_question.get(question['id'], []):
                doc = documents.get().get(entry['reportId'])
                identity = (entry['reportId'], entry['page'])
                if not doc or 'bytes' not in doc or identity in pages:
                    continue
                number = entry['page']
                if number not in doc['pages']:
                    with pdfplumber.open(io.BytesIO(doc['bytes'])) as pdf:
                        doc['pages'][number] = pdf.pages[number-1].extract_text(use_text_flow=True) or ''
                if doc['pages'][number].strip():
                    pages[identity] = {'reportId':entry['reportId'], 'source':entry['source'],
                        'physicalPage':number, 'text':doc['pages'][number]}
        if pages:
            result['messages'][0]['content'] += '\nsource_page_text是同一原PDF的文字流，补充跨栏上下文。须区分不同角色、分母、期间及指标；相邻数字不能套到另一角色。只引用输入证据编号，不能自行推算或修改报告精度。'
            result['messages'][1]['content'] += '\nsource_page_text：' + json.dumps(list(pages.values()), ensure_ascii=False)
        return result

    native.evaluate, native._assessment_payload = evaluate, payload
    native._decode_document = decode
    native._result_cache_key = lambda *a, **kw: native.runtime.fingerprint(['csa-source-flow-v2', original_key(*a, **kw)])


def install(native):
    original = native.context.request_payload
    lock = threading.RLock()

    def document(entry):
        with native.LOCK:
            run = ACTIVE.get()
            job = native.JOBS.get(run.job_id) if run else None
            if job:
                for item in job.get('documents', []):
                    doc = native.DOCUMENTS.get(item['id'])
                    if doc and item['source'] == entry['source'] and doc['name'] == entry['filename']:
                        return doc
            matches = [doc for doc in native.DOCUMENTS.values() if doc['name'] == entry['filename']]
        return matches[0] if len(matches) == 1 else None

    def payload(criteria, evidence, project, reviews=None):
        value = original(criteria, evidence, project, reviews)
        pages = {}
        for entry in evidence:
            identity = (entry['source'], entry['filename'], entry['pdfPage'])
            if identity in pages:
                continue
            doc = document(entry)
            if not doc:
                continue  # Never guess between same-name originals.
            with lock:
                texts = doc.setdefault('_sourceFlow', {})
                number = entry['pdfPage']
                if number not in texts:
                    with pdfplumber.open(io.BytesIO(doc['bytes'])) as pdf:
                        texts[number] = pdf.pages[number - 1].extract_text(use_text_flow=True) or ''
                text = texts[number]
            if text.strip():
                pages[identity] = {'source': entry['filename'], 'sourceType': entry['source'], 'physicalPage': number,
                    'readingOrder': 'PDF原文字流，补充跨栏上下文；不是模型改写', 'text': text}
        if pages:
            value['source_page_text'] = list(pages.values())
        return value

    # group_budget/evidence_windows use the same payload builder, so additional
    # source text is budgeted in full; it is never silently clipped to fit.
    native.context.request_payload = payload
