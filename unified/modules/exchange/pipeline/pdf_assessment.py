"""Bounded native-PDF or retrieved-evidence reading, then topic assessment."""
import base64
import hashlib
import json
import re
from pipeline.constants import (PDF_BATCH_PAGES, MAX_TOPIC_GROUP, MAX_EVIDENCE_PER_TOPIC,
    MAX_EVIDENCE_CHARS, MAX_READ_EVIDENCE, MAX_READ_QUOTE_CHARS, MAX_RETRIES, READ_VERSION, ASSESS_VERSION, MAX_CHAPTER_SUMMARY_CHARS)
from pipeline.errors import RequestError
from pipeline.model_proxy import call_json
from pipeline.pdf_pages import request_pdf
from pipeline.pdf_context import reading_batches, fits, evidence_windows, encoded, PDF_BATCH_BYTES, MERGE_BUDGET, INPUT_BUDGET, MAX_REFERENCES
from pipeline.pdf_text import contains_pdf_quote, normalize_pdf_text
from pipeline.review_cache import CACHE, cache_key
from pipeline.hk_assessment import model_topic
from pipeline.assessment_reference import assessment_reference, model_assessment_topic, ASSESSMENT_LIMITS


def contract(message="模型读取结果缺字段、出处无效或未读完整。"):
    return RequestError(message, "model_contract", 502)


def groups(items, maximum=MAX_TOPIC_GROUP):
    return [items[i:i + maximum] for i in range(0, len(items), maximum)]


def bind_evidence(item, doc):
    meta = doc["meta"]
    return {**item, "id": cache_key(meta["sha256"], meta["source"], item["page"], item["quote"])[:24],
            "documentId": meta["id"], "source": meta["source"], "name": meta["name"]}


class Reader:
    def __init__(self, provider, task, topics, *, cache=None, send=None, assessment_guide=None, read_context=None):
        if provider["mode"] not in ("native", "compatible"):
            raise RequestError("模型服务类型不支持读取。")
        self.provider, self.task, self.topics = provider, task, topics
        self.cache, self.send = cache or CACHE, send
        self.topic_ids = {t["id"] for t in topics}
        self.assessment_guide = assessment_guide
        self.read_context = read_context

    def ask(self, content, system="", max_tokens=8192):
        self.task.checkpoint()
        return call_json(self.provider, content, self.task.data["usage"], system=system, send=self.send, max_tokens=max_tokens)

    def _range_part(self, doc, start, end):
        try:
            return self.native_range(doc, start, end)
        except RequestError as exc:
            # Preserve the narrowest failing range while the error bubbles up.
            if not hasattr(exc, "page_range"):
                exc.page_range = (start, end)
            raise

    def native_range(self, doc, start, end):
        if self.provider["mode"] != "native":
            raise RequestError("当前服务不是原生 PDF 类型。")
        key = cache_key(doc["meta"]["sha256"], doc["meta"]["name"], doc["meta"]["source"], self.provider["fingerprint"], "native", start, end, READ_VERSION,
                        self.topics, *([self.read_context] if self.read_context else []), *([self.assessment_guide['fingerprint']] if self.assessment_guide else []))
        cached = self.cache.get("read", key)
        if cached is not None:
            return [bind_evidence(e, doc) for e in cached]
        guide = {"task": "read_pdf", "physicalPages": list(range(start, end + 1)), "topics": [{"id": t["id"], "name": t["name"]} for t in self.topics],
                 "instruction": "逐页阅读全文含表格。页眉Source PDF physical page为原件物理页号。complete只表示请求中的每页均已实际打开并检查，不表示发现了相关披露；封面、目录、空白页或无文字层的图像页，只要已检查也必须complete=true并返回实际物理页号，未发现相关内容时evidence=[]。只有页面无法打开/渲染、仍有请求页未检查或输出容量不足时才complete=false，并简短说明incomplete_reason。仅提取逐字原文，片段同时注明适用topicIds。不得用摘要充当摘录。",
                 "output": {"complete": True, "reviewed_pages": list(range(start, end + 1)), "incomplete_reason": "", "evidence": [{"page": start, "topicIds": [next(iter(self.topic_ids))], "quote": "逐字原文"}]},
                 "limits": {"evidence": MAX_READ_EVIDENCE, "quoteChars": MAX_READ_QUOTE_CHARS}}
        if self.assessment_guide:
            guide.update(instruction='逐页阅读全文及表格，页眉Source PDF physical page为原件物理页号。complete只表示请求中的每页均已实际打开并检查，不表示发现了相关披露；封面、目录、空白页或无文字层的图像页，只要已检查也必须complete=true并返回实际物理页号，未发现相关内容时evidence=[]。只有页面无法打开/渲染、仍有请求页未检查或输出容量不足时才complete=false，并简短说明incomplete_reason。按所给指标问题提取连续逐字原文，并注明适用topicIds。保留报告语言、数字、单位和期间，不得用概述或翻译充当摘录。',
                         topics=[{k: model_topic(t)[k] for k in ('id', 'name', 'clause', 'question')} for t in self.topics],
                         questionVersion=self.assessment_guide['questionVersion'])
            guide['output']['evidence'][0]['quote'] = '逐字原文'
        if self.read_context:
            guide['comparisonContext'] = self.read_context
        pdf = request_pdf(doc["content"], start, end)
        if len(pdf) > PDF_BATCH_BYTES:
            if start == end: raise RequestError("单页 PDF 超过 6 MiB 请求上限，未压缩或裁剪原页。", "pdf_request_size")
            middle = (start + end) // 2
            return self._range_part(doc, start, middle) + self._range_part(doc, middle + 1, end)
        guide["instruction"] += " 同时检查脚注、图表和组织架构；保留表格行列标题、年度、数值、单位及边界，空白不能当零，不得合并不同期间或单位。达到证据数量上限也应报告未完整读取。"
        content = [{"type": "file", "file": {"file_data": "data:application/pdf;base64," + base64.b64encode(pdf).decode(), "filename": f"pages-{start}-{end}.pdf"}},
                   {"type": "text", "text": json.dumps(guide, ensure_ascii=False)}]
        last = None
        allowance = 8192
        for attempt in range(MAX_RETRIES + 1):
            try:
                value = self.ask(content, max_tokens=allowance)
                if value.get("complete") is not True:
                    complete_state = repr(value.get("complete", "缺失"))[:32]
                    receipt = value.get("reviewed_pages", "缺失")
                    if isinstance(receipt, list): receipt = receipt[:24]
                    receipt = repr(receipt)[:160]
                    records = value.get("evidence")
                    count = len(records) if isinstance(records, list) else "无有效列表"
                    raise RequestError(f"模型未确认所请求页段已逐页完整读取（complete={complete_state}；reviewed_pages={receipt}；证据条数={count}）。", "read_incomplete", 502)
                expected_pages = list(range(start, end + 1))
                reviewed_pages = value.get("reviewed_pages")
                if not isinstance(reviewed_pages, list):
                    raise RequestError("模型没有返回有效的物理页码回执。", "read_incomplete", 502)
                if any(type(n) is not int for n in reviewed_pages):
                    raise RequestError("模型返回的物理页码格式不正确。", "read_incomplete", 502)
                if reviewed_pages != expected_pages:
                    raise RequestError("模型确认的物理页码与本次请求范围不一致。", "read_incomplete", 502)
                records = value.get("evidence")
                if not isinstance(records, list) or len(records) > MAX_READ_EVIDENCE:
                    raise contract()
                if len(records) == MAX_READ_EVIDENCE:
                    raise RequestError("读取证据已达上限，需缩小页段。", "read_incomplete", 502)
                clean = []
                for e in records:
                    if not isinstance(e, dict): raise contract()
                    page, quote, ids = e.get("page"), e.get("quote"), e.get("topicIds")
                    if (isinstance(page, bool) or not isinstance(page, int) or not start <= page <= end
                            or not isinstance(quote, str) or not quote.strip() or len(quote) > MAX_READ_QUOTE_CHARS
                            or not isinstance(ids, list) or not ids or any(not isinstance(i, str) or i not in self.topic_ids for i in ids)):
                        raise contract()
                    local = next((p.get("text", "") for p in doc.get("pages") or [] if p["page"] == page), "")
                    if local.strip() and not contains_pdf_quote(local, quote):
                        raise contract("原生读取摘录未在该物理页文字中核对到，请核验原页。")
                    clean.append({"page": page, "quote": quote, "topicIds": sorted(set(ids)), "verification": "native_text_checked" if local.strip() else "model_pdf"})
                self.cache.put("read", key, clean)
                return [bind_evidence(e, doc) for e in clean]
            except RequestError as exc:
                last = exc
                if exc.category in ("model_length", "read_incomplete"):
                    if start < end: break
                    if allowance == 8192:
                        allowance = 16384
                        continue
                    raise
                if exc.category != "model_contract":
                    raise
                guide["correction"] = str(exc)
                content[1]["text"] = encoded(guide)
        if start < end:
            middle = (start + end) // 2
            return self._range_part(doc, start, middle) + self._range_part(doc, middle + 1, end)
        raise last

    def compatible_group(self, fragments):
        if self.provider["mode"] != "compatible":
            raise RequestError("当前服务不是通用兼容类型。")
        allowed = {e["id"]: e for e in fragments}
        key = cache_key([(e["id"], e["text"], e["topicIds"]) for e in fragments], self.provider["fingerprint"], "compatible", READ_VERSION,
                        *([self.assessment_guide['fingerprint']] if self.assessment_guide else []))
        cached = self.cache.get("read", key)
        if cached is None:
            guide = {"task": "read_evidence", "instruction": "只在给定片段中找与对应topicIds有关的披露。quote必须是所给text中的连续原文。检索范围不等于全文，未命中返回空evidence。", "fragments": fragments,
                     "output": {"complete": True, "evidence": [{"fragmentId": "给定ID", "topicIds": ["给定议题ID"], "quote": "连续原文"}]}}
            if self.assessment_guide:
                guide.update(instruction='只在给定片段中查找对应topicIds的披露。quote必须是所给text中的连续逐字原文，保留原文语言与数字。检索片段不等于全文覆盖，未命中时返回空evidence。',
                             output={'complete': True, 'evidence': [{'fragmentId': '给定片段ID', 'topicIds': ['给定指标ID'], 'quote': '连续逐字原文'}]})
            last = None
            for _ in range(MAX_RETRIES + 1):
                try:
                    value = self.ask(json.dumps(guide, ensure_ascii=False))
                    if value.get("complete") is not True or not isinstance(value.get("evidence"), list): raise contract()
                    cached = []
                    if len(value["evidence"]) > len(fragments) * 2: raise contract()
                    for e in value["evidence"]:
                        if not isinstance(e, dict): raise contract()
                        f = allowed.get(e.get("fragmentId")); quote, ids = e.get("quote"), e.get("topicIds")
                        if (not f or not isinstance(quote, str) or not quote.strip() or not contains_pdf_quote(f["text"], quote) or len(quote) > MAX_EVIDENCE_CHARS
                                or not isinstance(ids, list) or not ids or any(not isinstance(i, str) or i not in f["topicIds"] for i in ids)):
                            raise contract()
                        cached.append({"fragmentId": f["id"], "quote": quote, "topicIds": sorted(set(ids))})
                    self.cache.put("read", key, cached)
                    break
                except RequestError as exc:
                    last = exc
            else:
                if len(fragments) > 1:
                    n = len(fragments) // 2
                    return self.compatible_group(fragments[:n]) + self.compatible_group(fragments[n:])
                raise last
        result = []
        for e in cached:
            f = allowed.get(e["fragmentId"])
            if not f: raise contract("缓存来源已失效，请重新检索。")
            result.append({k: f[k] for k in ("documentId", "source", "name", "page")}
                          | {"id": cache_key(f["id"], e["quote"])[:24], "quote": e["quote"], "topicIds": e["topicIds"], "verification": "local_text"})
        return result


KEYWORDS = {
    "climate": "气候 温室气体 碳排放 碳中和 碳达峰", "pollutants": "污染物 废气 废水 排放", "waste": "废弃物 固废 危险废物",
    "biodiversity": "生物多样性 生态 森林", "environment_compliance": "环境管理 环境合规 环保处罚", "energy": "能源 用电 能耗 节能",
    "water": "水资源 用水 取水 耗水", "circular_economy": "循环经济 循环利用 回收", "rural_revitalization": "乡村振兴 帮扶",
    "social_contribution": "社会贡献 公益 捐赠 志愿", "innovation": "创新 研发 专利", "technology_ethics": "科技伦理 人工智能",
    "supply_chain": "供应链 供应商 采购", "sme_fair": "中小企业 应付账款 逾期 付款", "product_quality": "产品 服务质量 客户 召回",
    "data_privacy": "数据安全 隐私 网络安全", "employees": "员工 雇员 职业健康 劳动", "due_diligence": "尽职调查 负面影响",
    "stakeholder_communication": "利益相关方 沟通", "anti_bribery": "商业贿赂 腐败 廉洁 反贪", "anti_unfair_competition": "不正当竞争 反垄断 公平竞争"}


def retrieve_fragments(documents, topics, mappings):
    result = []
    for topic in topics:
        rows = [m for m in mappings if m["topicId"] == topic["id"]]
        if not rows: continue
        mapped_pages = {n for m in rows for n in m["sourcePage"]}
        terms = KEYWORDS.get(topic["id"], topic["name"]).split()
        ranked = []
        for doc in documents:
            for page in doc.get("pages") or []:
                for block in page["blocks"]:
                    text = block["text"]
                    for offset in range(0, len(text), MAX_EVIDENCE_CHARS):
                        fragment = text[offset:offset + MAX_EVIDENCE_CHARS]
                        normalized = normalize_pdf_text(fragment)
                        hits = sum(term in normalized for term in terms)
                        mapped = doc["meta"]["source"] == "main" and page["page"] in mapped_pages
                        if hits or mapped:
                            meta = doc["meta"]
                            item = {"id": cache_key(meta["sha256"], meta["source"], page["page"], block["id"], offset)[:24], "documentId": meta["id"], "source": meta["source"], "name": meta["name"],
                                    "page": page["page"], "text": fragment, "topicIds": [topic["id"]]}
                            ranked.append((hits + int(mapped) * 2, item))
        ranked.sort(key=lambda pair: -pair[0])
        result.extend(item for _, item in ranked[:MAX_EVIDENCE_PER_TOPIC])
    # One fragment can serve more than one mapped topic without duplicate text.
    merged = {}
    for item in result:
        if item["id"] in merged:
            merged[item["id"]]["topicIds"] = sorted(set(merged[item["id"]]["topicIds"] + item["topicIds"]))
        else:
            merged[item["id"]] = dict(item)
    return list(merged.values())


from datetime import datetime, timezone
from pipeline.jobs import Task, TaskRegistry
from pipeline.model_proxy import PROVIDERS
from pipeline.pdf_pages import DOCUMENTS
from pipeline.rules import load_rules


def mapping_input(rows, rules, main):
    if not isinstance(rows, list) or len(rows) > 6300:
        raise RequestError('议题映射无效，请重新对齐。')
    allowed = {t['id']: t for t in rules['topics']}; result = []
    for row in rows:
        if not isinstance(row, dict) or row.get('topicId') not in allowed:
            raise RequestError('议题映射包含本规则集以外的议题。')
        pages, title = row.get('sourcePage'), row.get('reportSection')
        if (not isinstance(title, str) or not title.strip() or len(title) > 240 or not isinstance(pages, list) or not pages
                or any(isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= main['meta']['pageCount'] for n in pages)):
            raise RequestError('映射缺少有效的主报告章节和物理页。')
        summary = '\n'.join(p.get('text', '') for p in main['pages'] if p['page'] in pages)[:MAX_CHAPTER_SUMMARY_CHARS]
        result.append({'topicId': row['topicId'], 'reportSection': title, 'sourcePage': sorted(set(pages)), 'sectionSummary': summary})
    return result


def assessment_rows(value, topics, evidence, mappings, mode, full_coverage):
    rows = value.get('assessments')
    if not isinstance(rows, list): raise contract('初评结果缺少 assessments 列表。')
    wanted = {t['id']: t for t in topics}; result = {}; by_id = {e['id']: e for e in evidence}
    for row in rows:
        if not isinstance(row, dict) or row.get('topicId') not in wanted or row['topicId'] in result: raise contract('初评议题遗漏、重复或超出本组。')
        topic_id = row['topicId']; topic = wanted[topic_id]
        if any(key.lower() in ('score', 'rating', 'officialrating', '分数', '评级') for key in row): raise contract('模型返回了范围外的评分或评级字段。')
        if any(not isinstance(row.get(k), str) for k in ('judgment', 'disclosedContent', 'gap', 'suggestion')): raise contract('初评结果缺少必需文字字段。')
        if any(len(row[k]) > ASSESSMENT_LIMITS['textCharsPerField'] for k in ('disclosedContent', 'gap', 'suggestion')): raise contract('初评文字过长，请缩小任务后重试。')
        judgment, ids = row['judgment'], row.get('evidenceIds')
        if judgment not in ('已披露', '部分披露', '未披露', '待全文核验') or not isinstance(ids, list) or len(ids) > MAX_REFERENCES: raise contract()
        if any(not isinstance(i, str) or i not in by_id or topic_id not in by_id[i]['topicIds'] for i in ids): raise contract('初评引用不在该议题给定的原文证据内。')
        if judgment in ('已披露', '部分披露') and not ids: raise contract('已披露或部分披露必须有有效出处。')
        if judgment in ('未披露', '待全文核验') and ids: raise contract('未披露或待全文核验不得附带披露引用。')
        if judgment == '未披露' and (mode == 'compatible' or not full_coverage): judgment = '待全文核验'
        refs = [dict(by_id[i]) for i in dict.fromkeys(ids)]
        for e in refs: e.pop('topicIds', None)
        sections = '；'.join(dict.fromkeys(m['reportSection'] for m in mappings if m['topicId'] == topic_id))
        assessment = {k: row[k] for k in ('disclosedContent', 'gap', 'suggestion')}
        if judgment == '待全文核验':
            assessment['disclosedContent'] = ''
            assessment['gap'] = '在本次可核验范围内未取得足够披露证据；需核对原报告全文。'
        assessment.update(judgment=judgment, evidence=refs, clause=topic['clause'], reportSectionSource=sections,
                          reportSource='；'.join(dict.fromkeys(f"{e['name']} · PDF 第 {e['page']} 页" for e in refs)), readingMode=mode,
                          assessmentVersion=ASSESS_VERSION, assessedAt=datetime.now(timezone.utc).isoformat())
        status = 'need_verify' if judgment == '待全文核验' else 'not_disclosed' if judgment == '未披露' else 'success'
        result[topic_id] = {'topicId': topic_id, 'status': status, 'assessment': assessment, 'readingMode': mode}
    if set(result) != set(wanted): raise contract('模型遗漏本组议题，已转入定向重试。')
    return result


class ReviewService:
    def __init__(self, documents=None, providers=None, cache=None, send=None):
        self.documents, self.providers, self.cache = documents or DOCUMENTS, providers or PROVIDERS, cache or CACHE
        self.send, self.jobs = send, TaskRegistry()

    def create(self, data, asynchronous=True):
        main = self.documents.parsed(data.get('documentId'))
        if main['meta']['source'] != 'main': raise RequestError('初评须指定主报告。')
        documents = [main]
        if data.get('annualDocumentId'):
            annual = self.documents.parsed(data['annualDocumentId'])
            if annual['meta']['source'] != 'annual': raise RequestError('补充证据须为独立登记的公司年报。')
            documents.append(annual)
        rules = load_rules(data.get('exchange'), data if data.get('exchange') == 'hk' else None)
        if data.get('rulesetVersion') != rules['version']: raise RequestError('项目规则版本与当前规则不一致，请新建当前版本项目。', 'ruleset_version', 409)
        if data.get('alignmentComplete') is not True: raise RequestError('请先完成自动章节对齐。', 'alignment_required', 409)
        selected = data.get('topicIds'); known = {t['id'] for t in rules['topics']}
        if not isinstance(selected, list) or not selected or len(selected) > len(known) or any(t not in known for t in selected): raise RequestError('请选择本规则集中的检查议题。')
        mappings = mapping_input(data.get('mappings'), rules, main)
        provider = self.providers.get(data.get('providerId'))
        context = {k: str(data.get(k, ''))[:160] for k in ('customerName', 'reportYear', 'targetYear', 'board', 'industry', 'issuerCategory', 'fiscalYearStart')}
        task = self.jobs.add(Task(provider['mode']))
        task.context = {'documents': documents, 'main': main, 'rules': rules, 'mappings': mappings, 'provider': provider, 'context': context,
                        'selected': list(dict.fromkeys(selected)), 'readCompleted': set()}
        task.update(totalPages=sum(d['meta']['pageCount'] for d in documents), rulesetVersion=rules['version'], readingVersion=READ_VERSION, assessmentVersion=ASSESS_VERSION,
                    topicIds=task.context['selected'])
        return task.start(lambda t: self._run(t, task.context['selected']), asynchronous)

    def retry(self, task_id, topic_ids=None, asynchronous=True):
        task = self.jobs.get(task_id)
        if task.thread and task.thread.is_alive(): raise RequestError('请等待当前任务结束或停止后重试。', 'job_state', 409)
        failed = {i for i, row in task.data['results'].items() if row['status'] == 'failed'}
        chosen = set(topic_ids or failed)
        if not chosen or not chosen.issubset(failed): raise RequestError('只能定向重试当前失败项。', 'job_state', 409)
        task.data['errors'] = [e for e in task.data['errors'] if not chosen.intersection(e.get('topicIds', []))]
        return task.start(lambda t: self._run(t, [i for i in task.context['selected'] if i in chosen]), asynchronous)

    def _error(self, task, topic_ids, exc, **extra):
        entry = {'topicIds': topic_ids, 'category': exc.category, 'message': str(exc), **extra}
        task.error(entry)
        for topic_id in topic_ids: task.result(topic_id, {'topicId': topic_id, 'status': 'failed', 'error': entry})

    def _run(self, task, target_ids):
        ctx = task.context; documents, rules, mappings, provider = (ctx[k] for k in ('documents', 'rules', 'mappings', 'provider'))
        topics = [t for t in rules['topics'] if t['id'] in target_ids]
        mapped_ids = {m['topicId'] for m in mappings}; active = [t for t in topics if t['id'] in mapped_ids]
        for topic in topics:
            if topic['id'] not in mapped_ids:
                task.data['results'][topic['id']] = {'topicId': topic['id'], 'status': 'need_verify', 'assessment': {
                    'judgment': '待全文核验', 'disclosedContent': '', 'gap': '主报告未找到可对应的章节映射，需人工核对全文。', 'suggestion': '核对原报告，必要时重新对齐并修正映射。',
                    'reportSource': '', 'reportSectionSource': '', 'clause': topic['clause'], 'evidence': [], 'readingMode': provider['mode'], 'assessmentVersion': ASSESS_VERSION}}
        if not active: task.update(phase='completed'); return
        reader = Reader(provider, task, rules['topics'], cache=self.cache, send=self.send,
                        assessment_guide=rules.get('assessmentGuide') if rules['exchange'] == 'hk' else None)
        evidence, read_failed = [], set()
        task.update(phase='reading')
        if provider['mode'] == 'native':
            def completed_page_count():
                completed = {}
                for document_id, first, last in ctx['readCompleted']:
                    completed.setdefault(document_id, set()).update(range(first, last + 1))
                return sum(len(pages) for pages in completed.values())

            def stop_after_read_failure(doc, start, end, exc):
                read_failed.update(t['id'] for t in active)
                failed_start, failed_end = getattr(exc, 'page_range', (start, end))
                stopped = RequestError(
                    f"PDF 第 {failed_start}–{failed_end} 页读取失败；本轮已停止发送后续页段。{exc}",
                    exc.category, exc.status)
                self._error(task, [t['id'] for t in active], stopped, phase='reading',
                            source=doc['meta']['source'], start=failed_start, end=failed_end,
                            batchStart=start, batchEnd=end)
                task.update(phase='reading_failed')
                raise stopped

            # Probe one page from each PDF before sending a larger page range.
            # This bounds waste when the provider cannot produce a complete receipt for a document.
            for doc in documents:
                try:
                    evidence.extend(reader.native_range(doc, 1, 1))
                except RequestError as exc:
                    stop_after_read_failure(doc, 1, 1, exc)
                ctx['readCompleted'].add((doc['meta']['id'], 1, 1))
                pages = completed_page_count()
                task.update(processedPages=pages, progress=round(60 * pages / task.data['totalPages']),
                            completedPieces=len(ctx['readCompleted']))
            for doc in documents:
                for relative_start, relative_end in reading_batches(doc["pages"][1:]):
                    start, end = relative_start + 1, relative_end + 1
                    task.checkpoint()
                    try:
                        evidence.extend(reader.native_range(doc, start, end)); ctx['readCompleted'].add((doc['meta']['id'], start, end))
                    except RequestError as exc:
                        stop_after_read_failure(doc, start, end, exc)
                    pages = completed_page_count()
                    task.update(processedPages=pages, progress=round(60 * pages / task.data['totalPages']), completedPieces=len(ctx['readCompleted']))
        else:
            fragments = retrieve_fragments(documents, active, mappings)
            pieces = groups(fragments, MAX_READ_EVIDENCE)
            for n, piece in enumerate(pieces, 1):
                task.checkpoint()
                try: evidence.extend(reader.compatible_group(piece))
                except RequestError as exc:
                    ids = sorted({topic_id for f in piece for topic_id in f['topicIds']}); read_failed.update(ids); self._error(task, ids, exc, phase='reading')
                task.update(completedPieces=n, progress=round(60*n/len(pieces)))
            task.update(processedPages=len({(f['documentId'], f['page']) for f in fragments}), coverage='retrieved_fragments')
        task.checkpoint(); task.update(phase='assessing')
        active = [t for t in active if t['id'] not in read_failed]
        for n, topic_group in enumerate(groups(active), 1):
            self._assess(task, topic_group, evidence, full_coverage=not read_failed and provider['mode'] == 'native' and completed_page_count() == task.data['totalPages'])
            task.update(progress=60 + round(40*n/max(1,len(groups(active)))))
        task.update(phase='completed')

    def _assess(self, task, topics, evidence, full_coverage):
        task.checkpoint(); ctx = task.context; provider, mappings, rules = (ctx[k] for k in ('provider', 'mappings', 'rules'))
        pending, keys, inputs = [], {}, []
        reference = assessment_reference(rules)
        reference_topics = {topic['id']: model_assessment_topic(topic, rules) for topic in topics}
        for topic in topics:
            selected = [e for e in evidence if topic['id'] in e['topicIds']]
            related = [m for m in mappings if m['topicId'] == topic['id']]
            key = cache_key([(d['meta']['sha256'], d['meta']['source'], d['meta']['name']) for d in ctx['documents']], topic['id'], rules['exchange'], rules['version'], ASSESS_VERSION,
                            provider['fingerprint'], provider['mode'], ctx['context'], related, [(e['id'], e['quote']) for e in selected], full_coverage,
                            rules['assessmentGuide']['fingerprint'])
            keys[topic['id']] = key; cached = self.cache.get('assessment', key)
            if cached:
                # Rebind runtime document IDs after restoring the same original file.
                for e in cached['assessment']['evidence']:
                    doc = next(d for d in ctx['documents'] if d['meta']['source'] == e['source']); e['documentId'] = doc['meta']['id']; e['name'] = doc['meta']['name']
                cached['assessment']['reportSource'] = '；'.join(dict.fromkeys(f"{e['name']} · PDF 第 {e['page']} 页" for e in cached['assessment']['evidence']))
                task.data['results'][topic['id']] = cached; continue
            pending.append(topic)
            inputs.append({**reference_topics[topic['id']], 'sections': related, 'evidence': [dict(e) for e in selected]})
        if not pending: return
        guide = {**reference, 'project': ctx['context'], 'readingMode': provider['mode'],
                 'fullPageCoverage': full_coverage, 'topics': inputs}
        if rules['exchange'] == 'hk':
            guide['market'] = '香港交易所附录C2官方中文规则；不得混用大陆交易所21议题。'
            guide['project'] = {**ctx['context'], 'issuerCategoryName': {'largecap': '恒生综合大型股指数成分股', 'mainboard': '其他主板发行人', 'gem': 'GEM发行人'}[ctx['context']['issuerCategory']]}
        if len(pending) > 8 or not fits(guide):
            if len(pending) > 1:
                midpoint = len(pending) // 2
                self._assess(task, pending[:midpoint], evidence, full_coverage)
                self._assess(task, pending[midpoint:], evidence, full_coverage)
                return
            try:
                record = self._window_assess(task, pending[0], guide, inputs[0], full_coverage)
                self._decorate(record, pending[0], rules)
                task.result(pending[0]['id'], record)
                self.cache.put('assessment', keys[pending[0]['id']], record)
            except RequestError as exc:
                self._error(task, [pending[0]['id']], exc, phase='assessing')
            return
        last = None
        remaining = list(pending)
        for _ in range(MAX_RETRIES + 1):
            try:
                task.checkpoint()
                guide['topics'] = [item for item in inputs if item['id'] in {t['id'] for t in remaining}]
                value = call_json(provider, json.dumps(guide, ensure_ascii=False), task.data['usage'], send=self.send, max_tokens=min(12000, 2500 + 1500 * len(remaining)))
                rows = value.get('assessments')
                if not isinstance(rows, list): raise contract('初评响应缺少 assessments。')
                if any(not isinstance(row, dict) or row.get('topicId') not in {t['id'] for t in remaining} for row in rows):
                    raise contract('初评返回本次请求以外的议题。')
                good = set()
                for topic in remaining:
                    matches = [row for row in rows if isinstance(row, dict) and row.get('topicId') == topic['id']]
                    if len(matches) != 1: continue
                    allowed_evidence = list({e['id']: e for item in guide['topics'] if item['id'] == topic['id'] for e in item['evidence']}.values())
                    try:
                        records = assessment_rows({'assessments': matches}, [topic], allowed_evidence, mappings, provider['mode'], full_coverage)
                    except RequestError as exc:
                        last = exc
                        continue
                    record = records[topic['id']]
                    self._decorate(record, topic, rules)
                    task.result(topic['id'], record)
                    self.cache.put('assessment', keys[topic['id']], record)
                    good.add(topic['id'])
                remaining = [topic for topic in remaining if topic['id'] not in good]
                if not remaining: return
                last = contract('模型遗漏或未正确返回部分议题；有效单项已保留，仅重试未完成项。')
            except RequestError as exc:
                last = exc
                if exc.category == 'model_length': break
                if exc.category in ('network', 'upstream'):
                    self._error(task, [t['id'] for t in remaining], exc, phase='assessing')
                    return
        if len(remaining) > 1:
            midpoint = len(remaining)//2
            self._assess(task, remaining[:midpoint], evidence, full_coverage)
            self._assess(task, remaining[midpoint:], evidence, full_coverage)
        else:
            self._error(task, [remaining[0]['id']], last, phase='assessing')

    def _window_assess(self, task, topic, guide, item, full_coverage):
        base = {k: v for k, v in guide.items() if k != 'topics'}
        base['fullPageCoverage'] = False
        base['window'] = {'index': len(item['evidence']), 'total': len(item['evidence'])}
        base['instruction'] += (f" 当前仅为证据窗口：未命中只代表本窗口，不代表全报告未披露。每个文字字段不超过{ASSESSMENT_LIMITS['textCharsPerField']}字，"
                                f"最多引用{ASSESSMENT_LIMITS['evidenceIds']}条证据。")
        windows = evidence_windows(base, item)
        provider, mappings = task.context['provider'], task.context['mappings']

        def evaluate(request, allowed, complete, budget):
            if not fits(request, budget):
                raise RequestError('完整方法、结论与证据超过合并预算，未截断；请拆分指标。', 'context_budget')
            key = cache_key(ASSESS_VERSION, provider['fingerprint'], request)
            raw = self.cache.get('assessment-window', key)
            for attempt in range(MAX_RETRIES + 1):
                try:
                    task.checkpoint()
                    value = {'assessments': [raw]} if raw is not None else call_json(provider, encoded(request), task.data['usage'], send=self.send, max_tokens=4096)
                    records = assessment_rows(value, [topic], allowed, mappings, 'native', complete)
                    raw = value['assessments'][0]
                    # Preserve uncertainty in merge inputs as well as the normalized UI record.
                    raw = {**raw, 'judgment': records[topic['id']]['assessment']['judgment']}
                    self.cache.put('assessment-window', key, raw)
                    return raw, records[topic['id']]
                except RequestError as exc:
                    raw = None
                    if exc.category in ('network', 'upstream', 'context_budget') or attempt == MAX_RETRIES: raise
                    request['correction'] = str(exc)
            raise contract()

        nodes = []
        for index, window in enumerate(windows):
            request = {**base, 'topics': [{**item, 'evidence': window}], 'window': {'index': index + 1, 'total': len(windows)}}
            if len(windows) == 1:
                request = {**guide, 'topics': [{**item, 'evidence': window}]}
            raw, record = evaluate(request, window, full_coverage if len(windows) == 1 else False, INPUT_BUDGET)
            nodes.append((raw, window))
            task.update(assessmentWindow=index + 1, assessmentWindows=len(windows))
        while len(nodes) > 1:
            next_nodes = []
            for index in range(0, len(nodes), 2):
                pair = nodes[index:index + 2]
                if len(pair) == 1:
                    next_nodes.extend(pair)
                    continue
                cited = list({e['id']: e for raw, pool in pair for e in pool if e['id'] in raw['evidenceIds']}.values())
                final = len(nodes) == 2
                request = {**guide, 'task': 'assess_topics', 'topics': [{**item, 'evidence': cited}],
                           'fullPageCoverage': full_coverage if final else False,
                           'windowConclusions': [raw for raw, _ in pair],
                           'instruction': guide['instruction'] + f" 所有证据窗口已分别检查。综合所给子结论及其原始引用，保留不同年度、边界、矛盾与未解决缺口；不得按多数投票。局部未命中不能直接推为全文未披露。仅最后合并且全文读取完整时可判定全文未披露。每个文字字段不超过{ASSESSMENT_LIMITS['textCharsPerField']}字，最多{ASSESSMENT_LIMITS['evidenceIds']}条引用。"}
                raw, record = evaluate(request, cited, full_coverage if final else False, MERGE_BUDGET)
                next_nodes.append((raw, cited))
            nodes = next_nodes
        record['assessment']['evidenceWindowCount'] = len(windows)
        record['assessment']['evidenceConsidered'] = len(item['evidence'])
        return record

    def _decorate(self, record, topic, rules):
        if rules.get('assessmentGuide'):
            record['assessment']['methodologyVersion'] = rules['assessmentGuide']['methodologyVersion']
            record['assessment']['methodologyFingerprint'] = rules['assessmentGuide']['fingerprint']
        if rules['exchange'] == 'hk':
            record['assessment']['obligation'] = topic['obligation']
            record['assessment']['questionVersion'] = rules['assessmentGuide']['questionVersion']
            if topic['obligation'] == 'voluntary' and not record['assessment']['evidence']:
                record['assessment']['gap'] = '自愿披露项目：本次未取得可核验证据，不据此判定违反强制披露要求。'
                record['assessment']['suggestion'] = '可自愿补充本指标内容；仍需核对原报告与具体适用条件。'



REVIEWS = ReviewService()
