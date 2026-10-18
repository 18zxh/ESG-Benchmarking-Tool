"""CSA-specific methodology loading; shared storage never imports this module."""
import json
from pathlib import Path
import re
if __package__:
    from .errors import RequestError
else:
    from errors import RequestError
DATA = Path(__file__).resolve().parents[1] / 'site' / 'data'
MAX_QUESTIONS = 160

def read_questions(ids: object, project: dict) -> list[dict]:
    industry = str(project.get('industry', ''))
    if not re.fullmatch(r'[A-Z]{3}', industry) or project.get('version') != 'Full' or project.get('methodYear') != 2026:
        raise RequestError('本版原生 PDF 初评仅使用 2026 Full 方法。')
    if (not isinstance(ids, list) or not 1 <= len(ids) <= MAX_QUESTIONS
            or len(set(map(str, ids))) != len(ids)):
        raise RequestError(f'每次最多选择 {MAX_QUESTIONS} 个不同问题。')
    try:
        source = json.loads((DATA / ('questions-' + industry + '.json')).read_text())
        primary = json.loads((DATA / 'question-primary.json').read_text())
        translations = json.loads((DATA / 'question-translations.json').read_text()).get('translations', {})
        industries = json.loads((DATA / 'industries.json').read_text())
    except (OSError, ValueError):
        raise RequestError('对应行业的方法来源无法读取。') from None
    industry_meta = next((item for item in industries if item.get('code') == industry), None)
    if not industry_meta:
        raise RequestError('对应行业的方法来源无法读取。')
    fields = _assessment_method_fields()
    questions = {q['id']: q for q in source}
    result = []
    for qid in ids:
        q = questions.get(qid)
        if (not q or not q.get('enabled') or q.get('weight', 0) <= 0 or q.get('year') != 2026
                or not q.get('guidanceExtracted') or not q.get('methodologyTextComplete') or q.get('excerptTruncated')
                or q.get('dimension') == 'Company Information' or q.get('criterion') == '公司基本信息'
                or primary.get('overrides', {}).get(qid, {}).get('status') == 'exclude'
                or not q.get('layout') or not q.get('guidance')):
            raise RequestError('选题缺少可启用的方法依据：' + str(qid))
        enriched = dict(q)
        enriched['_methodFields'] = fields
        enriched['industryCode'] = industry_meta['code']
        enriched['industryEn'] = industry_meta['name']
        enriched['industryZh'] = industry_meta['zh']
        for key, source_field, translation_field in fields:
            if translation_field:
                enriched[key] = translations.get(translation_field, {}).get(enriched.get(source_field), '')
            else:
                enriched[key] = enriched.get(source_field, '')
        result.append(enriched)
    return result


def _assessment_method_fields() -> tuple[tuple[str, str, str], ...]:
    try:
        schema = json.loads((DATA / 'assessment-method-schema.json').read_text())
        fields = schema.get('fields', [])
        records = [(str(field['key']), str(field['source']), str(field.get('translation', '')))
                   for field in fields if isinstance(field, dict)]
        keys = [record[0] for record in records]
        if (schema.get('schema') != 1 or not records or len(records) != len(fields)
                or len(keys) != len(set(keys)) or any(not key or not source for key, source, _ in records)):
            raise ValueError('invalid schema')
        return tuple(records)
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        raise RequestError('AI 方法字段清单缺失或格式错误。') from None


def _assessment_method_record(question: dict) -> dict:
    record = {}
    for key, source, translation in question.get('_methodFields') or _assessment_method_fields():
        value = question.get(key, '') if translation else question.get(source, '')
        record[key] = '' if value is None else value
    return record


class CSAAdapter:
    namespace = 'csa'
    contract_version = '2026-full-method-v1'
    load_methods = staticmethod(read_questions)
    canonical_method = staticmethod(_assessment_method_record)

ADAPTER = CSAAdapter()
