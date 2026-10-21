"""Resolve temporary model evidence aliases before summaries are merged.

E1 in one window is a different excerpt from E1 in the next. Free-text
references must become stable file/physical-page citations at that boundary.
Structured evidence IDs and original quote strings are never rewritten.
"""
from copy import deepcopy
import json
import re
import unicodedata

FIELDS = ('disclosure', 'missing', 'recommendation', 'reason')
ALIASES = re.compile(r'(?<![A-Za-z0-9_])E([1-9]\d*)(?:\s*[-–—]\s*E?([1-9]\d*))?(?![A-Za-z0-9_])')


def company_number_text(value):
    """Treat Chinese emission-scope lists as labels, not measurements.

    Only the checker sees this form; original prose and quotations stay intact.
    Quantities following the labels remain available to the unchanged parser.
    """
    text = unicodedata.normalize('NFKC', value)
    return re.sub(r'(?:范围|scopes?)\s*[123](?:\s*(?:[/、,&及和与-]|以及|and)\s*(?:(?:范围|scopes?)\s*)?[123])+(?![\d.]|\s*%)',
        '排放范围分类', text, flags=re.I)


def normalize(value, request):
    try:
        guide = json.loads(request)
    except (ValueError, TypeError):
        return value
    if not isinstance(guide, dict) or not isinstance(guide.get('criteria'), list) or not isinstance(guide.get('evidence'), list):
        return value
    sources = {e['id']: e for e in guide['evidence']}
    if not isinstance(value, dict) or not isinstance(value.get('results'), list):
        return value
    result = deepcopy(value)

    def citation(match):
        start, end = int(match[1]), int(match[2] or match[1])
        if not 1 <= start <= end <= len(sources):
            raise ValueError('说明文字引用了本次输入之外的证据编号；请只在evidence_ids填写有效来源，说明文字不写临时E编号。')
        grouped = {}
        for i in range(start, end + 1):
            source = sources.get(f'E{i}')
            if not source:
                raise ValueError('说明文字的临时证据编号无法核对。')
            pages = grouped.setdefault(source['source'], [])
            if source['page'] not in pages:
                pages.append(source['page'])
        return '【' + '；'.join(f'{name} · PDF物理页' + '、'.join(map(str, pages)) for name, pages in grouped.items()) + '】'

    for row in result['results']:
        if not isinstance(row, dict):
            continue
        for field in FIELDS:
            if isinstance(row.get(field), str):
                parts = re.split(r'(【[^】]*PDF物理页[^】]*】)', row[field])
                row[field] = ''.join(part if i % 2 else ALIASES.sub(citation, part) for i, part in enumerate(parts))
        if row.get('status') == 'not_found' and isinstance(row.get('disclosure'), str) and row['disclosure'].strip() in {'not_found', '未披露', ''}:
            row['disclosure'] = '本次完整读取范围内未找到直接支持该指标的披露。'
    return result
