"""Merge all completed evidence windows together when the full payload fits.

The legacy implementation made a separate binary merge tree for every single
criterion. This preserves all window conclusions, methods and cited originals,
but batches their final synthesis instead of multiplying calls by criteria.
"""
import json


def install(native):
    original = native._group_assess
    context = native.context

    def assess(provider, criteria, evidence, project, job):
        if len(criteria) <= 8 and context.group_budget(criteria, evidence, project) <= context.INPUT_BUDGET:
            return native._assess_once(provider, criteria, evidence, project, job)
        key = native._result_key(provider, criteria, evidence, project)
        cached = native.review_cache.load_results(key)
        if native._cached_rows_valid(cached, provider, criteria, evidence):
            job['cachedCriteria'] = job.get('cachedCriteria', 0) + len(cached)
            return [{**r, 'providerId': provider['id'], 'providerName': provider['name']} for r in cached]
        if len(criteria) > 1 and (len(criteria) > 8 or context.group_budget(criteria, [], project) > context.INPUT_BUDGET * .55):
            middle = len(criteria) // 2
            rows = []
            for group in (criteria[:middle], criteria[middle:]):
                try:
                    rows.extend(assess(provider, group, evidence, project, job))
                except Exception as exc:
                    recorded = {e['criterionId'] for e in job.setdefault('errors', [])}
                    job['errors'].extend({'criterionId': c['id'], 'error': str(exc)} for c in group if c['id'] not in recorded)
            if not rows:
                raise RuntimeError(job['errors'][-1]['error'])
        else:
            windows = list(context.evidence_windows(criteria, evidence, project))
            completed = {c['id']: [] for c in criteria}
            for window in windows:
                if not native._wait(job):
                    raise RuntimeError('任务已停止，未完成窗口不能形成全文结论。')
                found = native._assess_once(provider, criteria, window, project, job, mode='window')
                for row in found:
                    completed[row['criterionId']].append(row)
            eligible = [c for c in criteria if len(completed[c['id']]) == len(windows)]
            recorded = {e['criterionId'] for e in job.setdefault('errors', [])}
            job['errors'].extend({'criterionId': c['id'], 'error': '该指标部分原文窗口未完成，未生成全文结论。'}
                for c in criteria if c not in eligible and c['id'] not in recorded)
            if not eligible:
                raise RuntimeError('本组指标的原文窗口尚未全部完成，未生成全文结论。')

            def merge(group):
                aliases = {c['id']: f'C{i+1}' for i, c in enumerate(group)}
                records = [r for c in group for r in completed[c['id']]]
                cited = {e['id']: e for r in records for e in r['evidence']}
                reviews = [{'criterion_id': aliases[r['criterionId']], **{k: v for k, v in json.loads(r['content']).items()
                    if k in {'disclosure_status', 'current_disclosure', 'gaps', 'recommendation', 'rationale', 'evidence_refs'}}} for r in records]
                payload = context.request_payload(group, list(cited.values()), project, reviews)
                if context.estimate_tokens(payload) + context.SYSTEM_RESERVE <= context.MERGE_BUDGET:
                    if not native._wait(job):
                        raise RuntimeError('任务已停止，窗口汇总未完成。')
                    rows = native._assess_once(provider, group, list(cited.values()), project, job, mode='merge', reviews=reviews)
                    returned = {r['criterionId'] for r in rows}
                    recorded = {e['criterionId'] for e in job.setdefault('errors', [])}
                    job['errors'].extend({'criterionId': c['id'], 'error': '窗口汇总缺少指标，未生成该项结果。'}
                        for c in group if c['id'] not in returned | recorded)
                    return [{**r, 'reviewedEvidenceWindows': len(windows)} for r in rows]
                if len(group) > 1:
                    middle = len(group) // 2
                    return merge(group[:middle]) + merge(group[middle:])
                # No content is dropped to squeeze an oversized synthesis in.
                return original(provider, group, evidence, project, job)

            rows = merge(eligible)
        if native._cached_rows_valid(rows, provider, criteria, evidence):
            native.review_cache.save_results(key, rows)
        return rows

    native._group_assess = assess
