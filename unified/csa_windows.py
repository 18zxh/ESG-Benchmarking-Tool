"""CSA adapter for the shared long-evidence window scheduler."""
import json

from .core import LocalError, fingerprint
from .pdf_engine import evidence_windows, reduce_windows


def install(native):
    original = native._evaluate_questions

    def evaluate(provider, questions, evidence_by_question, project, usage, progress, counts, documents):
        def payload(q, entries, conclusions=None):
            result = native._assessment_payload(provider, [q], {q['id']: entries}, project)
            if conclusions is not None:
                result['messages'][0]['content'] += (
                    '\n这些是已完成的原文窗口结论。综合全部子结论与原始引用，保留年度、边界、矛盾和缺口；'
                    '不得多数投票，不得将一个窗口未命中当作全文未披露。仍按完整方法输出同一题目的results。')
                result['messages'][1]['content'] += '\n窗口子结论：' + json.dumps(conclusions, ensure_ascii=False)
            return result

        def fits(q, entries, conclusions=None):
            request = payload(q, entries, conclusions)
            return sum(len(m['content']) for m in request['messages']) <= native.MAX_EVALUATION_INPUT_CHARS

        long = [q for q in questions if not fits(q, evidence_by_question[q['id']])]
        if not long:
            return original(provider, questions, evidence_by_question, project, usage, progress, counts, documents)
        regular = [q for q in questions if q not in long]
        results = {r['questionId']: r for r in original(provider, regular, evidence_by_question, project,
                                                       usage, progress, counts, documents)} if regular else {}
        run = native.runtime.current()
        for question in long:
            qid = question['id']
            entries = evidence_by_question[qid]
            key = native._result_cache_key(question, entries, project, documents, provider, counts)
            cached = run.get(key, result=True)
            if cached:
                results[qid] = cached
                counts['cachedAssessments'] += 1
                continue
            if not fits(question, []):
                raise native.RequestError('完整CSA方法本身超过预算，未截断方法。')
            try:
                windows = evidence_windows(entries, lambda pool: fits(question, pool))
            except LocalError as error:
                raise native.RequestError(str(error)) from None

            def request(pool, conclusions=None):
                if not fits(question, pool, conclusions):
                    raise native.RequestError('CSA窗口合并超过预算，未裁掉方法、结论或原文。')
                body = payload(question, pool, conclusions)
                cache_key = fingerprint(['unified-csa-windows-v1', key, body])
                raw = run.get(cache_key, result=True)
                if raw is None:
                    response = native._tracked_call(provider, body, usage, 'assessment')
                    draft, finish = native._parse_response(response)
                    if finish != 'stop': raise native.RequestError('窗口输出未完整结束；已完成窗口可续跑。')
                    rows = draft.get('results')
                    if not isinstance(rows, list) or len(rows) != 1 or rows[0].get('questionId') != qid:
                        raise native.RequestError('CSA窗口返回缺题或编号不符。')
                    raw = rows[0]
                checked = native._checked_result(raw, question, {e['id']: e for e in pool}, project,
                                                counts['unverifiedByQuestion'].get(qid, 0))
                run.put(cache_key, raw)
                return {'raw': raw, 'checked': checked, 'pool': pool}

            def merge(pair, final):
                cited = {e['id']: e for node in pair for e in node['pool'] if e['id'] in node['raw'].get('evidenceIds', [])}
                return request(list(cited.values()), [node['raw'] for node in pair])

            node = reduce_windows(windows, lambda pool, index, count: request(pool), merge,
                                  checkpoint=run.before_request or (lambda: None))
            record = {**node['checked'], 'evidenceWindowCount': len(windows), 'evidenceConsidered': len(entries)}
            run.put(key, record)
            results[qid] = record
            if progress:
                progress({'phase': '完整证据窗口初评已保存', 'completed': len(results), 'total': len(questions)})
        return [results[q['id']] for q in questions]

    native._evaluate_questions = evaluate
