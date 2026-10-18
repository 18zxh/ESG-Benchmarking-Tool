"""HKEX Appendix C2 application; fiscal year starts, not publication years."""
import copy
from datetime import date
from pipeline.errors import RequestError

CATEGORIES = ('largecap', 'mainboard', 'gem')

def hk_context(data):
    category, start = data.get('issuerCategory'), data.get('fiscalYearStart')
    if category not in CATEGORIES:
        raise RequestError('请选择港交所发行人类别。')
    try:
        fiscal = date.fromisoformat(start)
    except (TypeError, ValueError):
        raise RequestError('请填写有效的财政年度开始日期。') from None
    if fiscal < date(2025, 1, 1):
        raise RequestError('当前港交所规则适用于2025年1月1日或之后开始的财政年度。')
    if data.get('board') != ('GEM' if category == 'gem' else '主板'):
        raise RequestError('港交所发行人类别与上市板块不一致。')
    return category, fiscal

def apply_hk_rules(rules, context):
    category, fiscal = hk_context(context)
    result = copy.deepcopy(rules)
    result['applicability'] = {'issuerCategory': category, 'fiscalYearStart': fiscal.isoformat()}
    result['applicationText'] = rules['applicationText']['gem' if category == 'gem' else 'mb']
    result['topics'] = [t for t in result['topics'] if 'boards' not in t or context['board'] in t['boards']]
    for topic in result['topics']:
        topic['sourceText'] = topic['sourceTextGem'] if category == 'gem' else topic['sourceText']
        obligation = 'mandatory' if topic['part'] == 'B' or topic['id'] == 'hk_ghg12' else 'comply_explain'
        if topic['part'] == 'D' and topic['id'] != 'hk_ghg12':
            obligation = 'voluntary' if category == 'gem' or topic['id'] == 'hk_d36' else 'mandatory' if category == 'largecap' and fiscal >= date(2026, 1, 1) else 'comply_explain'
        topic['obligation'] = obligation
        topic['applicationNotes'] = ('大型股须满足上一财政年度全年为恒生综合大型股指数成分股的条件；进入D部分强制披露后，退出指数仍持续适用。'
                                    '第36段行业指标仍属鼓励披露。逐项按原文附注核定宽免，首次编制本身不是一般豁免。')
    return result
