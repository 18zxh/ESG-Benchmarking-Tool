"""Keep valid CSA rows, retry malformed/missing rows once, continue other batches."""
import re
from .result_text import company_number_text


def numeric_issues(native, record, question, project):
    claim = company_number_text(record['remark'])
    pages = {e['page'] for e in record['evidence']}
    page_issues = []
    def page_label(match):
        numbers = [int(n) for n in re.findall(r'\d+', match.group())]
        if len(numbers) == 2 and re.search(r'[-–—至到]', match.group()):
            numbers = list(range(numbers[0], numbers[1] + 1))
        if not set(numbers) <= pages:
            page_issues.append('备注页码没有全部对应本题直接引用的物理页；请用引用列表定位。')
        return ' '
    claim = re.sub(r'(?:PDF\s*)?第\s*\d+(?:\s*[-–—至到、,，]\s*\d+)*\s*页', page_label, claim, flags=re.I)
    method = {'title_en':question['title'], 'definition':question['layout'],
        'definition_en':question['guidance'], 'definition_zh':question.get('layoutZh',''),
        'scoring_rule_zh':question.get('guidanceZh','')}
    source = '\n'.join(e['text'] for e in record['evidence'])
    supported = native.model_proxy.numeric_facts(source + '\n' + str(project.get('reportPeriod','')))
    missing = native.model_proxy.company_numeric_facts(claim, method) - supported
    thresholds = native.model_proxy.numeric_facts(' '.join(str(v) for v in method.values()))
    missing = {n for n in missing if not (n in thresholds and re.search(
        r'(?:未披露|未找到|未见|是否|阈值|门槛|问卷|题目|行业平均|如需)[^。；]{0,45}(?<![\d.])' +
        re.escape(n) + r'(?![\d.])', claim))}
    issues = page_issues
    if missing:
        issues.append('备注中的数值未由已引用原文支持：' + '、'.join(sorted(missing)))
    issues.extend(native.model_proxy.quantity_issues(claim, source))
    if re.search(r'可推知|推算可得|据此推算|按.{0,12}推算|由此计算', claim):
        issues.append('不得自行推算或建议推算公司比例；保留报告直接披露口径。')
    return list(dict.fromkeys(issues))


def install(native):
    checked_original = native._checked_result
    def grounded(item, question, evidence, project, unverified):
        row = checked_original(item, question, evidence, project, unverified)
        row['issues'] = numeric_issues(native, row, question, project)
        if row['issues']:
            row['draftStatus'] = 'needs_review'
        return row
    native._checked_result = grounded

    def evaluate(provider, questions, evidence_by_question, project, usage, progress, counts, documents):
        run = native.runtime.current()
        pending, results, keys, failures = [], {}, {}, {}
        for q in questions:
            key = native._result_cache_key(q, evidence_by_question[q['id']], project, documents, provider, counts)
            keys[q['id']] = key
            cached = run.get(key, result=True)
            if cached and cached.get('questionId') == q['id'] and not numeric_issues(native, cached, q, project):
                if cached.get('issues'):
                    cached = {**cached, 'issues': []}
                    run.put(key, cached)
                results[q['id']] = cached
                counts['cachedAssessments'] += 1
            else:
                pending.append(q)

        def request(batch, correction=''):
            payload = native._assessment_payload(provider, batch, evidence_by_question, project)
            if correction:
                payload['messages'][0]['content'] += '\n本次只修复返回格式和引用问题，完整方法与原文不变：' + correction
            response = native._tracked_call(provider, payload, usage, 'assessment')
            value, finish = native._parse_response(response)
            if finish != 'stop':
                raise native.RequestError('GLM备注输出未完整结束；已完成题目保留。')
            rows = value.get('results')
            if not isinstance(rows, list) or any(not isinstance(r, dict) for r in rows):
                raise native.RequestError('GLM未返回有效的逐题results。')
            allowed = {q['id'] for q in batch}
            returned = {}
            for row in rows:
                qid = str(row.get('questionId'))
                if qid not in allowed or qid in returned:
                    raise native.RequestError('GLM返回了重复或不属于本批的问题编号。')
                returned[qid] = row
            counts['assessmentBatches'] += 1
            return returned

        def check(q, row, retry=False):
            if row is None:
                raise native.RequestError('模型遗漏了该问题；请完整返回输入的questionId。')
            checked = native._checked_result(row, q, {e['id']: e for e in evidence_by_question[q['id']]},
                project, counts['unverifiedByQuestion'].get(q['id'], 0))
            if checked['issues'] and not retry:
                raise native.RequestError('；'.join(checked['issues']) + '；直接引用须包含所述数字，不得自行换算或推算；未披露的判断也不能夹带没有引用的公司数字。')
            return checked

        for batch in native._assessment_batches(pending, evidence_by_question, project):
            returned = request(batch)
            for q in batch:
                try:
                    checked = check(q, returned.get(q['id']))
                except native.RequestError as first:
                    try:
                        retry = request([q], str(first) + '；evidenceIds只复制本题输入编号；没有直接依据时用not_found或needs_review，不得补造引用。')
                        checked = check(q, retry.get(q['id']), retry=True)
                    except native.RequestError as last:
                        failures[q['id']] = str(last)
                        continue
                results[q['id']] = checked
                run.put(keys[q['id']], checked)
                if progress:
                    progress({'phase': '逐题初评已保存', 'completed': len(results), 'total': len(questions),
                        'detail': f'{len(results)}/{len(questions)}项；已完成部分可续跑'})
        if failures:
            details = '；'.join(qid + '：' + why for qid, why in failures.items())
            raise native.RequestError('部分题目仍未通过校验：' + details + '。其他成功题目已保存，继续只处理未完成部分。')
        return [results[q['id']] for q in questions]

    native._evaluate_questions = evaluate
