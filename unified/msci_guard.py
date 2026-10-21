"""Check factual summary numbers against cited originals, not adjacent guesses.

Reuse the upstream number/unit parsers; keep methodology thresholds separate
from company facts. A failed row gets one focused retry, never a guessed fix.
"""
from contextvars import ContextVar
import json
import re
from .result_text import company_number_text

PROJECT = ContextVar('msci_checked_project', default={})


def issues(native, row, criterion, project):
    draft = json.loads(row['content'])
    claim = company_number_text(re.sub(r'【[^】]*PDF物理页[^】]*】', '', draft.get('current_disclosure', '')))
    sources = '\n'.join(e['text'] for e in row['evidence'])
    models = native.models
    allowed = models.numeric_facts(sources) | models.numeric_facts(json.dumps(project, ensure_ascii=False))
    missing = models.company_numeric_facts(claim, criterion) - allowed
    # Explicit method thresholds in "not disclosed" descriptions are questions,
    # not company measurements. Positive factual values still need citations.
    method = models.numeric_facts(' '.join(str(criterion.get(k, '')) for k in
        ('definition', 'definition_en', 'scoring_rule', 'title', 'title_en')))
    if draft.get('disclosure_status') == 'not_found' and re.search('未披露|未找到|无法判断|未见', claim):
        missing -= method
    else:
        missing = {n for n in missing if not (n in method and re.search(
            re.escape(n) + r'(?:\s*[%％])?\s*(?:的)?(?:阈值|门槛|要求|指标)', claim)) and not
            (n in method and re.search(r'(?:未披露|未找到|未明确|无法判断|无法确定|不能确定|是否)[^。；]{0,35}(?<![\d.])' +
                re.escape(n) + r'(?![\d.])', claim))}
    found = []
    if missing:
        found.append('披露总结的数值未在本项直接引用中找到：' + '、'.join(sorted(missing)) + '；请补充包含该数值/年度的直接引文，或删去无依据的数字。')
    found.extend(models.quantity_issues(claim, sources))
    if re.search(r'可推知|可推算|推算可得|据此推算|由此计算|可计算得', claim):
        found.append('不得自行推算公司比例或数值；保留原报告直接披露的数值、年度和单位。')
    prose = ' '.join(str(draft.get(k, '')) for k in ('current_disclosure', 'rationale', 'score_basis', 'recommendation'))
    prose += ' ' + ' '.join(draft.get('gaps', []))
    if not criterion.get('numeric_scale_available') and re.search(
            r'0\s*[-–—~至到]\s*10\s*(?:分|评分|打分)|(?:得分|分数|建议评分)\s*[:：为]?\s*-?\d|\d+(?:\.\d+)?\s*/\s*10\s*分', prose):
        found.append('没有完整适用标尺时，说明文字也不得自造数值评分或0–10分要求；只对照输入的完整方法作定性判断。')
    return list(dict.fromkeys(found))


def install(native):
    original_once, original_group, original_valid = native._assess_once, native._group_assess, native._cached_rows_valid

    def valid(rows, provider, criteria, evidence):
        if not original_valid(rows, provider, criteria, evidence):
            return False
        methods = {c['id']: c['criterion'] for c in criteria}
        return not any(issues(native, r, methods[r['criterionId']], PROJECT.get()) for r in rows)

    def checked(provider, criteria, evidence, project, job, mode='final', reviews=None):
        token = PROJECT.set(project)
        try:
            rows = original_once(provider, criteria, evidence, project, job, mode=mode, reviews=reviews)
            def absence(row):
                draft = json.loads(row['content'])
                if draft.get('disclosure_status') == 'not_found' and not row['evidence']:
                    # A no-evidence conclusion must not carry company facts from
                    # another window. Keep the actionable gaps/recommendation.
                    scope = '本窗口' if mode == 'window' else '本次完整读取范围内'
                    draft['current_disclosure'] = scope + '未找到直接支持该指标的披露。'
                    draft['rationale'] = '缺少该指标的直接支持材料；相关背景不能替代本指标的披露。'
                    draft['score_basis'] = draft['rationale']
                    row = {**row, 'content': json.dumps(draft, ensure_ascii=False)}
                return row
            rows = [absence(row) for row in rows]
            methods = {c['id']: c['criterion'] for c in criteria}
            problems = {r['criterionId']: issues(native, r, methods[r['criterionId']], project) for r in rows}
            problems = {k: v for k, v in problems.items() if v}
            good = {r['criterionId']: r for r in rows if r['criterionId'] not in problems}
            if problems:
                failed = [c for c in criteria if c['id'] in problems]
                old_notes = job.get('_numericCorrections')
                job['_numericCorrections'] = [{'criterion': methods[k].get('title', k), 'issues': v} for k, v in problems.items()]
                retry_reviews = reviews
                if reviews is not None:
                    remap = {f'C{criteria.index(c)+1}': f'C{i+1}' for i, c in enumerate(failed)}
                    retry_reviews = [{**r, 'criterion_id': remap[r['criterion_id']]} for r in reviews
                        if r.get('criterion_id') in remap] if any('criterion_id' in r for r in reviews) else reviews
                try:
                    retried = original_once(provider, failed, evidence, project, job, mode=mode, reviews=retry_reviews)
                    for row in map(absence, retried):
                        remaining = issues(native, row, methods[row['criterionId']], project)
                        if not remaining:
                            good[row['criterionId']] = row
                            problems.pop(row['criterionId'], None)
                        else:
                            problems[row['criterionId']] = remaining
                except Exception as exc:
                    for c in failed:
                        problems[c['id']] = problems.get(c['id'], []) + [str(exc)]
                finally:
                    if old_notes is None:
                        job.pop('_numericCorrections', None)
                    else:
                        job['_numericCorrections'] = old_notes
                recorded = {e['criterionId'] for e in job.setdefault('errors', [])}
                job['errors'].extend({'criterionId': k, 'error': '；'.join(v)} for k, v in problems.items() if k not in recorded)
            return [good[c['id']] for c in criteria if c['id'] in good]
        finally:
            PROJECT.reset(token)

    def group(provider, criteria, evidence, project, job):
        token = PROJECT.set(project)
        try:
            return original_group(provider, criteria, evidence, project, job)
        finally:
            PROJECT.reset(token)

    native._cached_rows_valid, native._assess_once, native._group_assess = valid, checked, group
