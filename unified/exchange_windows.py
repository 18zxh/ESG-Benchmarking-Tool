"""Synthesize all completed exchange windows once when their full input fits."""


def install(native):
    def stable_source(value):
        if isinstance(value, list):
            return [stable_source(v) for v in value]
        if isinstance(value, dict):
            evidence = all(k in value for k in ('id','quote','page'))
            return {k:stable_source(v) for k,v in value.items() if not (evidence and k=='documentId')}
        return value

    def assess(service, task, topic, guide, item, full_coverage):
        base = {k:v for k,v in guide.items() if k != 'topics'}
        base['fullPageCoverage'] = False
        base['window'] = {'index':len(item['evidence']), 'total':len(item['evidence'])}
        base['instruction'] += (f" 当前仅为证据窗口：未命中只代表本窗口，不代表全报告未披露。每个文字字段不超过{native.ASSESSMENT_LIMITS['textCharsPerField']}字，"
            f"最多引用{native.ASSESSMENT_LIMITS['evidenceIds']}条证据。")
        windows = list(native.evidence_windows(base, item))
        provider, mappings = task.context['provider'], task.context['mappings']

        def evaluate(request, allowed, complete, budget, final=False):
            if not native.fits(request, budget):
                raise native.RequestError('完整方法、结论与证据超过合并预算，未截断。', 'context_budget')
            key = native.cache_key('stable-exchange-windows-v1', native.ASSESS_VERSION, provider['fingerprint'], stable_source(request))
            raw = service.cache.get('assessment-window', key)
            if raw is None:
                # Same-request legacy checkpoints are still revalidated below.
                legacy = native.cache_key(native.ASSESS_VERSION, provider['fingerprint'], request)
                raw = service.cache.get('assessment-window', legacy)
            for attempt in range(native.MAX_RETRIES + 1):
                task.checkpoint()
                try:
                    value = {'assessments':[raw]} if raw is not None else native.call_json(provider,
                        native.encoded(request), task.data['usage'], send=service.send, max_tokens=8192 if final else 4096)
                    if hasattr(native, 'clean_assessment_prose'):
                        value = native.clean_assessment_prose(value, allowed)
                    records = native.assessment_rows(value, [topic], allowed, mappings, 'native', complete)
                    raw = {**value['assessments'][0], 'judgment':records[topic['id']]['assessment']['judgment']}
                    service.cache.put('assessment-window', key, raw)
                    return raw, records[topic['id']]
                except native.RequestError as exc:
                    raw = None
                    if exc.category in ('network','upstream','context_budget') or attempt == native.MAX_RETRIES:
                        raise
                    request['correction'] = str(exc)

        nodes = []
        for index, window in enumerate(windows):
            request = {**base, 'topics':[{**item, 'evidence':window}],
                'window':{'index':index+1,'total':len(windows)}}
            if len(windows) == 1:
                request = {**guide, 'topics':[{**item,'evidence':window}]}
            raw, record = evaluate(request, window, full_coverage if len(windows)==1 else False, native.INPUT_BUDGET)
            nodes.append((raw,window))
            task.update(assessmentWindow=index+1, assessmentWindows=len(windows))
        def merge_request(parts, complete, binary=False):
            cited = list({e['id']:e for raw,pool in parts for e in pool if e['id'] in raw['evidenceIds']}.values())
            request = {**guide, 'task':'assess_topics','topics':[{**item,'evidence':cited}],
                'fullPageCoverage':complete, 'windowConclusions':[raw for raw,_ in parts],
                'instruction':guide['instruction'] +
                    f" 所给证据窗口已分别检查。综合全部所给子结论与所附原始引用，保留不同年度、边界、矛盾与缺口，不得投票。局部未命中不能推为全文未披露，仅fullPageCoverage为true时可判全文未披露。每个文字字段不超过{native.ASSESSMENT_LIMITS['textCharsPerField']}字，最多{native.MAX_REFERENCES}条直接引用；不得在说明中写内部引用编号。"}
            if binary:
                request['instruction'] = guide['instruction'] + f" 所有证据窗口已分别检查。综合所给子结论及其原始引用，保留不同年度、边界、矛盾与未解决缺口；不得按多数投票。局部未命中不能直接推为全文未披露。仅最后合并且全文读取完整时可判定全文未披露。每个文字字段不超过{native.ASSESSMENT_LIMITS['textCharsPerField']}字，最多{native.ASSESSMENT_LIMITS['evidenceIds']}条引用。"
            return request, cited

        if len(nodes)>1:
            request, cited = merge_request(nodes, full_coverage)
            if not native.fits(request, native.MERGE_BUDGET):
                # Merge the largest contiguous groups that fit; pairs remain
                # the fallback. Leaf/intermediate keys survive document reloads.
                while len(nodes)>1:
                    next_nodes=[]
                    at=0
                    while at<len(nodes):
                        count=2
                        for end in range(at+3,len(nodes)+1):
                            trial,_=merge_request(nodes[at:end],full_coverage if at==0 and end==len(nodes) else False)
                            if not native.fits(trial,native.MERGE_BUDGET):
                                break
                            count=end-at
                        pair=nodes[at:at+count]
                        at+=len(pair)
                        if len(pair)==1:
                            next_nodes.extend(pair);continue
                        complete=full_coverage if len(pair)==len(nodes) else False
                        request,cited=merge_request(pair,complete,binary=len(pair)==2)
                        task.update(assessmentMergeInputs=len(pair))
                        raw,record=evaluate(request,cited,complete,native.MERGE_BUDGET,final=True)
                        next_nodes.append((raw,cited))
                    nodes=next_nodes
            else:
                task.update(assessmentMergeInputs=len(nodes))
                _, record = evaluate(request, cited, full_coverage, native.MERGE_BUDGET, final=True)
            task.update(assessmentMergeInputs=0)
        record['assessment']['evidenceWindowCount'] = len(windows)
        record['assessment']['evidenceConsidered'] = len(item['evidence'])
        return record

    native.ReviewService._window_assess = assess
