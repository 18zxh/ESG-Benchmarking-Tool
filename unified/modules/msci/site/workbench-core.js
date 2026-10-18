import { KEY_ISSUES } from "./data/key-issues.js";
import { META, SOURCES } from "./data/core.js";
import {
  disclosureSearchExpansion,
  normalizeDisclosureSearch,
} from "./disclosure-search.js";

export const MAX_PARSED_BYTES = 16 * 1024 * 1024;
export const MAX_MARKDOWN_BYTES = MAX_PARSED_BYTES; // Legacy draft readers only.
export const MAX_CHUNK_CHARS = 1100;
export const MAX_SELECTED_EVIDENCE = 24;
export const MAX_MANUAL_EVIDENCE = 100;
// 混合检索融合：BM25 关键词得分（归一化后）与 EmbeddingGemma 2 余弦相似度
// 加权。没有关键词命中、仅靠语义命中的片段须超过 SEMANTIC_ONLY_FLOOR 才进入
// 候选，避免弱相关片段淹没关键词命中。不传语义分数时行为与纯关键词检索一致。
const SEMANTIC_WEIGHT = 0.45;
const SEMANTIC_ONLY_FLOOR = 0.5;
const VERDICTS = new Set([
  "full",
  "partial",
  "not_found",
  "conflicting",
  "insufficient_evidence",
  "not_applicable",
]);
export const STATUS_LABELS = {
  full: "充分披露",
  partial: "部分披露",
  not_found: "未披露",
  conflicting: "证据矛盾",
  insufficient_evidence: "未披露",
  not_applicable: "不适用",
};
export const REVIEW_LABELS = {
  pending: "待复核",
  accepted: "接受智能初评",
  revised: "已修订并确认",
  not_applicable: "确认不适用",
};
export const htmlEsc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const uid = () =>
  globalThis.crypto?.randomUUID?.() ||
  "wb-" + Date.now() + "-" + Math.random().toString(36).slice(2);

function criterionFingerprint(issue, kind, index, item) {
  const input = JSON.stringify([
    META.checkedOn,
    issue.doc?.version || "",
    SOURCES[issue.sourceId]?.sha256 || "",
    kind,
    index,
    item,
  ]);
  let a = 2166136261,
    b = 2246822519;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    a = Math.imul(a ^ code, 16777619);
    b = Math.imul(b ^ code, 3266489917);
  }
  return (
    (a >>> 0).toString(16).padStart(8, "0") +
    (b >>> 0).toString(16).padStart(8, "0")
  );
}

export function listWorkbenchCriteria(issues = KEY_ISSUES) {
  return issues.flatMap((issue) => [
    ...issue.indicators.map((item, index) => ({
      id:
        issue.id +
        "::indicator::" +
        index +
        "::" +
        criterionFingerprint(issue, "indicator", index, item),
      baseId: issue.id + "::indicator::" + index,
      issueId: issue.id,
      issueName: issue.name,
      issueNameEn: issue.nameEn,
      pillar: issue.pillar,
      type: issue.type,
      kind: "indicator",
      item,
      index,
      sourceId: issue.sourceId,
      pages: item.sourcePages || [],
    })),
    ...issue.keyMetrics.map((item, index) => ({
      id:
        issue.id +
        "::metric::" +
        index +
        "::" +
        criterionFingerprint(issue, "metric", index, item),
      baseId: issue.id + "::metric::" + index,
      issueId: issue.id,
      issueName: issue.name,
      issueNameEn: issue.nameEn,
      pillar: issue.pillar,
      type: issue.type,
      kind: "metric",
      item,
      index,
      sourceId: issue.sourceId,
      pages: item.sourcePages || [],
    })),
  ]);
}
export const ALL_CRITERIA = listWorkbenchCriteria();
export const CRITERION_BY_ID = new Map(
  ALL_CRITERIA.map((item) => [item.id, item]),
);
export const CRITERION_BY_BASE_ID = new Map(
  ALL_CRITERIA.map((item) => [item.baseId, item]),
);

export function parseMarkdown(
  text,
  filename = "report.md",
  maxChars = MAX_CHUNK_CHARS,
) {
  maxChars = Math.min(1800, Math.max(256, Number(maxChars) || MAX_CHUNK_CHARS));
  const lines = String(text ?? "")
      .replace(/\r\n?/g, "\n")
      .split("\n"),
    chunks = [],
    headings = [];
  let buffer = [],
    start = 1,
    length = 0,
    pdfPage = null;
  const push = (body, lineStart, lineEnd, extra = {}) => {
    if (body.trim())
      chunks.push({
        id: "doc-" + String(chunks.length + 1).padStart(5, "0"),
        filename,
        lineStart,
        lineEnd,
        heading: headings.filter(Boolean).join(" / "),
        text: body.trim(),
        source: filename,
        ...(pdfPage ? { pdfPage } : {}),
        ...extra,
      });
  };
  const flush = () => {
    if (!buffer.length) return;
    const body = buffer.join("\n").trim();
    push(body, start, start + buffer.length - 1);
    buffer = [];
    length = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i],
      heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flush();
      const pageMatch = heading[2].match(/^PDF 第 (\d+) 页/);
      if (pageMatch) pdfPage = Number(pageMatch[1]);
      headings[heading[1].length - 1] = heading[2].trim();
      headings.length = heading[1].length;
      start = i + 1;
      continue;
    }
    const separator = lines[i + 1] || "";
    if (
      line.includes("|") &&
      /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(separator)
    ) {
      flush();
      const header = line + "\n" + separator,
        contextLines = [{ lineStart: i + 1, lineEnd: i + 2 }];
      let end = i + 2;
      while (
        end < lines.length &&
        lines[end].includes("|") &&
        lines[end].trim()
      )
        end++;
      if (header.length >= 1500 || end === i + 2) {
        for (let row = i; row < end; row++)
          for (let at = 0; at < lines[row].length; at += maxChars)
            push(lines[row].slice(at, at + maxChars), row + 1, row + 1, {
              requiresReview: true,
              warning: "表格过宽或缺少数据行，请对照 PDF 核验列关系。",
            });
      } else {
        let rows = [],
          rowStart = i + 3;
        const flushRows = () => {
          if (rows.length)
            push(
              header + "\n" + rows.join("\n"),
              rowStart,
              rowStart + rows.length - 1,
              { contextLines, table: true },
            );
          rows = [];
        };
        for (let row = i + 2; row < end; row++) {
          if (header.length + 1 + lines[row].length > 1800) {
            flushRows();
            const budget = 1800 - header.length - 1;
            for (let at = 0; at < lines[row].length; at += budget)
              push(
                header + "\n" + lines[row].slice(at, at + budget),
                row + 1,
                row + 1,
                {
                  contextLines,
                  table: true,
                  requiresReview: true,
                  warning: "超长表格行已拆分，请人工核验列关系。",
                },
              );
          } else {
            if (
              rows.length &&
              header.length +
                1 +
                rows.join("\n").length +
                1 +
                lines[row].length >
                maxChars
            )
              flushRows();
            if (!rows.length) rowStart = row + 1;
            rows.push(lines[row]);
          }
        }
        flushRows();
      }
      i = end - 1;
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (!buffer.length) start = i + 1;
    if (line.length > maxChars) {
      flush();
      for (let at = 0; at < line.length; at += maxChars)
        push(line.slice(at, at + maxChars), i + 1, i + 1, {
          requiresReview: true,
          warning: "超长原文行已拆分，需核对前后文。",
        });
      continue;
    }
    if (buffer.length && length + line.length + 1 > 1800) flush();
    if (!buffer.length) start = i + 1;
    buffer.push(line);
    length += line.length + 1;
    if (length >= maxChars) flush();
  }
  flush();
  return chunks;
}

// The PDF parser owns page/block boundaries. Long blocks are split without dropping
// characters; table headers and nearby unit/footnote text accompany every part.
function splitReportBlock(text, context = "", maxChars = 3500) {
  const prefix = context ? context + "\n" : "";
  const budget = maxChars - prefix.length;
  if (budget < 400) return splitReportBlock(context + "\n" + text, "", maxChars);
  const pieces = [];
  let body = "";
  const flush = () => { if (body.trim()) pieces.push(prefix + body.trim()); body = ""; };
  for (const line of String(text || "").split("\n")) {
    if (line.length > budget) {
      flush();
      for (let at = 0; at < line.length; at += budget)
        pieces.push(prefix + line.slice(at, at + budget));
    } else {
      if (body.length + line.length + 1 > budget) flush();
      body += (body ? "\n" : "") + line;
    }
  }
  flush();
  return pieces;
}
// source 标明片段来自哪份上传文件："main" 为主报告（默认），"annual" 为公司年报。
// 年报片段在标题加「年报 」前缀、编号加 annual- 前缀，避免与主报告混淆或撞号。
export function parseReport(text, filename, meta = {}, source = "main") {
  const annual = source === "annual",
    prefix = annual ? "年报 " : "",
    sourceLabel = annual ? "annual" : "main";
  if (!meta.pages?.some((page) => Array.isArray(page.blocks)))
    return parseMarkdown(text, filename).map((chunk) => ({
      ...chunk, requiresReview: Boolean(chunk.warning),
      warning: chunk.warning || "", extractionMethod: "legacy",
      id: annual ? "annual-" + chunk.id : chunk.id,
      heading: chunk.heading ? prefix + chunk.heading : prefix.trim(),
      source: sourceLabel,
    }));
  const chunks = [];
  const labels = {text:"正文", "layout-text":"按位置读取的正文", "image-text":"图像文字", table:"表格"};
  for (const page of meta.pages) {
    for (const block of page.blocks || []) {
      const context = block.type === "table"
        ? [block.headerText, block.contextText && "表格附近的标题、单位和脚注：\n"+block.contextText].filter(Boolean).join("\n")
        : "";
      const parts = splitReportBlock(block.text, context);
      parts.forEach((body, index) => {
        const uncertain = block.uncertainTexts?.filter((value)=>body.includes(value));
        chunks.push({
        id: (annual ? "annual-" : "") + "pdf-" + block.id + "-" + (index+1), filename, source:sourceLabel,
        pdfPage:page.page, blockId:block.id, blockType:block.type,
        heading:prefix + "PDF 第 " + page.page + " 页 · " + (labels[block.type] || "原文"),
        text:body, lineStart:chunks.length+1, lineEnd:chunks.length+1,
        part:index+1, partCount:parts.length,
        table:block.type === "table", headerText:block.headerText || "",
        bbox:block.bbox || [], extractionMethod:block.method || block.structureSource || "",
        requiresReview:uncertain ? Boolean(uncertain.length) : Boolean(block.requiresReview),
        warning:uncertain ? (uncertain.length ? "此片段有识别不确定文字："+uncertain.join("；") : "") : block.warning || "",
      });});
    }
  }
  return chunks;
}

export function isSupportedMarkdownFilename(filename) {
  return /\.(?:md|markdown)$/i.test(String(filename || ""));
}

// 图表转述片段：数字可能识别错误，必须标记待人工复核并在检索中降权。
// source 同 parseReport："annual" 时标题与编号带年报标记。
export function figureChunk(figure, text, source = "main") {
  const page = Number(figure?.page) || 0;
  const index = Number(String(figure?.id || "").split("-").pop()) || 0;
  const annual = source === "annual";
  return {
    id: (annual ? "annual-" : "") + String(figure?.id || "fig-" + page + "-" + (index || 1)),
    pdfPage: page,
    heading: (annual ? "年报 " : "") + "PDF 第 " + page + " 页 · 图（AI 转述）",
    text: "【图表转述·待人工复核】\n" + String(text ?? "").trim(),
    table: false,
    requiresReview: true,
    source: annual ? "annual" : "main",
    lineStart: page * 10000 + index,
    lineEnd: page * 10000 + index,
  };
}

function tokenize(value) {
  const text = normalizeDisclosureSearch(value),
    tokens = [];
  for (const match of text.matchAll(
    /[\p{Script=Han}]+|[a-z0-9][a-z0-9.+#%/_-]*/giu,
  )) {
    const token = match[0];
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      if (token.length === 1) tokens.push(token);
      for (let i = 0; i < token.length - 1; i++)
        tokens.push(token.slice(i, i + 2));
    } else if (token.length > 1 || /[0-9]/.test(token)) tokens.push(token);
  }
  return tokens;
}

const WB_RETRIEVAL_INDEX = new WeakMap();

export function retrieveEvidence(chunks, query, topK = 8, options = {}) {
  const original = new Set(tokenize(query));
  if (!original.size || !chunks?.length) return [];
  const extra =
      options.expand === false ? [] : disclosureSearchExpansion(query),
    terms = [...new Set([...original, ...tokenize(extra.join(" "))])];
  let index = WB_RETRIEVAL_INDEX.get(chunks);
  if (
    !index ||
    index.docs.length !== chunks.length ||
    index.docs.some(
      (doc, i) => doc.chunk !== chunks[i] || doc.text !== chunks[i].text,
    )
  ) {
    const docs = chunks.map((chunk) => {
      const counts = new Map(),
        tokens = tokenize(chunk.text);
      for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
      return { chunk, text: chunk.text, counts, length: tokens.length };
    });
    index = { docs };
    WB_RETRIEVAL_INDEX.set(chunks, index);
  }
  const docs = index.docs;
  const df = new Map();
  for (const term of terms) {
    let n = 0;
    for (const doc of docs) if (doc.counts.has(term)) n++;
    df.set(term, n);
  }
  const avg = Math.max(1, docs.reduce((n, d) => n + d.length, 0) / docs.length),
    k1 = 1.2,
    b = 0.75,
    N = docs.length;
  const semantic =
    options.semanticScores instanceof Float32Array ||
    Array.isArray(options.semanticScores)
      ? options.semanticScores
      : null;
  const useSemantic = Boolean(semantic && semantic.length === chunks.length);
  const scored = docs.map(({ chunk, counts, length }, position) => {
    let score = 0;
    for (const term of terms) {
      const f = counts.get(term) || 0;
      if (!f) continue;
      const idf = Math.log(
        1 + (N - df.get(term) + 0.5) / (df.get(term) + 0.5),
      );
      score +=
        ((original.has(term) ? 1 : 0.25) * idf * (f * (k1 + 1))) /
        (f + k1 * (1 - b + (b * length) / avg));
    }
    // Keep every readable block searchable, but prefer dependable originals
    // over a second OCR pass containing known recognition noise.
    const quality = chunk.requiresReview ? 0.35 : chunk.table ? 1.1 : 1;
    return {
      chunk,
      relevance: score * quality,
      cosine: useSemantic ? Number(semantic[position]) || 0 : 0,
    };
  });
  const topN = Math.max(1, Math.min(48, Number(topK) || 16));
  const rank = (list) =>
    list
      .sort((a, b2) => b2.relevance - a.relevance || a.lineStart - b2.lineStart)
      .slice(0, topN);
  if (!useSemantic)
    return rank(
      scored
        .filter((x) => x.relevance > 0)
        .map((x) => ({ ...x.chunk, relevance: x.relevance })),
    );
  const maxRelevance = scored.reduce(
    (max, x) => Math.max(max, x.relevance),
    0,
  );
  return rank(
    scored
      .filter((x) => x.relevance > 0 || x.cosine >= SEMANTIC_ONLY_FLOOR)
      .map((x) => ({
        ...x.chunk,
        relevance:
          (1 - SEMANTIC_WEIGHT) *
            (maxRelevance > 0 ? x.relevance / maxRelevance : 0) +
          SEMANTIC_WEIGHT * x.cosine,
      }))
      .filter((x) => x.relevance > 0),
  );
}

export async function documentIdentity(text) {
  if (!globalThis.crypto?.subtle)
    throw new Error("浏览器无法计算文档指纹，请通过本机 HTTP 工作台打开。");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(text || "")),
  );
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}
// A PDF task binds both its extracted text and its original file/converter.
export async function reportIdentity(text, meta = {}) {
  const markdownSha256 = await documentIdentity(text);
  const documentId = meta.originalSha256
    ? await documentIdentity(
        JSON.stringify([
          markdownSha256,
          meta.originalSha256,
          meta.converterVersion || "unknown",
        ]),
      )
    : markdownSha256;
  return { documentId, markdownSha256 };
}
// Preserve main-only history while isolating every main/annual report pair.
export function assessmentDocumentId(workspace) {
  const main = workspace.documentId || "manual";
  return workspace.annual?.id
    ? JSON.stringify(["reports-v1", main, workspace.annual.id])
    : main;
}
export function assessmentRecordKey(criterionId, documentId, project = {}) {
  const parts = [
    String(documentId || "manual"),
    String(project.client_name || ""),
    String(project.report_period || ""),
    String(project.target_period || ""),
    String(criterionId),
  ];
  if (String(project.assessment_scope || "").trim())
    parts.push(String(project.assessment_scope).trim());
  return JSON.stringify(parts);
}
export function selectProjectRecords(records, documentId, project = {}) {
  return Object.fromEntries(
    Object.entries(records || {}).filter(
      ([, record]) =>
        record.criterionId &&
        assessmentRecordKey(
          record.criterionId,
          record.documentId,
          record.project,
        ) === assessmentRecordKey(record.criterionId, documentId, project),
    ),
  );
}
export function invalidateReview(record) {
  const review = record.review || {};
  record.review = {
    ...review,
    decision: "pending",
    score: review.score || "",
    notes: review.notes || "",
    confirmedAt: "",
  };
}
export function appendAiRuns(record, runs) {
  record.latestBatchId = uid();
  record.aiRuns = [
    ...runs.map((run) => ({ ...run, batchId: record.latestBatchId })),
    ...(record.aiRuns || []),
  ].slice(0, 12);
  invalidateReview(record);
}
export function latestAiRuns(record) {
  const runs = record?.aiRuns || [];
  if (record?.latestBatchId)
    return runs.filter((run) => run.batchId === record.latestBatchId);
  return runs[0]?.createdAt
    ? runs.filter((run) => run.createdAt === runs[0].createdAt)
    : runs.slice(0, 1);
}
export function reviewError(record) {
  const review = record?.review || {};
  if (!["accepted", "revised", "not_applicable"].includes(review.decision))
    return "请选择人工复核结论。";
  if (
    review.decision === "accepted" &&
    !latestAiRuns(record).some(
      (run) => run.model !== "keyword-search" && run.draft?.valid && !run.error && !run.groundingIssues?.length,
    )
  )
    return "本次批次没有有效 AI 初评，不能用历史结果替代；请重新运行或填写人工修订结论。";
  if (
    ["revised", "not_applicable"].includes(review.decision) &&
    !String(review.notes || "").trim()
  )
    return "请填写人工修订或不适用的依据，再确认复核。";
  return "";
}
export function evidenceLocation(entry) {
  if (entry.pdfPage) return "PDF 第 " + entry.pdfPage + " 页" +
    (entry.table ? " · 表格" : entry.blockType === "image-text" ? " · 图像文字" : "") +
    (entry.partCount > 1 ? " · 第 " + entry.part + "/" + entry.partCount + " 段" : "");
  return String(entry.location || (entry.lineStart ? "原文第 "+entry.lineStart+"–"+entry.lineEnd+"行" : "手工摘录")) +
    (entry.contextLines?.length ? "；表头原文第 "+entry.contextLines.map((line)=>line.lineStart+"–"+line.lineEnd).join("、")+" 行" : "");
}
export function buildEvaluationInput(criterion, evidence, project = {}, report = {}) {
  const item = criterion.item,
    def = item.definition || "";
  const cleanProject = Object.fromEntries(
    ["client_name", "report_period", "target_period"].map((key) => [
      key,
      String(project[key] || "").slice(0, key === "client_name" ? 120 : 80),
    ]),
  );
  if (String(project.assessment_scope || "").trim())
    cleanProject.assessment_scope = String(project.assessment_scope)
      .trim()
      .slice(0, 1000);
  const chosen = (evidence || []).slice(0, MAX_SELECTED_EVIDENCE);
  if (chosen.some((entry) => String(entry.text || "").length > 3500))
    throw new Error(
      "单条证据超过 3500 字，请拆分后重新选择；系统不会截断原文。",
    );
  return {
    project: cleanProject,
    report: {page_count:report.pageCount || 0,processed_pages:report.processedPages || 0,readable_pages:report.readablePages || 0,table_count:report.tableCount || 0,page_coverage_complete:report.pageCoverageComplete === true,indexed_chunks:report.indexedChunks || 0,selected_chunks:chosen.length},
    criterion: {
      issue: criterion.issueName,
      issue_en: criterion.issueNameEn,
      pillar: criterion.pillar,
      type: criterion.type,
      title: item.nameCn || item.name,
      title_en: item.name || item.fullName || "",
      definition: item.definitionCn || "",
      definition_en: def,
      parent: item.parentCn || item.parent || "",
      scoring_rule: item.scoringText || item.deduction || item.range || "",
      source_pages: criterion.pages,
      numeric_scale_available: Boolean(
        item.scoringText || item.deduction || item.range,
      ),
    },
    evidence: chosen.map((entry) => ({
      id: String(entry.id),
      source: String(entry.source || "用户证据"),
      location: evidenceLocation(entry),
      heading: String(entry.heading || ""),
      quality_note: entry.requiresReview
        ? String(entry.warning || "提取质量须人工核验。")
        : "",
      text: String(entry.text || ""),
    })),
  };
}

export function validateModelDraft(
  content,
  allowedEvidenceIds = [],
  numericScaleAvailable = true,
) {
  const source = String(content ?? "").trim();
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return {
      valid: false,
      error: "模型结果不是完整 JSON。",
      raw: source.slice(0, 12000),
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return {
      valid: false,
      error: "模型结果格式不是对象。",
      raw: source.slice(0, 12000),
    };
  const strings = [
      "disclosure_status",
      "suggested_score",
      "score_basis",
      "rationale",
      "recommendation",
      "confidence",
      "current_disclosure",
      "priority",
    ],
    lists = ["evidence_refs", "gaps", "uncertainties", "information_requests"];
  if (
    strings.some((key) => typeof value[key] !== "string") ||
    lists.some(
      (key) =>
        !Array.isArray(value[key]) ||
        value[key].some((item) => typeof item !== "string"),
    ) ||
    !Array.isArray(value.grounded_findings) ||
    value.grounded_findings.some(
      (f) =>
        !f ||
        typeof f !== "object" ||
        ["evidence_id", "quote", "claim"].some(
          (key) => typeof f[key] !== "string",
        ),
    ) ||
    !VERDICTS.has(value.disclosure_status) ||
    !["high", "medium", "low"].includes(value.confidence) ||
    !["high", "medium", "low"].includes(value.priority)
  )
    return {
      valid: false,
      error: "模型结果缺少必需字段或字段类型无效。",
      raw: source.slice(0, 12000),
    };
  const allowed = new Set(allowedEvidenceIds.map(String)),
    requested = Array.isArray(value.evidence_refs)
      ? value.evidence_refs.map(String)
      : [];
  const rawScore =
    typeof value.suggested_score === "string"
      ? value.suggested_score.slice(0, 100)
      : "";
  return {
    valid: true,
    disclosureStatus: VERDICTS.has(value.disclosure_status)
      ? value.disclosure_status
      : "insufficient_evidence",
    suggestedScore: numericScaleAvailable ? rawScore : "",
    scoreSuppressed: Boolean(!numericScaleAvailable && rawScore.trim()),
    scoreBasis:
      typeof value.score_basis === "string"
        ? value.score_basis.slice(0, 1200)
        : "",
    rationale:
      typeof value.rationale === "string" ? value.rationale.slice(0, 4000) : "",
    evidenceRefs: [...new Set(requested.filter((id) => allowed.has(id)))],
    rejectedEvidenceRefs: requested
      .filter((id) => !allowed.has(id))
      .slice(0, 12),
    gaps: cleanList(value.gaps),
    recommendation:
      typeof value.recommendation === "string"
        ? value.recommendation.slice(0, 2000)
        : "",
    confidence: ["high", "medium", "low"].includes(value.confidence)
      ? value.confidence
      : "low",
    uncertainties: cleanList(value.uncertainties),
    currentDisclosure:
      typeof value.current_disclosure === "string"
        ? value.current_disclosure.slice(0, 3000)
        : "",
    informationRequests: cleanList(value.information_requests),
    priority: ["high", "medium", "low"].includes(value.priority)
      ? value.priority
      : "medium",
    groundedFindings: Array.isArray(value.grounded_findings)
      ? value.grounded_findings
          .filter(
            (f) =>
              f && typeof f === "object" && allowed.has(String(f.evidence_id)),
          )
          .slice(0, 3)
          .map((f) => ({
            evidenceId: String(f.evidence_id),
            quote: String(f.quote || "").slice(0, 1800),
            claim: String(f.claim || "").slice(0, 500),
          }))
      : [],
  };
}
function cleanList(value) {
  return Array.isArray(value)
    ? value
        .filter((x) => typeof x === "string")
        .slice(0, 12)
        .map((x) => x.slice(0, 900))
    : [];
}

export function snapshotCriterion(criterion) {
  const item = criterion.item,
    source = SOURCES[criterion.sourceId] || {};
  return {
    criterionId: criterion.id,
    issueId: criterion.issueId,
    issue: criterion.issueName,
    issue_en: criterion.issueNameEn,
    title: item.nameCn || item.name,
    title_en: item.name || item.fullName || "",
    definition: item.definitionCn || "",
    definition_en: item.definition || "",
    scoring_rule: item.scoringText || item.deduction || item.range || "",
    sourceId: criterion.sourceId,
    sourceFile: source.originalFile || source.file || "",
    sourceVersion: source.version || "版本未标明",
    sourceSha256: source.sha256 || "",
    sourcePages: criterion.pages,
    knowledgeBaseCheckedOn: META.checkedOn,
  };
}

export function selectedEvidenceEntries(chunks, manualEvidence, selectedIds) {
  const byId = new Map(
    [
      ...chunks,
      ...(manualEvidence || []).map((e) => ({ ...e, manual: true })),
    ].map((e) => [e.id, e]),
  );
  return [...selectedIds].map((id) => byId.get(id)).filter(Boolean);
}

export function currentWorkspaceRecords(sourceWorkspace) {
  const records = selectProjectRecords(
    sourceWorkspace.records,
    assessmentDocumentId(sourceWorkspace),
    sourceWorkspace.project,
  );
  if (!Array.isArray(sourceWorkspace.selectedIssueIds)) return records;
  const issues = new Set(sourceWorkspace.selectedIssueIds),
    ids = new Set(
      ALL_CRITERIA.filter((c) => issues.has(c.issueId)).map((c) => c.id),
    );
  return Object.fromEntries(
    Object.entries(records).filter(([, r]) => ids.has(r.criterionId)),
  );
}
export function buildReviewExport(sourceWorkspace, legacyId = null) {
  const selected = legacyId
    ? Object.fromEntries(
        Object.entries(sourceWorkspace.records || {}).filter(
          ([id]) => id === legacyId,
        ),
      )
    : currentWorkspaceRecords(sourceWorkspace);
  const records = Object.fromEntries(
    Object.entries(selected).filter(([, r]) => {
      const emptyDraft =
        Array.isArray(r.aiRuns) &&
        !r.aiRuns.length &&
        Array.isArray(r.manualEvidence) &&
        !r.manualEvidence.length &&
        !r.review?.confirmedAt &&
        !r.review?.notes &&
        !r.review?.score &&
        !r.taskStatus &&
        (!r.review?.decision || r.review.decision === "pending");
      return !emptyDraft;
    }),
  );
  return {
    schema: "msci-esg-workbench-review-v3",
    exportedAt: new Date().toISOString(),
    knowledgeBaseCheckedOn:
      sourceWorkspace.knowledgeBaseCheckedOn || META.checkedOn,
    documentName: legacyId
      ? "旧版文档关联待核验"
      : sourceWorkspace.documentName,
    documentId: legacyId ? "" : sourceWorkspace.documentId,
    project: legacyId ? {} : sourceWorkspace.project,
    documentMeta: legacyId ? {} : sourceWorkspace.documentMeta || {},
    selectedIssueIds: sourceWorkspace.selectedIssueIds || [],
    task: sourceWorkspace.batch
      ? { id: sourceWorkspace.batch.id, states: sourceWorkspace.batch.states }
      : null,
    records,
    note: "不含完整上传文档和 API Key；只导出当前客户、期间和文档的记录。旧版记录需单独导出并核验文档关联。",
  };
}
export function buildGapMarkdown(sourceWorkspace) {
  const data = buildReviewExport(sourceWorkspace),
    project = data.project || {};
  const md = (value) =>
    String(value ?? "").replace(/[\\`*_{}\[\]<>|#]/g, "\\$&");
  const records = Object.values(data.records).filter(
    (r) =>
      r.aiRuns?.length ||
      r.manualEvidence?.length ||
      r.review?.confirmedAt ||
      r.review?.notes ||
      r.taskStatus,
  );
  const lines = [
    "# " + md(project.client_name || "待填写客户") + " · MSCI 披露 Gap 清单",
    "",
    "- 已有报告期间：" + md(project.report_period || "待确认"),
    "- 目标披露期间：" + md(project.target_period || "待确认"),
    "- 评估边界与适用议题依据：" +
      md(project.assessment_scope || "待核对客户 MSCI Profile 和适用方法"),
    "- 报告文件：" + md(data.documentName || "手工证据"),
    "- 文档 SHA-256：" + md(data.documentId || "未记录"),
    "- 当前记录：" +
      records.length +
      " 项；人工已确认：" +
      records.filter((r) => r.review?.confirmedAt).length +
      " 项。",
    "",
    "本清单只覆盖已记录指标，候选缺口和模型状态仍需核对原文。方法年份与客户适用议题须另行确认；不能将本清单视为官方评级或全公司扫描。",
    "",
  ];
  for (const record of records) {
    const c = record.criterionSnapshot || {},
      runs = latestAiRuns(record),
      validRuns = runs.filter(
        (r) => r.draft?.valid && !r.error && !r.groundingIssues?.length,
      ),
      review = record.review || {};
    lines.push(
      "## " + md(c.issue || "议题待核对") + " · " + md(c.title || "指标待核对"),
      "",
      "**MSCI 对照要求**：" + md(c.definition || "来源快照缺失，请重新核对。"),
      "**方法来源**：" +
        md(c.sourceFile || "未记录") +
        "；" +
        md(c.sourceVersion || "版本未记录") +
        "；物理 PDF 第 " +
        (c.sourcePages || []).join("、") +
        " 页。",
      "",
      "**人工状态**：" +
        md(
          review.confirmedAt
            ? REVIEW_LABELS[review.decision] || review.decision
            : "待复核",
        ),
      "**人工确认评分／等级**：" +
        md(review.confirmedAt ? review.score || "未填写" : "未确认"),
      "**人工核对说明**：" + md(review.notes || "尚未填写"),
      "**人工披露判断**：" +
        md(
          review.disclosureStatus
            ? STATUS_LABELS[review.disclosureStatus] || review.disclosureStatus
            : "未填写",
        ),
      "**人工修订 Gap**：" + md(review.gaps || "未修订"),
      "**人工修订改进建议**：" + md(review.recommendation || "未修订"),
      "",
    );
    if (!validRuns.length) {
      lines.push("本次批次没有有效 AI 初评；历史意见未用于填补当前结论。", "");
      if (record.manualEvidence?.length) {
        lines.push("**手工证据（待与原文核对）**：");
        for (const e of record.manualEvidence)
          lines.push(
            "- " + md(e.source || "手工摘录") + " · " + md(evidenceLocation(e)),
            ...String(e.text || "")
              .split("\n")
              .map((line) => "> " + md(line)),
          );
        lines.push("");
      }
      continue;
    }
    if (new Set(validRuns.map((r) => r.draft.disclosureStatus)).size > 1)
      lines.push("本次模型结论有分歧，请核对原文；没有自动投票或定稿。", "");
    for (const run of validRuns) {
      const d = run.draft;
      lines.push(
        "### AI 初评 · " +
          md(run.providerName || "未命名服务") +
          " · " +
          md(run.model || ""),
        "",
        "**本次模型状态**：" +
          md(STATUS_LABELS[d.disclosureStatus] || d.disclosureStatus) +
          "；建议优先级：" +
          md(d.priority) +
          "。",
        "**已有披露（AI 初评）**：" + md(d.currentDisclosure || "待核对"),
        "",
        "**候选缺口（以人工核对说明为准）**：",
        ...(d.gaps?.length
          ? d.gaps.map((g) => "- " + md(g))
          : ["- 本次模型未提出具体缺口，仍需核对适用范围。"]),
        "",
        "**目标期间改进动作（AI 建议）**：" + md(d.recommendation || "待补充"),
        "",
        "**向客户收集的资料**：",
        ...(d.informationRequests?.length
          ? d.informationRequests.map((r) => "- " + md(r))
          : ["- 待补充"]),
        "",
        "**证据与定位**：",
      );
      for (const id of d.evidenceRefs || []) {
        const e = (run.evidence || []).find((item) => item.id === id);
        if (e)
          lines.push(
            "- " +
              md(id) +
              " · " +
              md(e.source) +
              " · " +
              md(evidenceLocation(e)) +
              " · " +
              md(e.heading || ""),
          );
      }
      for (const f of d.groundedFindings || [])
        lines.push(
          "",
          "原文核对：" + md(f.claim) + "（" + md(f.evidenceId) + "）",
          ...String(f.quote || "")
            .split("\n")
            .map((line) => "> " + md(line)),
        );
      if (d.uncertainties?.length)
        lines.push(
          "",
          "**待核验事项**：",
          ...d.uncertainties.map((u) => "- " + md(u)),
        );
      lines.push("");
    }
  }
  return lines.join("\n") + "\n";
}
