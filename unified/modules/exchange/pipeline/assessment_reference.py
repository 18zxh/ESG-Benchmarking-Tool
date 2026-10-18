"""Canonical assessment text and topic fields shared by GLM prompts and Excel references."""
import hashlib
import json
from pathlib import Path
from pipeline.pdf_context import MAX_REFERENCES

ROOT = Path(__file__).resolve().parents[1]
MAINLAND_METHOD_PATH = ROOT / 'data/assessment/mainland-methodology.zh.md'
MAINLAND_METHOD_VERSION = 'mainland-disclosure-methodology-zh-v1'
MAX_ASSESSMENT_TEXT_CHARS = 800
ASSESSMENT_LIMITS = {'textCharsPerField': MAX_ASSESSMENT_TEXT_CHARS, 'evidenceIds': MAX_REFERENCES}


def attach_mainland_methodology(rules):
    content = MAINLAND_METHOD_PATH.read_bytes()
    method = content.decode('utf-8')
    if not method.strip():
        raise ValueError('Mainland assessment methodology is empty')
    source = [{'id': t['id'], 'name': t['name'], 'clause': t['clause'], 'requirement': t['requirement'],
               'ruleText': t.get('sourceText', '')} for t in rules['topics']]
    fingerprint = hashlib.sha256(content + b'\0' + json.dumps(source, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    rules['assessmentGuide'] = {'language': 'zh-Hans', 'methodologyVersion': MAINLAND_METHOD_VERSION,
                               'fingerprint': fingerprint, 'methodology': method}
    return rules


def model_assessment_topic(topic, rules):
    if rules['exchange'] == 'hk':
        from pipeline.hk_assessment import assessment_topic
        return assessment_topic(topic, rules)
    return {'id': topic['id'], 'name': topic['name'], 'clause': topic['clause'],
            'requirement': topic['requirement'], 'ruleText': topic.get('sourceText', '')}


def assessment_instruction(rules):
    if rules['exchange'] == 'hk':
        return '逐项按所选板块的完整官方中文条文ruleText、关联条文relatedRuleText、适用条文applicationText及评估方法核对。保留部分、议题、指标、条款层级及明确的披露属性。严格按指定JSON结构返回，结果用简体中文，证据摘录保留报告原语言。'
    return rules['assessmentGuide']['methodology']


def assessment_reference(rules):
    """Return the exact static methodology and topic fields embedded in assessment requests."""
    result = {'exchange': rules['exchange'], 'task': 'assess_topics',
              'instruction': (assessment_instruction(rules) + f' 每议题必须返回结果。 每个结果文字字段不超过{MAX_ASSESSMENT_TEXT_CHARS}字，'
                             f'最多引用{MAX_REFERENCES}条证据；不得省略条款条件。'),
              'assessmentGuide': rules.get('assessmentGuide'), 'limits': ASSESSMENT_LIMITS,
              'output': {'assessments': [{'topicId': rules['topics'][0]['id'], 'judgment': '已披露/部分披露/未披露/待全文核验',
                                         'disclosedContent': '已有披露', 'gap': '未覆盖的要求',
                                         'suggestion': '具体改进建议', 'evidenceIds': []}]},
              'topics': [model_assessment_topic(t, rules) for t in rules['topics']]}
    if rules['exchange'] == 'hk':
        result['applicationText'] = rules['applicationText']
        result['context'] = rules.get('applicability', {})
        result['output']['assessments'][0].update(disclosedContent='有原文证据支持的披露或解释',
                                                  gap='未覆盖的适用要求及尚待核定的宽免条件',
                                                  suggestion='按真实披露属性提出具体改进建议')
    return result
