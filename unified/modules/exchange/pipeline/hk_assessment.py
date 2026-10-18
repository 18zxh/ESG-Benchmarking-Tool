"""Official-Chinese HKEX rules and the question/method files used by model requests."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUESTION_PATH = ROOT / 'data/assessment/hk-questions.zh.json'
METHOD_PATH = ROOT / 'data/assessment/hk-methodology.zh.md'
METHOD_VERSION = 'hkex-c2-methodology-zh-v1'


def attach_assessment(rules):
    question_bytes, method_bytes = QUESTION_PATH.read_bytes(), METHOD_PATH.read_bytes()
    questions = json.loads(question_bytes)
    method = method_bytes.decode('utf-8')
    items = questions['topics']
    if (rules.get('contentLanguage') != 'zh-Hans' or questions['language'] != 'zh-Hans' or METHOD_VERSION not in method
            or [item['id'] for item in items] != [topic['id'] for topic in rules['topics']]):
        raise ValueError('HK assessment artifacts are incomplete')
    for topic, item in zip(rules['topics'], items):
        for field, source in [('sourceSha256', 'sourceText'), ('sourceSha256Gem', 'sourceTextGem')]:
            if hashlib.sha256(topic[source].encode()).hexdigest() != item[field]:
                raise ValueError('HK assessment question has stale source binding')
        hierarchy = item['hierarchy']
        if (hierarchy['part'] != topic['part'] + '部分' or hierarchy['appendix'] != '附录C2'
                or any(not hierarchy.get(k) for k in ('topic', 'indicator', 'clause'))
                or not item['question'].strip()):
            raise ValueError('HK assessment hierarchy is incomplete')
        topic['assessmentQuestion'] = item
    fingerprint = hashlib.sha256(question_bytes + b'\0' + method_bytes + b'\0'
                                 + json.dumps(rules['applicationText'], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    rules['assessmentGuide'] = {'language': 'zh-Hans', 'questionVersion': questions['version'],
                              'methodologyVersion': METHOD_VERSION, 'fingerprint': fingerprint,
                              'methodology': method}
    return rules


def model_topic(topic):
    item = topic['assessmentQuestion']
    h = item['hierarchy']
    name = h['topic'] if topic['part'] == 'B' else h['topic'] + ' / ' + h['indicator']
    return {'id': topic['id'], 'name': name, 'clause': f"附录C2 · {h['part']} · {h['clause']}",
            'hierarchy': h, 'question': item['question'], 'requirement': item['question']}


def assessment_topic(topic, rules):
    value = model_topic(topic)
    value.update(ruleText=topic['sourceText'], obligation=topic['obligation'],
                 obligationLabel={'mandatory': '强制披露', 'comply_explain': '不遵守就解释', 'voluntary': '鼓励披露' if topic['id'] == 'hk_d36' else '自愿披露'}[topic['obligation']],
                 applicationNotes=topic['applicationNotes'])
    if topic['id'] == 'hk_d24':
        related = next(t for t in rules['topics'] if t['id'] == 'hk_d25')
        value['relatedRuleText'] = [{'clause': '第25段，尤其是适用于当前财务影响的附注1、3及5',
                                    'ruleText': related['sourceText']}]
    return value
