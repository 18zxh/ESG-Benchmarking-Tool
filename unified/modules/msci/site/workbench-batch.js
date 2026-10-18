import {
  ALL_CRITERIA,
  uid,
  assessmentRecordKey,
  assessmentDocumentId,
  snapshotCriterion,
  retrieveEvidence,
  buildEvaluationInput,
  validateModelDraft,
  appendAiRuns,
  invalidateReview,
} from "./workbench-core.js";

export function criteriaForIssues(issueIds) {
  const selected = new Set(issueIds || []);
  return ALL_CRITERIA.filter((c) => selected.has(c.issueId));
}
export function taskContext(workspace) {
  return JSON.stringify([
    assessmentDocumentId(workspace),
    workspace.project,
    criteriaForIssues(workspace.selectedIssueIds).map((c) => c.id),
  ]);
}
export function criterionQuery(criterion) {
  const item = criterion.item;
  return [
    criterion.issueName,
    criterion.issueNameEn,
    item.nameCn,
    item.name,
    item.parentCn,
    item.definitionCn,
  ]
    .filter(Boolean)
    .join(" ");
}
export function ensureRecord(workspace, criterion) {
  const key = assessmentRecordKey(
    criterion.id,
    assessmentDocumentId(workspace),
    workspace.project,
  );
  return (workspace.records[key] ||= {
    criterionId: criterion.id,
    documentId: assessmentDocumentId(workspace),
    reportDocumentId: workspace.documentId || "manual",
    annualDocumentId: workspace.annual?.id || "",
    documentName: workspace.documentName,
    project: { ...workspace.project },
    criterionSnapshot: snapshotCriterion(criterion),
    aiRuns: [],
    manualEvidence: [],
    review: { decision: "pending", score: "", notes: "", confirmedAt: "" },
  });
}
export function createBatch(workspace) {
  const criteria = criteriaForIssues(workspace.selectedIssueIds),
    states = {};
  workspace.records ||= {};
  for (const criterion of criteria) {
    states[criterion.id] = { status: "pending", error: "" };
    const record = ensureRecord(workspace, criterion);
    appendAiRuns(record, []);
    record.taskStatus = "pending";
  }
  return {
    id: uid(),
    context: taskContext(workspace),
    createdAt: new Date().toISOString(),
    states,
    phase: "ready",
  };
}
export function batchCounts(batch) {
  const counts = {
    total: 0,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    needs_evidence: 0,
  };
  for (const state of Object.values(batch?.states || {})) {
    counts.total++;
    if (Object.hasOwn(counts, state.status)) counts[state.status]++;
  }
  return counts;
}
const BOUNDARY_QUERY = "报告范围 统计边界 报告期 母公司 子公司 合并范围";
// semanticScores 为可选的异步函数（query）=> 与 chunks 对齐的余弦相似度；
// 未提供或返回空时按纯关键词检索，行为与历史一致。
export async function automaticEvidence(
  chunks,
  criterion,
  manualEvidence = [],
  semanticScores = null,
) {
  const query = criterionQuery(criterion);
  const candidates = retrieveEvidence(chunks, query, 40, {
    semanticScores: semanticScores ? await semanticScores(query) : null,
  });
  const hits = [], counts = new Map(), texts = new Set();
  for (const hit of candidates) {
    // 页码配额与相邻片段按来源分开：年报与主报告同页码不互相挤占，也不跨报告取上下文。
    const identity = hit.text.replace(/\s/g, ""), page = (hit.source || "") + ":" + (hit.pdfPage || hit.heading);
    if (texts.has(identity) || (counts.get(page) || 0) >= 4) continue;
    texts.add(identity); counts.set(page, (counts.get(page) || 0)+1); hits.push(hit);
    if (hits.length >= 16) break;
  }
  if (!hits.length && !manualEvidence.length) return [];
  const boundary = retrieveEvidence(chunks, BOUNDARY_QUERY, 3, {
    semanticScores: semanticScores ? await semanticScores(BOUNDARY_QUERY) : null,
  });
  const neighbors = hits.flatMap((hit) => {
    const index = chunks.findIndex((chunk) => chunk.id === hit.id);
    return [chunks[index-1], chunks[index+1]].filter((chunk) => chunk && chunk.pdfPage === hit.pdfPage && chunk.blockId === hit.blockId && chunk.source === hit.source);
  });
  return [
    ...new Map(
      [...manualEvidence.slice(0,4), ...hits, ...boundary, ...neighbors].map((e) => [e.id, e]),
    ).values(),
  ].slice(0, 24);
}
export function normalizeRuns(data, chosen, evidence, evaluation) {
  if (
    !Array.isArray(data.results) ||
    data.results.length !== chosen.length ||
    new Set(data.results.map((r) => r.providerId)).size !== chosen.length ||
    data.results.some((r) => !chosen.some((p) => p.id === r.providerId))
  )
    throw new Error("模型返回不完整，请重试本项。");
  return data.results.map((result) => {
    const draft = validateModelDraft(
      result.content,
      evidence.map((e) => e.id),
      evaluation.criterion.numeric_scale_available,
    );
    const problems = [...(result.groundingIssues || [])];
    if (draft.rejectedEvidenceRefs?.length)
      problems.push("引用了本次未提供的证据。");
    if (draft.scoreSuppressed)
      problems.push("来源没有数值标尺，模型仍提出分数。");
    if (evidence.some((e) => e.requiresReview) && draft.valid)
      draft.uncertainties = [
        ...new Set([
          ...(draft.uncertainties || []),
          ...evidence.filter((e) => e.requiresReview).map((e) => "原文识别提示：" + (e.warning || "此片段存在识别异常。")),
        ]),
      ];
    if (result.finishReason === "length")
      problems.push("模型输出被长度限制截断。");
    if (result.error || problems.length) {
      draft.valid = false;
      draft.error = result.error || problems.join(" ");
    }
    return {
      providerId: result.providerId,
      providerName: result.providerName,
      model: result.model,
      createdAt: data.completedAt || new Date().toISOString(),
      finishReason: result.finishReason || "",
      evidence: evidence.map((e) => ({ ...e })),
      draft,
      error: result.error || "",
      groundingIssues: problems,
      analysisRequirement: result.analysisRequirement,
      validationChecks: (result.validationAttempts || []).map(
        ({ attempt, issues }) => ({ attempt, issues }),
      ),
    };
  });
}

// Bounded queue: pausing affects tasks that have not been sent. An in-flight task
// is allowed to finish so its remote request and local result cannot diverge.
export class AssessmentQueue {
  constructor({
    workspace,
    chunks,
    providers,
    request,
    onChange = () => {},
    concurrency = 2,
    semanticScores = null,
  }) {
    Object.assign(this, {
      workspace,
      chunks,
      providers,
      request,
      onChange,
      semanticScores,
    });
    this.concurrency = Math.max(1, Math.min(2, concurrency));
    this.running = false;
    this.paused = false;
    this.stopped = false;
  }
  pause() {
    this.paused = true;
    this.workspace.batch.phase = "pausing";
    this.onChange();
  }
  stop() {
    this.stopped = true;
    this.workspace.batch.phase = "stopping";
    this.onChange();
  }
  async run({ retryIds = [] } = {}) {
    if (this.running) return;
    const batch = this.workspace.batch;
    if (!batch || batch.context !== taskContext(this.workspace))
      throw new Error("项目内容已变化，请重新创建任务。");
    for (const id of retryIds)
      if (batch.states[id]) batch.states[id] = { status: "pending", error: "" };
    this.running = true;
    this.paused = false;
    this.stopped = false;
    batch.phase = "running";
    this.onChange();
    const pending = Object.keys(batch.states).filter(
      (id) => batch.states[id].status === "pending",
    );
    let cursor = 0;
    const worker = async () => {
      while (!this.paused && !this.stopped && cursor < pending.length) {
        if (batch.context !== taskContext(this.workspace)) {
          this.stopped = true;
          break;
        }
        const id = pending[cursor++],
          criterion = ALL_CRITERIA.find((c) => c.id === id),
          state = batch.states[id],
          record = ensureRecord(this.workspace, criterion);
        state.status = "running";
        record.taskStatus = "running";
        invalidateReview(record);
        this.onChange();
        // 语义检索失败只降级为关键词检索，不阻断本项初评。
        const evidence = await automaticEvidence(
          this.chunks,
          criterion,
          record.manualEvidence,
          this.semanticScores
            ? async (query) => {
                try {
                  return await this.semanticScores(this.chunks, query);
                } catch {
                  return null;
                }
              }
            : null,
        );
        if (!evidence.length) {
          appendAiRuns(record, [{providerId:"system-search",providerName:"系统检索",model:"keyword-search",createdAt:new Date().toISOString(),evidence:[],draft:{valid:true,disclosureStatus:"not_found",suggestedScore:"",scoreBasis:"",rationale:"本次检索未找到相关原文，未调用模型。",evidenceRefs:[],gaps:["未披露"],recommendation:"补充该指标对应的披露。",confidence:"low",uncertainties:[],currentDisclosure:"未披露",informationRequests:[],priority:"medium",groundedFindings:[]}}]);
          state.status = record.taskStatus = "completed";
          state.error = "";
          this.onChange();
          continue;
        }
        try {
          const evaluation = buildEvaluationInput(
              criterion,
              evidence,
              this.workspace.project,
              {...this.workspace.documentMeta, indexedChunks:this.chunks.length},
            ),
            data = await this.request({
              providerIds: this.providers.map((p) => p.id),
              evaluation,
            });
          const runs = normalizeRuns(
            data,
            this.providers,
            evidence,
            evaluation,
          );
          appendAiRuns(record, runs);
          // All selected models must return valid drafts to count this item as complete.
          state.status = record.taskStatus = runs.every((r) => r.draft.valid)
            ? "completed"
            : "failed";
          state.error = runs
            .filter((r) => !r.draft.valid)
            .map((r) => r.draft.error || r.error || "模型结果校验失败。")
            .join(" ");
        } catch (error) {
          state.status = record.taskStatus = "failed";
          state.error = error.message || "请求失败，请重试本项。";
          appendAiRuns(
            record,
            this.providers.map((p) => ({
              providerId: p.id,
              providerName: p.name,
              model: p.model,
              createdAt: new Date().toISOString(),
              evidence,
              error: state.error,
              draft: { valid: false, error: state.error },
            })),
          );
        }
        this.onChange();
      }
    };
    try {
      await Promise.all(Array.from({ length: this.concurrency }, worker));
    } finally {
      this.running = false;
      batch.phase = this.stopped
        ? "stopped"
        : this.paused
          ? "paused"
          : "finished";
      this.onChange();
    }
  }
}
