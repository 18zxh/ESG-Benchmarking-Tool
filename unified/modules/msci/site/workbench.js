import { KEY_ISSUES } from "./data/key-issues.js";
import { META } from "./data/core.js";
import { exportAssessmentXlsx } from "./workbench-export.js";
import {
  ALL_CRITERIA,
  CRITERION_BY_ID,
  MAX_PARSED_BYTES,
  STATUS_LABELS,
  htmlEsc,
  parseReport,
  reportIdentity,
  assessmentRecordKey,
  assessmentDocumentId,
  currentWorkspaceRecords,
  latestAiRuns,
  evidenceLocation,
  figureChunk,
  retrieveEvidence,
} from "./workbench-core.js";
import {
  criteriaForIssues,
  taskContext,
  createBatch,
  batchCounts,
  ensureRecord,
  AssessmentQueue,
} from "./workbench-batch.js";
import { PdfAssessmentQueue, usesNativePdf } from "./workbench-native.js";
import { semanticIndex, semanticScores, semanticQueryIfReady } from "./semantic-retrieval.js";
export * from "./workbench-core.js";

const WB_DB_NAME = "msci-esg-assessment-workbench",
  WB_DB_STORE = "workspace";
const WB_PROJECT_FIELDS = {
  wbClientName: "client_name",
  wbReportPeriod: "report_period",
  wbTargetPeriod: "target_period",
  wbAssessmentScope: "assessment_scope",
};
const WB_STAGES = ["setup", "evaluation", "review"];
const WB_TASK_LABELS = {
  pending: "等待处理",
  running: "处理中",
  completed: "初评完成",
  failed: "初评失败",
  needs_evidence: "待全文核验",
};
function newWorkspace() {
  return {
    schema: 5,
    knowledgeBaseCheckedOn: META.checkedOn,
    documentName: "",
    documentText: "",
    documentId: "",
    documentEncoding: "",
    documentWarnings: [],
    documentMeta: {},
    originalPdf: null,
    figures: [],
    // 可选的公司年报：治理等披露常出自年报，与主报告一起进入全文检索和证据。
    figureTextChunks: [],
    annual: { originalPdf:null, name: "", text: "", id: "", encoding: "", warnings: [], meta: {}, figures: [], figureTextChunks: [] },
    project: {
      client_name: "",
      report_period: "",
      target_period: "",
      assessment_scope: "",
    },
    methodAcknowledged: false,
    selectedIssueIds: KEY_ISSUES.filter((i) => i.pillar === "governance").map(
      (i) => i.id,
    ),
    activeCriterionId: "",
    records: {},
    batch: null,
  };
}
let wbWorkspace = newWorkspace(),
  wbRoot = null,
  wbProviders = [],
  wbApiConnected = false,
  wbGlmOnly = true,
  wbQueue = null,
  wbStage = "setup",
  wbFileGeneration = 0,
  wbUploading = false,
  wbAnnualUploading = false,
  wbChunksCache = null,
  wbFigureChunks = [],
  wbAnnualFigureChunks = [],
  wbFigureNote = "",
  wbOriginalUrl = "",
  wbOriginalBuffer = null,
  wbPreviewRequest = 0,
  wbReviewFilter = "all",
  wbUploadProgress = {phase:"准备逐页识别",completed:0,total:0},
  wbAnnualUploadProgress = {phase:"准备逐页识别",completed:0,total:0},
  wbSemanticState = { phase: "idle", message: "" },
  wbSemanticGeneration = 0;
const wbQ = (selector) => wbRoot?.querySelector(selector);
const wbBusy = () => wbUploading || wbAnnualUploading || Boolean(wbQueue?.running);
function wbStatus(message, error = false) {
  const n = wbQ("#wbStatus");
  if (n) {
    n.textContent = message;
    n.classList.toggle("is-error", error);
  }
}
function wbChunks() {
  // 主报告与年报片段合并在同一个数组里进入检索；数组引用保持稳定，
  // 只有任一文档或图表转述变化才重建，供语义索引按数组身份复用。
  const cacheKey = wbWorkspace.documentId + "|" + wbWorkspace.annual.id;
  if (wbChunksCache?.key !== cacheKey)
    wbChunksCache = {
      key: cacheKey,
      chunks: [
        ...parseReport(
          wbWorkspace.documentText,
          wbWorkspace.documentName,
          wbWorkspace.documentMeta,
        ),
        ...wbFigureChunks,
        ...(wbWorkspace.fullReview?.evidence || []),
        ...(wbWorkspace.annual.text
          ? parseReport(
              wbWorkspace.annual.text,
              wbWorkspace.annual.name,
              wbWorkspace.annual.meta,
              "annual",
            )
          : []),
        ...wbAnnualFigureChunks,
      ],
    };
  return wbChunksCache.chunks;
}
function wbCurrentRecord() {
  const c = CRITERION_BY_ID.get(wbWorkspace.activeCriterionId);
  return c ? ensureRecord(wbWorkspace, c) : null;
}
function wbCurrentBatch() {
  return wbWorkspace.batch?.context === taskContext(wbWorkspace)
    ? wbWorkspace.batch
    : null;
}
function wbInvalidateTask() {
  if(wbQueue?.native)wbQueue.stop();
  wbWorkspace.nativeJobId="";
  wbWorkspace.fullReview=null;
  wbWorkspace.batch = null;
  wbQueue = null;
  wbWorkspace.activeCriterionId = "";
}
function wbSemanticText() {
  if (!wbWorkspace.documentName && !wbWorkspace.annual.name)
    return "报告就绪后开始全文审阅。";
  if(!wbQ("#wbEnableSemantic")?.checked)return (wbWorkspace.fullReview?.readingComplete?"报告全文已读取。":"报告已载入；开始初评时分批阅读全文。")+(wbFigureNote?" · "+wbFigureNote:"");
  return (
    "语义检索（EmbeddingGemma 2）：" +
    wbSemanticState.message +
    (wbFigureNote ? " · " + wbFigureNote : "")
  );
}
// 逐张把报告图表交给已连接模型转述为文字；单张失败只跳过，整体失败静默降级为关键词/语义检索。
// source 为 "annual" 时转述片段归入年报（标题与编号带年报标记）。
async function wbDescribeFigures(figures, source = "main") {
  const list = Array.isArray(figures) ? figures : [];
  const checkbox = wbQ("#wbFigureText");
  if (!list.length || (checkbox && !checkbox.checked) || wbProviders.filter(p=>p.selected).some(usesNativePdf)) return;
  const provider = wbProviders.find((p) => p.selected) || wbProviders[0];
  if (!provider) return;
  const annual = source === "annual",
    noteLabel = annual ? "图表转述（年报）" : "图表转述";
  let done = 0, failed = 0;
  try {
    for (const [index, figure] of list.entries()) {
      const existing = annual ? wbAnnualFigureChunks : wbFigureChunks;
      if (existing.some(chunk => chunk.id === (annual ? "annual-" : "") + figure.id)) {
        done++;
        continue;
      }
      try {
        const data = await wbReadResponse(
          await fetch("/api/figure-text", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ providerId: provider.id, image: figure.dataUrl, page: figure.page }),
            signal: AbortSignal.timeout(120000),
          }),
        );
        if (String(data.text || "").trim()) {
          (annual ? wbAnnualFigureChunks : wbFigureChunks).push(figureChunk(figure, data.text, source));
          if (annual) wbWorkspace.annual.figureTextChunks = wbAnnualFigureChunks;
          else wbWorkspace.figureTextChunks = wbFigureChunks;
          wbChunksCache = null; // 重建缓存，使图表转述片段进入全文检索。
          done++;
        } else failed++;
      } catch {
        failed++;
      }
      wbFigureNote = noteLabel + (index + 1) + " / " + list.length + (failed ? "（已跳过 " + failed + " 张）" : "") + " …";
      wbRenderDocument();
    }
    wbFigureNote = done
      ? noteLabel + done + " / " + list.length + " 张完成" + (failed ? "，跳过 " + failed + " 张" : "") + "，均标记为待人工复核。"
      : "图表转述未生成可用文本，已按关键词与语义检索继续。";
  } catch {
    if (annual) wbAnnualFigureChunks = [];
    else wbFigureChunks = [];
    wbChunksCache = null;
    wbFigureNote = "";
  }
  wbRenderDocument();
}
// 后台建立语义索引；失败只降级为关键词检索，不影响解析与初评流程。
function wbStartSemanticIndex() {
  if(!wbQ("#wbEnableSemantic")?.checked){wbResetSemantic();wbRenderDocument();return;}
  const generation = ++wbSemanticGeneration;
  const chunks = wbChunks();
  if (!chunks.length) {
    wbSemanticState = { phase: "idle", message: "" };
    return;
  }
  wbSemanticState = {
    phase: "loading",
    message: "正在加载模型（首次需下载模型文件，报告内容不外传）…",
  };
  wbRenderDocument();
  semanticIndex(chunks, {
    onProgress: (p) => {
      if (generation !== wbSemanticGeneration) return;
      wbSemanticState = {
        phase: "indexing",
        message: "正在建立语义索引 " + p.completed + " / " + p.total + " 片段…",
      };
      wbRenderDocument();
    },
  })
    .then(() => {
      if (generation !== wbSemanticGeneration) return;
      wbSemanticState = {
        phase: "ready",
        message: "已就绪，检索使用关键词 + 语义混合。",
      };
      wbRenderDocument();
    })
    .catch((error) => {
      if (generation !== wbSemanticGeneration) return;
      wbSemanticState = {
        phase: "unavailable",
        message:
          "不可用（" +
          (error?.message || "模型加载失败") +
          "），本次使用关键词检索。",
      };
      wbRenderDocument();
    });
}
function wbResetSemantic() {
  ++wbSemanticGeneration;
  wbSemanticState = { phase: "idle", message: "" };
}
async function wbSemanticQuery(chunks, query) {
  const generation = wbSemanticGeneration;
  try {
    return await semanticQueryIfReady(wbSemanticState.phase, () => semanticScores(chunks, query));
  } catch (error) {
    if (generation !== wbSemanticGeneration) return null;
    wbSemanticState = {
      phase: "unavailable",
      message:
        "不可用（" + (error?.message || "模型加载失败") + "），本次使用关键词检索。",
    };
    wbRenderDocument();
    return null;
  }
}

export function workbenchView() {
  const groups = [
    ["environmental", "环境"],
    ["social", "社会"],
    ["governance", "治理"],
  ]
    .map(([pillar, label]) => {
      const issues = KEY_ISSUES.filter((i) => i.pillar === pillar);
      return `<details class="wb-issue-group" ${pillar === "governance" ? "open" : ""}><summary>${label}<span>${issues.length} 个议题</span></summary><div class="wb-issue-options">${issues.map((i) => `<label class="wb-issue-option"><input type="checkbox" data-wb-issue="${htmlEsc(i.id)}" ${pillar === "governance" ? "checked" : ""}><span>${htmlEsc(i.name)}<small>${i.indicators.length + i.keyMetrics.length} 项指标</small></span></label>`).join("")}</div></details>`;
    })
    .join("");
  return `<div class="workbench">
    <header class="wb-heading"><div><h1>智能评估工作台</h1><p>从上一期报告找到披露不足，准备下一期披露改进。</p></div><details class="wb-tools"><summary>项目与模型设置</summary><div class="wb-tools-content">
      <h2>项目</h2><div class="wb-export-actions"><button type="button" class="btn" id="wbSave">保存到本机</button><button type="button" class="btn" id="wbRestore">恢复草稿</button><button type="button" class="btn" id="wbClearSaved">清除保存副本</button></div>
      <p class="note">草稿包含报告原文和原始 PDF，只在你点击保存后写入本机。清除保存副本不会删除当前页面记录。</p>
      <details class="wb-history"><summary>历史记录</summary><p id="wbHistory" class="note"></p></details>
      <h2>模型连接</h2><div id="wbProviders" class="wb-provider-list"></div><button type="button" class="text-button" id="wbRefreshProviders">刷新连接状态</button>
      <details><summary>添加或更新连接</summary><form id="wbProviderForm" class="wb-form-grid">
        <label for="wbProviderName">名称</label><input id="wbProviderName" value="GLM Flash" maxlength="48" required>
        <label for="wbBaseUrl">接口地址</label><input id="wbBaseUrl" value="https://open.bigmodel.cn/api/paas/v4" required>
        <label for="wbModelName">模型</label><select id="wbModelName"><option value="glm-5.3-flash">GLM 5.3 Flash（默认）</option><option value="glm-5.3-flashx">GLM 5.3 FlashX（可选）</option></select>
        <label for="wbApiKey">连接密钥</label><input id="wbApiKey" type="password" autocomplete="off"><button type="submit" class="btn">连接模型</button>
      </form><p class="note">每次选择一个 GLM 连接。密钥只保存在本机服务内存，停止服务后清除；不随草稿保存。</p></details>
      <details id="wbLegacyRetrieval" hidden><summary>检索设置</summary><label class="wb-method-check"><input type="checkbox" id="wbEnableSemantic"><span>启用本机语义搜索（可选）</span></label></details><details><summary>方法、隐私与版本</summary><p class="note">客户评级资料、行业及方法适用年度须核实；治理默认全选是检查清单。GLM 将分批读取原 PDF 的正文、表格与图表，保留出处和物理页码，再按完整指标要求初评。过长内容拆批处理，相同输入可复用缓存。报告会发送给所连接的模型服务商。自动初评不等于官方评级；人工复核保留评论。</p></details>
    </div></details></header>
    <div id="wbStatus" class="wb-status" role="status">上传主报告并选择需要对标的议题。</div><div id="wbContext" class="wb-context"></div>
    <nav class="wb-steps" role="tablist" aria-label="评估流程">${WB_STAGES.map((s, i) => `<button type="button" id="wbTab-${s}" role="tab" aria-controls="wbPanel-${s}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-wb-stage="${s}">${i + 1}. ${["上传与选择", "自动初评", "人工复核"][i]}</button>`).join("")}</nav>
    <section id="wbPanel-setup" class="wb-panel" role="tabpanel" aria-labelledby="wbTab-setup" tabindex="0">
      <div class="wb-setup-grid"><div><section class="wb-section"><h2>上传主报告</h2><label class="wb-upload" for="wbReportFile"><span>选择 PDF 报告</span><small>一份报告一个任务 · 最大 30 MB · 逐页识别正文、图像文字与表格</small><input class="wb-file-input" id="wbReportFile" type="file" accept=".pdf,application/pdf"></label><p id="wbDocumentStatus" class="note" role="status">尚未上传报告。</p><progress id="wbUploadProgress" value="0" max="1" aria-label="报告逐页解析进度" hidden></progress><p id="wbSemanticStatus" class="note" role="status"></p><label class="wb-method-check"><input id="wbFigureText" type="checkbox"><span>图表转文字（需支持图片的模型）</span></label><div class="wb-export-actions"><button type="button" class="text-button" id="wbClearDocument">移除当前报告</button></div><details id="wbConversionDetails" hidden><summary>识别结果与原文件</summary><div id="wbConversionInfo"></div></details></section>
      <section class="wb-section"><h2>上传公司年报（可选）</h2><p class="note">治理等信息常出自年报；解析后与主报告一起进入全文检索和证据。</p><label class="wb-upload" for="wbAnnualFile"><span>选择 PDF 年报</span><small>最大 30 MB · 逐页识别后标注「年报」来源</small><input class="wb-file-input" id="wbAnnualFile" type="file" accept=".pdf"></label><p id="wbAnnualStatus" class="note" role="status">尚未上传年报。</p><progress id="wbAnnualProgress" value="0" max="1" aria-label="年报逐页解析进度" hidden></progress><div class="wb-export-actions"><button type="button" class="text-button" id="wbRemoveAnnual" hidden>移除年报</button></div></section>
      <section class="wb-section"><h2>核对项目</h2><label for="wbClientName">客户名称</label><input id="wbClientName" maxlength="120" placeholder="公司名称 · A 股代码（选填）"><div class="wb-periods"><div><label for="wbReportPeriod">报告覆盖年度</label><input id="wbReportPeriod" maxlength="80" placeholder="2024"></div><div><label for="wbTargetPeriod">目标披露年度</label><input id="wbTargetPeriod" maxlength="80" placeholder="2025"></div></div><p class="note">填写报告覆盖年度，不以发布日期代替；目标年度用于改进建议。</p><details class="wb-secondary"><summary>客户评级资料、方法适用性与范围</summary><label for="wbAssessmentScope">适用议题依据与统计边界</label><textarea id="wbAssessmentScope" rows="3" maxlength="1000" placeholder="记录客户评级资料、行业、集团或子公司范围，以及方法是否适用于目标年度。未知项请写待确认。"></textarea></details><label class="wb-method-check"><input id="wbMethodAcknowledged" type="checkbox"><span>已知晓：客户评级资料与方法适用年度需核实，当前清单用于披露初评。</span></label></section></div>
      <section class="wb-section"><h2>选择对标议题</h2><p class="note">治理默认全选；根据客户需要补选环境、社会议题。</p><div class="wb-selection-actions"><button type="button" class="text-button" id="wbGovernanceDefault">恢复治理全选</button><button type="button" class="text-button" id="wbDeselectAll">全部取消</button></div>${groups}<p id="wbSelectionCount" class="wb-count"></p></section></div>
      <div class="wb-stage-actions"><div><p id="wbSendSummary" class="note"></p><button type="button" class="text-button" id="wbOpenSettings">设置模型连接</button></div><button type="button" class="btn btn-primary" id="wbStart">开始自动初评</button></div>
    </section>
    <section id="wbPanel-evaluation" class="wb-panel" role="tabpanel" aria-labelledby="wbTab-evaluation" tabindex="0" hidden>
      <section class="wb-section"><div class="wb-section-head"><div><h2>自动初评</h2><p>分批阅读全文，按完整指标要求生成披露判断与改进建议。未找到对应内容时标为“未披露”。</p></div><div class="wb-export-actions"><button type="button" class="btn" id="wbPause">暂停</button><button type="button" class="btn" id="wbResume">继续</button><button type="button" class="btn" id="wbStop">停止未发送任务</button><button type="button" class="btn" id="wbRetryFailed">重试失败项</button></div></div><progress id="wbProgress" value="0" max="1" aria-label="指标处理进度"></progress><p id="wbReadingStatus" class="note" role="status"></p><p id="wbProgressText" class="wb-run-status" role="status"></p><p class="note">暂停或停止会等待已发送的请求结束；已完成结果保留。</p></section>
      <div class="wb-table-wrap" tabindex="0" role="region" aria-label="初评结果"><table class="wb-results-table"><caption class="sr-only">所选指标的处理状态和待核验的披露不足</caption><thead><tr><th scope="col">议题与指标</th><th scope="col">建议判断</th><th scope="col">已有披露 / 披露不足</th><th scope="col">改进建议</th><th scope="col">操作</th></tr></thead><tbody id="wbResultsBody"></tbody></table></div>
      <div class="wb-stage-actions"><button type="button" class="btn" data-wb-stage="setup">返回上传与选择</button><button type="button" class="btn btn-primary" id="wbToReview">进入人工复核</button></div>
    </section>
    <section id="wbPanel-review" class="wb-panel" role="tabpanel" aria-labelledby="wbTab-review" tabindex="0" hidden>
      <div class="wb-review-header"><h2>对照原文，记录评论</h2><p id="wbReviewSummary" class="note"></p></div><div class="wb-review-layout"><aside class="wb-review-list"><label for="wbReviewFilter">显示项目</label><select id="wbReviewFilter"><option value="all">全部指标</option><option value="pending">未记录评论</option><option value="commented">已记录评论</option><option value="failed">处理失败</option></select><label for="wbReviewIssue">按议题筛选</label><select id="wbReviewIssue"><option value="">全部已选议题</option></select><div id="wbReviewList"></div></aside>
      <div id="wbReviewDetail" class="wb-review-detail"><p class="empty">完成初评后，选择一个指标对照原文复核。</p></div></div>
      <div class="wb-stage-actions"><button type="button" class="btn" data-wb-stage="evaluation">返回初评结果</button><div class="wb-export-actions"><button type="button" class="btn" id="wbSaveReview">保存到本机</button><button type="button" class="btn btn-primary" id="wbExportXlsx">导出评估表（Excel）</button></div></div>
    </section>
  </div>`;
}
function wbSetStage(stage, focus = false) {
  if (!WB_STAGES.includes(stage)) return;
  wbStage = stage;
  for (const s of WB_STAGES) {
    const tab = wbQ("#wbTab-" + s),
      panel = wbQ("#wbPanel-" + s);
    if (tab) {
      tab.setAttribute("aria-selected", String(s === stage));
      tab.tabIndex = s === stage ? 0 : -1;
    }
    if (panel) panel.hidden = s !== stage;
  }
  if (focus) wbQ("#wbTab-" + stage)?.focus();
}
function wbRenderContext() {
  const p = wbWorkspace.project;
  wbQ("#wbContext").textContent = [
    p.client_name || "客户待填写",
    (p.report_period || "报告期待确认") +
      " → " +
      (p.target_period || "目标期待确认"),
    wbWorkspace.documentName || "尚未上传报告",
  ].join(" · ");
}
function wbRenderProviders() {
  const n = wbQ("#wbProviders");
  if (!n) return;
  n.innerHTML = wbProviders.length
    ? wbProviders
        .map(
          (p) =>
            `<label class="wb-provider"><input type="${wbGlmOnly ? 'radio' : 'checkbox'}" name="wbProvider" data-wb-provider="${htmlEsc(p.id)}" ${p.selected ? "checked" : ""} ${wbBusy() ? "disabled" : ""}><span><strong>${htmlEsc(p.name)}</strong><small>${htmlEsc(p.model)}</small></span></label>`,
        )
        .join("")
    : '<p class="note">尚未连接模型。请在下方添加连接。</p>';
  wbRenderControls();
}
function wbRenderDocument() {
  const status = wbQ("#wbDocumentStatus");
  if (!status) return;
  const chunks = wbChunks(), meta = wbWorkspace.documentMeta;
  const annual = wbWorkspace.annual,
    annualMeta = annual.meta || {},
    annualChunks = chunks.filter((chunk) => chunk.source === "annual").length;
  status.textContent = wbUploading
    ? wbUploadProgress.phase + (wbUploadProgress.total ? " · "+wbUploadProgress.completed+" / "+wbUploadProgress.total+" 页" : "，请稍候。")
    : wbWorkspace.documentName
      ? wbWorkspace.documentName + " · " + (meta.processedPages || 0) + "/" + (meta.pageCount || 0) + " 页已识别 · " + (meta.tableCount || 0) + " 个表格 · "+(chunks.length - annualChunks)+" 个检索片段"
      : "尚未上传报告。";
  const progress = wbQ("#wbUploadProgress");
  progress.hidden = !wbUploading;
  progress.max = wbUploadProgress.total || 1;
  progress.value = Number(wbUploadProgress.completed) || 0;
  wbQ("#wbAnnualStatus").textContent = wbAnnualUploading
    ? wbAnnualUploadProgress.phase + (wbAnnualUploadProgress.total ? " · "+wbAnnualUploadProgress.completed+" / "+wbAnnualUploadProgress.total+" 页" : "，请稍候。")
    : annual.name
      ? annual.name + " · " + (annualMeta.processedPages || 0) + "/" + (annualMeta.pageCount || 0) + " 页已识别 · "+annualChunks+" 个检索片段"
      : "尚未上传年报。";
  const annualProgress = wbQ("#wbAnnualProgress");
  annualProgress.hidden = !wbAnnualUploading;
  annualProgress.max = wbAnnualUploadProgress.total || 1;
  annualProgress.value = Number(wbAnnualUploadProgress.completed) || 0;
  wbQ("#wbRemoveAnnual").hidden = !annual.name && !wbAnnualUploading;
  const nativeRead=wbWorkspace.fullReview?.readingComplete;
  if(!wbUploading && meta.converterVersion==="glm-native-pdf-v1")status.textContent=wbWorkspace.documentName+" · "+meta.pageCount+(nativeRead?" 页全文已读取":" 页已载入 · 开始初评时阅读全文");
  if(!wbAnnualUploading && annualMeta.converterVersion==="glm-native-pdf-v1")wbQ("#wbAnnualStatus").textContent=annual.name+" · "+annualMeta.pageCount+(nativeRead?" 页全文已读取":" 页已载入 · 初评时与主报告一起阅读全文");
  wbQ("#wbSemanticStatus").textContent = wbSemanticText();
  wbQ("#wbConversionDetails").hidden = !wbWorkspace.documentName;
  wbQ("#wbConversionInfo").innerHTML = meta.converterVersion==="glm-native-pdf-v1" ? (nativeRead?"<p>原始PDF全部页面已分批读取，原文与页码已保留。</p>":"<p>原始PDF已载入，正文、表格与图表将由GLM分批读取。</p>") : meta.originalSha256
    ? "<p>文字层、图像文字与表格位置均已逐页读取。"+(meta.imageSupplementPages || 0)+" 页补充图像文字，"+(meta.readablePages || 0)+" 页有可读内容。</p>"+
      (wbWorkspace.documentWarnings.length ? "<ul class='note'>"+wbWorkspace.documentWarnings.map((w)=>"<li>"+htmlEsc(w)+"</li>").join("")+"</ul>" : "<p class='note'>页码检查完成，未检测到漏页或低置信度文字。</p>")+
      "<p class='note'>原文件指纹："+htmlEsc(meta.originalSha256)+"</p><p class='note'>解析器："+htmlEsc(meta.converterVersion)+"</p>"
    : "";
  const groups = new Map();
  for (const record of Object.values(wbWorkspace.records)) {
    const label = [record.project?.client_name || "未命名项目", record.documentName || "手工记录"].join(" · ");
    groups.set(label,(groups.get(label) || 0)+1);
  }
  wbQ("#wbHistory").textContent = groups.size ? [...groups].map(([label,count])=>label+"："+count+" 项记录").join("；") : "尚无历史记录。保存草稿时保留各项目的评估及评论。";
}

function wbRenderControls() {
  if (!wbQ("#wbStart")) return;
  const busy = wbBusy(),
    chosen = criteriaForIssues(wbWorkspace.selectedIssueIds),
    selected = wbProviders.filter((p) => p.selected);
  wbQ("#wbSelectionCount").textContent =
    `已选 ${wbWorkspace.selectedIssueIds.length} 个议题 · ${chosen.length} 项指标`;
  wbQ("#wbFigureText").closest("label").hidden=wbGlmOnly || (selected.length===1 && usesNativePdf(selected[0]));
  wbQ("#wbLegacyRetrieval").hidden=wbGlmOnly;
  wbQ("#wbSemanticStatus").hidden=wbGlmOnly;
  wbQ("#wbSendSummary").textContent = selected.length===1 && usesNativePdf(selected[0]) ? `全文模型：${selected[0].name} / ${selected[0].model}；报告读取一次，按议题合并评估。` : selected.length
    ? `初评模型：${selected.map((p) => p.name + " / " + p.model).join("、")}；每项最多发送 24 条证据。`
    : "在项目与模型设置中连接 GLM 后开始自动初评。";
  wbQ("#wbStart").textContent = wbCurrentBatch()
    ? "重新评估全部"
    : "开始自动初评";
  wbQ("#wbStart").disabled =
    busy ||
    (!wbWorkspace.documentText || !wbWorkspace.originalPdf) ||
    !chosen.length ||
    !selected.length ||
    !wbApiConnected;
  for (const n of wbRoot.querySelectorAll(
    "#wbPanel-setup input,#wbPanel-setup textarea,#wbPanel-setup button:not(#wbOpenSettings)",
  )) {
    if (n.id !== "wbStart") n.disabled = busy;
  }
  for (const n of wbRoot.querySelectorAll(
    "[data-wb-provider],#wbProviderForm input,#wbProviderForm select,#wbProviderForm button",
  ))
    n.disabled = busy;
  for (const id of ["wbRestore", "wbClearSaved", "wbRefreshProviders"]) wbQ("#" + id).disabled = busy;
  wbQ("#wbPause").disabled = !wbQueue?.running || wbQueue.paused;
  wbQ("#wbStop").disabled = !wbQueue?.running || wbQueue.stopped;
  const batch = wbCurrentBatch(),
    counts = batchCounts(batch);
  wbQ("#wbResume").disabled = busy || !batch || !counts.pending;
  wbQ("#wbRetryFailed").disabled = busy || !batch || !counts.failed;
  wbQ("#wbToReview").disabled = !wbWorkspace.originalPdf || !chosen.length;
  wbQ("#wbExportXlsx").disabled = busy || !wbWorkspace.originalPdf || !chosen.length;
}
function wbDraft(record) {
  return latestAiRuns(record).find(
    (r) => r.draft?.valid && !r.error && !r.groundingIssues?.length,
  )?.draft;
}
function wbRenderResults() {
  const reading=wbWorkspace.fullReview;
  if(wbQ("#wbReadingStatus"))wbQ("#wbReadingStatus").textContent=reading ? `全文读取 ${reading.processedPages} / ${reading.totalPages} 页${reading.readingComplete?" · 已完成":""}` : "";
  const batch = wbCurrentBatch(),
    counts = batchCounts(batch),
    body = wbQ("#wbResultsBody"),
    taskEnded =
      counts.total > 0 &&
      counts.completed + counts.failed + counts.needs_evidence === counts.total,
    phaseText =
      taskEnded || batch?.phase === "finished"
        ? " · 本轮处理结束"
        : batch?.phase === "paused"
          ? " · 已暂停"
          : batch?.phase === "stopped"
            ? " · 已停止"
            : "";
  wbQ("#wbProgress").max = counts.total || 1;
  wbQ("#wbProgress").value =
    counts.completed + counts.failed + counts.needs_evidence;
  wbQ("#wbProgressText").textContent = batch
    ? `${counts.completed} 项完成 · ${counts.running} 项处理中 · ${counts.failed} 项失败 · ${counts.pending} 项等待 / 共 ${counts.total} 项${phaseText}`
    : "先上传报告并开始评估。";
  body.innerHTML = batch
    ? criteriaForIssues(wbWorkspace.selectedIssueIds)
        .map((c) => {
          const r =
              wbWorkspace.records[
                assessmentRecordKey(
                  c.id,
                  assessmentDocumentId(wbWorkspace),
                  wbWorkspace.project,
                )
              ],
            s = batch.states[c.id],
            d = wbDraft(r),
            runs = latestAiRuns(r),
            different =
              new Set(
                runs
                  .filter((x) => x.draft?.valid)
                  .map((x) => x.draft.disclosureStatus),
              ).size > 1;
          return `<tr><th scope="row"><small>${htmlEsc(c.issueName)}</small>${htmlEsc(c.item.nameCn || c.item.name)}</th><td data-label="建议判断"><span>${htmlEsc(WB_TASK_LABELS[s.status])}</span>${d ? "<p>" + htmlEsc(STATUS_LABELS[d.disclosureStatus]) + "</p>" : ""}${different ? '<p class="wb-disagreement">模型意见有分歧</p>' : ""}</td><td data-label="已有披露 / 披露不足">${d ? `<p>${htmlEsc(d.currentDisclosure)}</p><ul>${d.gaps.map((g) => "<li>" + htmlEsc(g) + "</li>").join("")}</ul>` : htmlEsc(s.error || "等待自动检索与初评。")}</td><td data-label="改进建议">${htmlEsc(d?.recommendation || "—")}</td><td data-label="操作"><button type="button" class="text-button" data-wb-review="${htmlEsc(c.id)}">查看与复核</button>${["failed", "needs_evidence"].includes(s.status) ? `<button type="button" class="text-button" data-wb-retry="${htmlEsc(c.id)}" ${wbBusy() ? "disabled" : ""}>重试本项</button>` : ""}</td></tr>`;
        })
        .join("")
    : '<tr><td colspan="5">暂无评估任务。</td></tr>';
}
function wbRenderReviewList() {
  const criteria = criteriaForIssues(wbWorkspace.selectedIssueIds),
    current = currentWorkspaceRecords(wbWorkspace),
    confirmed = Object.values(current).filter(
      (r) => String(r.review?.notes || "").trim(),
    ).length;
  wbQ("#wbReviewSummary").textContent =
    `已记录评论 ${confirmed} / ${criteria.length} 项。导出包含全部已选指标、智能初评、原文依据和评论。`;
  const issueSelect = wbQ("#wbReviewIssue"),
    old = issueSelect.value;
  issueSelect.innerHTML =
    '<option value="">全部已选议题</option>' +
    KEY_ISSUES.filter((i) => wbWorkspace.selectedIssueIds.includes(i.id))
      .map(
        (i) => `<option value="${htmlEsc(i.id)}">${htmlEsc(i.name)}</option>`,
      )
      .join("");
  issueSelect.value = old;
  const items = criteria.filter((c) => {
    const r =
        current[
          assessmentRecordKey(c.id, assessmentDocumentId(wbWorkspace), wbWorkspace.project)
        ],
      status = wbCurrentBatch()?.states[c.id]?.status;
    if (issueSelect.value && c.issueId !== issueSelect.value) return false;
    if (wbReviewFilter === "commented") return Boolean(String(r?.review?.notes || "").trim());
    if (wbReviewFilter === "failed")
      return ["failed", "needs_evidence"].includes(status);
    return wbReviewFilter === "all" || !String(r?.review?.notes || "").trim();
  });
  wbQ("#wbReviewList").innerHTML = items.length
    ? items
        .map((c) => {
          const r =
            current[
              assessmentRecordKey(
                c.id,
                assessmentDocumentId(wbWorkspace),
                wbWorkspace.project,
              )
            ];
          return `<button type="button" class="wb-review-item ${wbWorkspace.activeCriterionId === c.id ? "is-active" : ""}" data-wb-review="${htmlEsc(c.id)}" aria-current="${wbWorkspace.activeCriterionId === c.id ? "true" : "false"}"><small>${htmlEsc(c.issueName)} · ${String(r?.review?.notes || "").trim() ? "已记录评论" : "未记录评论"}</small><span>${htmlEsc(c.item.nameCn || c.item.name)}</span></button>`;
        })
        .join("")
    : '<p class="empty">此筛选下没有指标。</p>';
}
function wbEvidenceHtml(e, expanded = false) {
  const annual = e.source === "annual";
  const location = (annual ? "年报 · "+(e.filename || wbWorkspace.annual.name) : e.filename || wbWorkspace.documentName) + " · " + evidenceLocation(e);
  const source=annual?'annual':'main',file=wbPdfFile(source);
  const pdfLink=e.pdfPage && file.buffer
    ? `<button type="button" class="text-button" data-wb-pdf-page="${e.pdfPage}" data-wb-pdf-source="${source}">查看${annual?'年报':'原'} PDF 第 ${e.pdfPage} 页</button>`
    : annual ? '<p class="note">年报原文请对照上传文件</p>' : '';
  return `<article class="wb-evidence"><details ${expanded ? "open" : ""}><summary>${htmlEsc(location)}${e.warning ? "（有识别提示）" : ""}</summary>${e.warning ? '<p class="source-warning">' + htmlEsc(e.warning) + "</p>" : ""}<blockquote tabindex="0" role="region" aria-label="${htmlEsc("原文摘录：" + location)}">${htmlEsc(e.text)}</blockquote>${pdfLink}</details></article>`;
}
function wbRenderReviewDetail() {
  const node = wbQ("#wbReviewDetail"), c = CRITERION_BY_ID.get(wbWorkspace.activeCriterionId);
  if (!c || !wbWorkspace.selectedIssueIds.includes(c.issueId)) {
    node.innerHTML = '<p class="empty">选择一个指标，查看初评和原文并记录评论。</p>';
    return;
  }
  const r = wbCurrentRecord(), review = r.review || {}, runs = latestAiRuns(r);
  const evidence = [...new Map([...runs.flatMap((x)=>x.evidence || []), ...(r.manualEvidence || [])].map((e)=>[e.id,e])).values()];
  node.innerHTML = '<section class="wb-section"><h3>'+htmlEsc(c.item.nameCn || c.item.name)+'</h3><p class="note">'+htmlEsc(c.issueName)+' · <a href="#/source/'+htmlEsc(c.sourceId)+'?page='+Number(c.pages[0] || 1)+'">查看指标来源，第 '+c.pages.map(Number).join("、")+' 页</a></p><p>'+htmlEsc(c.item.definitionCn || "请查看指标原文。")+'</p><details><summary>指标原文与来源</summary><p lang="en">'+htmlEsc(c.item.name || "")+' · '+htmlEsc(c.item.definition || "")+'</p><p>'+htmlEsc(c.item.scoringText || c.item.deduction || c.item.range || "没有独立数值标尺。")+'</p><p class="note">'+htmlEsc(r.criterionSnapshot.sourceFile)+' · '+htmlEsc(r.criterionSnapshot.sourceVersion)+'</p></details></section>'+
    '<section class="wb-section wb-comment"><h3>复核评论</h3><label class="sr-only" for="wbReviewNotes">评论</label><textarea id="wbReviewNotes" rows="4" maxlength="6000" placeholder="记录核对意见、修订判断或需要补充的资料，可注明报告页码。" '+(wbBusy() ? "disabled" : "")+'></textarea><div class="wb-comment-actions"><p class="note" id="wbReviewBadge">'+(review.commentedAt ? "评论已保存到本机。" : "尚未保存评论。")+'</p><button type="button" class="btn btn-primary" id="wbSaveComment" '+(wbBusy() ? "disabled" : "")+'>保存评论</button></div></section>'+
    '<section class="wb-section"><h3>智能初评</h3>'+
    (runs.length ? runs.map((run)=>'<article class="wb-model-result"><h4>'+htmlEsc(run.providerName)+' · '+htmlEsc(run.model)+'</h4>'+
      (run.draft?.valid ? '<p class="wb-verdict">'+htmlEsc(STATUS_LABELS[run.draft.disclosureStatus])+(run.draft.suggestedScore ? " · 建议分数 "+htmlEsc(run.draft.suggestedScore) : "")+'</p><p>'+htmlEsc(run.draft.currentDisclosure)+'</p><h4>披露不足</h4>'+(run.draft.gaps.length ? '<ul>'+run.draft.gaps.map((g)=>'<li>'+htmlEsc(g)+'</li>').join("")+'</ul>' : '<p class="note">本次依据中未识别到具体不足。</p>')+'<p><strong>改进建议：</strong>'+htmlEsc(run.draft.recommendation)+'</p><details><summary>判断依据</summary><p>'+htmlEsc(run.draft.rationale)+'</p><p>'+htmlEsc(run.draft.scoreBasis)+'</p><ul>'+[...run.draft.uncertainties,...run.draft.informationRequests].map((x)=>'<li>'+htmlEsc(x)+'</li>').join("")+'</ul>'+run.draft.groundedFindings.map((f)=>'<p>'+htmlEsc(f.claim)+'</p><blockquote>'+htmlEsc(f.quote)+'</blockquote>').join("")+'</details>' : '<p class="source-warning">'+htmlEsc(run.draft?.error || run.error || "结果未通过校验。")+'</p>')+'</article>').join("") : '<p class="note">尚未完成初评。</p>')+
    '<button type="button" class="text-button" id="wbRetryCurrent" '+(wbBusy() ? "disabled" : "")+'>重新评估本项</button></section>'+
    '<section class="wb-section"><h3>报告原文</h3>'+(evidence.length ? '<p class="note">'+evidence.length+' 条依据，展开出处查看原文。</p>'+evidence.map((entry,index)=>wbEvidenceHtml(entry,index===0)).join("") : '<p class="note">本项尚无检索依据，可使用下方全文检索。</p>')+
    (wbWorkspace.originalPdf ? '<button type="button" class="text-button" data-wb-pdf-page="1">打开报告原文</button>' : "")+
    '<div id="wbPdfViewer"></div><details><summary>全文检索</summary><form id="wbSearchForm" class="wb-search-row"><label class="sr-only" for="wbSearchQuery">检索报告原文</label><input id="wbSearchQuery" placeholder="输入中文关键词"><button type="submit" class="btn">检索原文</button></form><div id="wbSearchResults"></div></details></section>';
  wbQ("#wbReviewNotes").value = review.notes || "";
}

function wbRenderAll({ detail = false } = {}) {
  if (!wbQ("#wbStart")) return;
  wbRenderContext();
  wbRenderDocument();
  wbRenderControls();
  wbRenderResults();
  wbRenderReviewList();
  if (detail) wbRenderReviewDetail();
  wbSetStage(wbStage);
}
function wbSyncInputs() {
  for (const [id, key] of Object.entries(WB_PROJECT_FIELDS))
    wbQ("#" + id).value = wbWorkspace.project[key] || "";
  wbQ("#wbMethodAcknowledged").checked = wbWorkspace.methodAcknowledged;
  for (const n of wbRoot.querySelectorAll("[data-wb-issue]"))
    n.checked = wbWorkspace.selectedIssueIds.includes(n.dataset.wbIssue);
  wbQ("#wbReviewFilter").value = wbReviewFilter;
  wbRenderAll({ detail: true });
}
function wbReadProject() {
  if (wbBusy()) {
    wbSyncInputs();
    return;
  }
  const next = Object.fromEntries(
    Object.entries(WB_PROJECT_FIELDS).map(([id, key]) => [
      key,
      wbQ("#" + id).value.trim(),
    ]),
  );
  if (JSON.stringify(next) !== JSON.stringify(wbWorkspace.project)) {
    wbWorkspace.project = next;
    wbInvalidateTask();
    wbRenderAll({ detail: true });
  }
}
async function wbReadResponse(response) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("本机服务返回格式无效，请重新启动工作台。");
  }
  if (!response.ok)
    throw new Error(data.error || "请求失败（HTTP " + response.status + "）。");
  return data;
}
async function wbLoadProviders() {
  try {
    const data = await wbReadResponse(await fetch("/api/status"));
    // Legacy service compatibility is retained for existing installations.
    // Current service always advertises nativePdfReview; its live path is GLM only.
    wbGlmOnly = data.nativePdfReview === true;
    const selected = new Map(wbProviders.map((p) => [p.id, p.selected]));
    wbProviders = (data.providers || []).filter(p => !wbGlmOnly || usesNativePdf(p)).map((p) => ({
      ...p,
      selected: selected.has(p.id) ? selected.get(p.id) : true,
    }));
    if (wbGlmOnly && wbProviders.length) {
      const chosen = wbProviders.find(p => p.selected)?.id || wbProviders[0].id;
      wbProviders.forEach(p => { p.selected = p.id === chosen; });
    }
    wbApiConnected = true;
  } catch {
    wbApiConnected = false;
    wbStatus(
      "本机评估服务未连接。请使用文件夹中的「启动智能评估工作台」打开。",
      true,
    );
  }
  wbRenderProviders();
}
async function wbAddProvider() {
  if (wbBusy()) return;
  const apiKey = wbQ("#wbApiKey").value;
  try {
    if (!usesNativePdf({model:wbQ("#wbModelName").value.trim()})) throw Error("请选择 GLM 5.3 Flash 或 FlashX。");
    const data = await wbReadResponse(
      await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: wbQ("#wbProviderName").value.trim(),
          baseUrl: wbQ("#wbBaseUrl").value.trim(),
          model: wbQ("#wbModelName").value.trim(),
          apiKey,
        }),
      }),
    );
    wbProviders = [
      ...wbProviders.filter((p) => p.id !== data.provider.id).map(p => wbGlmOnly ? {...p,selected:false} : p),
      { ...data.provider, selected: true },
    ];
    wbApiConnected = true;
    wbRenderProviders();
    wbStatus("连接信息已加入内存；首次初评将检查模型是否可用。");
  } catch (e) {
    wbStatus(e.message, true);
  } finally {
    wbQ("#wbApiKey").value = "";
  }
}
// 主报告与年报共用上传校验；当前服务保留原PDF，上传不产生模型用量。
// 任务被取代时返回 null，避免旧上传结果覆盖新报告。
async function wbParsePdfFile(file, { onProgress, stillCurrent }) {
  if (!/\.pdf$/i.test(file.name)) throw new Error("请上传 PDF 报告。");
  if (!file.size || file.size > 30*1024*1024) throw new Error("PDF 为空或超过 30 MB。");
  const buffer = await file.arrayBuffer();
  if(wbGlmOnly || wbProviders.filter(p=>p.selected).some(usesNativePdf)){
    const data=await wbReadResponse(await fetch("/api/native-documents",{method:"POST",headers:{"Content-Type":"application/pdf","X-File-Name":encodeURIComponent(file.name)},body:buffer,signal:AbortSignal.timeout(60000)}));
    if(!stillCurrent())return null;
    const meta=data.meta;if(!meta?.pageCoverageComplete)throw Error("PDF页码读取失败。");
    const identityInfo=await reportIdentity(data.text,meta);
    return {buffer,text:data.text,meta,figures:[],warnings:[],identityInfo};
  }
  const job = await wbReadResponse(await fetch("/api/parse-pdf",{
    method:"POST",headers:{"Content-Type":"application/pdf","X-File-Name":encodeURIComponent(file.name)},
    body:buffer,signal:AbortSignal.timeout(60000),
  }));
  if (!job.jobId) throw new Error("识别任务未创建，请重新上传报告。");
  const deadline = Date.now()+32*60*1000;
  let data;
  while (stillCurrent()) {
    if (Date.now() > deadline) throw new Error("识别等待超时，请检查本机服务。");
    const state = await wbReadResponse(await fetch("/api/pdf-jobs/"+encodeURIComponent(job.jobId),{signal:AbortSignal.timeout(30000)}));
    onProgress?.(state);
    if (state.status === "failed") throw new Error(state.error || "PDF 解析失败。");
    if (state.status === "completed") { data = state.result; break; }
    await new Promise((resolve)=>setTimeout(resolve,1000));
  }
  if (!data) return null;
  const text = String(data?.text || ""), meta = data?.meta || {};
  if (!meta.pageCoverageComplete || meta.processedPages !== meta.pageCount)
    throw new Error("PDF 页码检查未通过，请重新识别。");
  if (!text.trim() || !parseReport(text,file.name,meta).length)
    throw new Error("报告没有可检索文字，请检查扫描清晰度。");
  if (new TextEncoder().encode(text).length > MAX_PARSED_BYTES)
    throw new Error("解析后的信息超过 16 MB，请拆分报告。");
  const identityInfo = await reportIdentity(text,meta);
  meta.markdownSha256 = identityInfo.markdownSha256; // Existing fingerprint contract.
  return { buffer, text, meta, warnings: data.warnings || [], figures: data.figures || [], identityInfo };
}
async function wbHandleFile(file) {
  if (!file || wbBusy()) return;
  const generation = ++wbFileGeneration,
    stillCurrent = () => generation === wbFileGeneration;
  wbUploading = true;
  wbUploadProgress = {phase:wbGlmOnly ? "正在载入原 PDF" : "正在上传到本机识别器",completed:0,total:0};
  wbRenderAll();
  try {
    const parsed = await wbParsePdfFile(file, {
      onProgress: (state) => {
        if (!stillCurrent()) return;
        wbUploadProgress = state;
        wbRenderDocument();
      },
      stillCurrent,
    });
    if (!parsed || !stillCurrent()) return;
    if (wbOriginalUrl) { URL.revokeObjectURL(wbOriginalUrl); wbOriginalUrl=""; }
    Object.assign(wbWorkspace,{
      documentName:file.name,documentText:parsed.text,documentId:parsed.identityInfo.documentId,
      documentEncoding:"逐页文字、图像及表格识别",documentWarnings:parsed.warnings,
      documentMeta:parsed.meta,originalPdf:parsed.buffer,figures:parsed.figures,figureTextChunks:[],
    });
    wbChunksCache=null; wbFigureChunks=[]; wbInvalidateTask();
    await wbDescribeFigures(wbWorkspace.figures);
    wbStartSemanticIndex();
    wbStatus(parsed.meta.converterVersion==="glm-native-pdf-v1" ? "原PDF已载入。请核对项目年度和对标议题，再开始阅读全文与评估。" : "报告所有页面已进入全文检索。请核对项目年度和对标议题，再开始评估。");
  } catch(error) { wbStatus(error.message || "PDF 读取失败，请检查报告。",true); }
  finally { if (stillCurrent()) wbUploading=false; wbRenderAll({detail:true}); }
}
async function wbHandleAnnualFile(file) {
  if (!file || wbBusy()) return;
  const generation = ++wbFileGeneration,
    stillCurrent = () => generation === wbFileGeneration;
  wbAnnualUploading = true;
  wbAnnualUploadProgress = {phase:wbGlmOnly ? "正在载入原 PDF" : "正在上传到本机识别器",completed:0,total:0};
  wbRenderAll();
  try {
    const parsed = await wbParsePdfFile(file, {
      onProgress: (state) => {
        if (!stillCurrent()) return;
        wbAnnualUploadProgress = state;
        wbRenderDocument();
      },
      stillCurrent,
    });
    if (!parsed || !stillCurrent()) return;
    wbWorkspace.annual = {
      name:file.name,text:parsed.text,id:parsed.identityInfo.documentId,
      encoding:"逐页文字、图像及表格识别",warnings:parsed.warnings,
      meta:parsed.meta,figures:parsed.figures,figureTextChunks:[],originalPdf:parsed.buffer,
    };
    wbChunksCache=null; wbAnnualFigureChunks=[]; wbInvalidateTask();
    await wbDescribeFigures(wbWorkspace.annual.figures, "annual");
    wbStartSemanticIndex();
    wbStatus(parsed.meta.converterVersion==="glm-native-pdf-v1" ? "年报原 PDF 已载入，开始初评时与主报告一起阅读全文。" : "公司年报已解析，与主报告一起进入全文检索和证据。");
  } catch(error) { wbStatus(error.message || "年报 PDF 读取失败，请检查文件。",true); }
  finally { if (stillCurrent()) wbAnnualUploading=false; wbRenderAll({detail:true}); }
}

function wbValidateStart() {
  if (!wbWorkspace.documentText || !wbWorkspace.originalPdf) return "请先上传 PDF 主报告。";
  if (!criteriaForIssues(wbWorkspace.selectedIssueIds).length)
    return "至少选择一个议题。";
  if (
    !wbWorkspace.project.client_name ||
    !wbWorkspace.project.report_period ||
    !wbWorkspace.project.target_period
  )
    return "请填写客户名称、报告覆盖年度和目标披露年度。";
  if (!wbWorkspace.methodAcknowledged) return "请勾选方法适用性核对提示。";
  if (!wbApiConnected || !wbProviders.some((p) => p.selected))
    return "请先连接并选择 GLM 模型。";
  if (wbGlmOnly && (wbProviders.filter(p => p.selected).length !== 1 || !wbProviders.filter(p => p.selected).every(usesNativePdf)))
    return "请选择一个 GLM 连接进行全文评估。";
  return "";
}
async function wbRunBatch(retryIds = null, { restart = false } = {}) {
  if (wbBusy()) return;
  wbReadProject();
  const error = wbValidateStart();
  if (error) {
    wbStatus(error, true);
    return;
  }
  let batch = wbCurrentBatch();
  if (!batch || restart) {
    wbWorkspace.batch = createBatch(wbWorkspace);
    batch = wbWorkspace.batch;
  }
  const selected = wbProviders.filter((p) => p.selected).slice(0, 3);
  wbQueue = selected.length===1 && usesNativePdf(selected[0]) ? new PdfAssessmentQueue({workspace:wbWorkspace,providers:selected,onChange:()=>{wbChunksCache=null;wbRenderAll();}}) : new AssessmentQueue({
    workspace: wbWorkspace,
    chunks: wbChunks(),
    providers: selected,
    semanticScores: wbSemanticQuery,
    request: async (payload) =>
      wbReadResponse(
        await fetch("/api/evaluate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(400000),
        }),
      ),
    onChange: () => wbRenderAll(),
  });
  wbSetStage("evaluation", true);
  wbStatus("初评运行中，请等待结果后对照原文。");
  try {
    await wbQueue.run({ retryIds: retryIds || [] });
    wbStatus(
      batch.phase === "finished"
        ? "本轮初评已结束。结果与失败项目均已保留，可查看原文、添加备注并导出。"
        : "任务已暂停或停止；可以继续未处理项目。",
    );
  } catch (e) {
    wbStatus(e.message, true);
  } finally {
    wbRenderAll({ detail: true });
  }
}
function wbReadReview() {
  if (wbBusy()) return;
  const r = wbCurrentRecord(), input = wbQ("#wbReviewNotes");
  if (!r || !input || String(r.review?.notes || "") === input.value) return;
  r.review ||= {};
  if (r.review.confirmedAt) {
    r.reviewHistory ||= [];
    r.reviewHistory.push({...r.review});
    r.review.confirmedAt = ""; r.review.decision = "pending";
  }
  r.review.notes = input.value;
  r.review.commentedAt = "";
  wbQ("#wbReviewBadge").textContent = "评论已修改，点击保存评论。";
  wbRenderReviewList();
}
async function wbSaveComment() {
  if (wbBusy()) return;
  wbReadReview();
  const r = wbCurrentRecord();
  if (!r) return;
  const old = r.review.commentedAt;
  r.review.commentedAt = String(r.review.notes || "").trim() ? new Date().toISOString() : "";
  if (!(await wbSave())) r.review.commentedAt = old;
  else wbStatus("评论已保存到本机，导出时会与本项初评和原文一起保留。");
  wbRenderReviewDetail(); wbRenderReviewList();
}

function wbExport() {
  if (wbBusy() || !wbWorkspace.originalPdf) return;
  wbReadReview();
  try {
    const result = exportAssessmentXlsx(wbWorkspace);
    wbStatus("已生成 "+result.filename+"，包含全部已选指标及评论。");
  } catch(error) { wbStatus(error.message || "评估表导出失败。",true); }
}

function wbDatabase(mode, operation) {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error("本机存储不可用，请导出复核记录。"));
      return;
    }
    const req = indexedDB.open(WB_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(WB_DB_STORE))
        req.result.createObjectStore(WB_DB_STORE);
    };
    req.onerror = () => reject(new Error("无法打开本机存储。"));
    req.onsuccess = () => {
      const db = req.result,
        tx = db.transaction(WB_DB_STORE, mode),
        r = operation(tx.objectStore(WB_DB_STORE));
      let result;
      r.onsuccess = () => {
        result = r.result;
      };
      r.onerror = () => reject(new Error("本机存储操作失败。"));
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(new Error("保存失败，请导出记录。"));
      };
    };
  });
}
async function wbSave() {
  wbReadReview();
  try {
    await wbDatabase("readwrite", (store) =>
      store.put(structuredClone(wbWorkspace), "current"),
    );
    wbStatus("草稿、报告与评论已保存到此浏览器本机。密钥未保存。");
    return true;
  } catch (e) {
    wbStatus(e.message, true);
    return false;
  }
}
async function wbRestore() {
  if (wbBusy()) return;
  try {
    const saved = await wbDatabase("readonly", (store) => store.get("current"));
    if (!saved) {
      wbStatus("此浏览器没有保存的草稿。");
      return;
    }
    if (
      !saved.records ||
      !saved.project ||
      typeof saved.documentText !== "string"
    )
      throw new Error("保存记录格式无效，请核对历史导出。");
    const old = wbWorkspace.records;
    wbWorkspace = {
      ...newWorkspace(),
      ...saved,
      records: { ...old, ...saved.records },
      project: { ...newWorkspace().project, ...saved.project },
      // 旧草稿没有年报字段时补默认值，行为与 project 一致。
      annual: { ...newWorkspace().annual, ...(saved.annual || {}) },
    };
    wbWorkspace.selectedIssueIds = (
      saved.selectedIssueIds || newWorkspace().selectedIssueIds
    ).filter((id) => KEY_ISSUES.some((i) => i.id === id));
    const needsPdf = !wbWorkspace.originalPdf || !["pdfkit-vision-structured-v2","glm-native-pdf-v1"].includes(wbWorkspace.documentMeta?.converterVersion);
    if (needsPdf) {
      Object.assign(wbWorkspace,{documentName:"",documentText:"",documentId:"",documentMeta:{},originalPdf:null,figures:[],figureTextChunks:[],batch:null});
    }
    if (wbWorkspace.documentText)
      wbWorkspace.documentId = (
        await reportIdentity(wbWorkspace.documentText, wbWorkspace.documentMeta)
      ).documentId;
    if (wbWorkspace.annual.text)
      wbWorkspace.annual.id = (
        await reportIdentity(wbWorkspace.annual.text, wbWorkspace.annual.meta)
      ).documentId;
    if (wbWorkspace.batch) {
      for (const state of Object.values(wbWorkspace.batch.states))
        if (state.status === "running") state.status = "pending";
      wbWorkspace.batch.phase = Object.values(wbWorkspace.batch.states).some(state=>state.status==='pending') ? "paused" : "finished";
      if (wbWorkspace.batch.context !== taskContext(wbWorkspace))
        wbWorkspace.batch = null;
    }
    if (wbOriginalUrl) {
      URL.revokeObjectURL(wbOriginalUrl);
      wbOriginalUrl = "";
    }
    wbChunksCache = null;
    wbFigureChunks = Array.isArray(wbWorkspace.figureTextChunks) ? wbWorkspace.figureTextChunks : [];
    wbAnnualFigureChunks = Array.isArray(wbWorkspace.annual.figureTextChunks) ? wbWorkspace.annual.figureTextChunks : [];
    wbFigureNote = "";
    wbQueue = null;
    wbSyncInputs();
    if (wbWorkspace.documentText) await wbDescribeFigures(wbWorkspace.figures || []);
    if (wbWorkspace.annual.text)
      await wbDescribeFigures(wbWorkspace.annual.figures || [], "annual");
    if (wbWorkspace.documentText || wbWorkspace.annual.text) wbStartSemanticIndex();
    else wbResetSemantic();
    wbStatus(needsPdf ? "历史评估与评论已恢复，请上传原 PDF 重新识别后继续评估。" : "草稿与评论已恢复，模型按当前连接状态使用。");
  } catch (e) {
    wbStatus(e.message, true);
  }
}
function wbPdfFile(source) {
  return source==='annual' ? {buffer:wbWorkspace.annual.originalPdf,name:wbWorkspace.annual.name} : {buffer:wbWorkspace.originalPdf,name:wbWorkspace.documentName};
}
async function wbShowPdf(page,source='main') {
  const file=wbPdfFile(source),buffer=file.buffer,label=source==='annual'?'年报 PDF':'原 PDF';
  if (!buffer) return;
  if (!wbOriginalUrl || wbOriginalBuffer!==buffer) {
    if(wbOriginalUrl)URL.revokeObjectURL(wbOriginalUrl);
    wbOriginalUrl = URL.createObjectURL(
      new Blob([buffer], { type: "application/pdf" }),
    );
    wbOriginalBuffer=buffer;
  }
  const target = wbQ("#wbPdfViewer");
  const request=++wbPreviewRequest;
  target.innerHTML='<p class="note" role="status">正在本机显示'+label+'第 '+Number(page)+' 页…</p>';
  target.scrollIntoView?.({ block: "nearest" });
  try {
    const response=await fetch('/api/pdf-page',{method:'POST',headers:{'Content-Type':'application/pdf','X-File-Name':encodeURIComponent(file.name),'X-PDF-Page':String(page)},body:buffer});
    const data=await response.json();
    if(!response.ok || data.page!==Number(page) || !/^data:image\/png;base64,/.test(data.dataUrl||''))throw Error(data.error||'原 PDF 页显示失败，请重试。');
    if(request!==wbPreviewRequest || !target.isConnected || buffer!==wbPdfFile(source).buffer)return;
    target.innerHTML='<p class="note">'+htmlEsc(file.name)+' · '+label+' 第 '+Number(page)+' 页 · 本机原页预览</p><img class="wb-pdf-page" alt="'+(source==='annual'?'年报':'报告原')+' PDF 第 '+Number(page)+' 页"><a class="text-button" href="'+htmlEsc(wbOriginalUrl)+'" download="'+htmlEsc(file.name)+'">下载'+label+'</a>';
    target.querySelector('img').src=data.dataUrl;
  } catch(error) {
    if(request===wbPreviewRequest && target.isConnected && buffer===wbPdfFile(source).buffer)target.innerHTML='<p class="note is-error" role="alert">'+htmlEsc(error.message||'原 PDF 页显示失败，请重试。')+'</p>';
  }
}
function wbOpenReview(id) {
  if (!CRITERION_BY_ID.has(id)) return;
  wbReadReview();
  wbWorkspace.activeCriterionId = id;
  wbSetStage("review", true);
  wbRenderReviewList();
  wbRenderReviewDetail();
}
async function wbRunSearch() {
  const query = wbQ("#wbSearchQuery").value;
  const scores = await wbSemanticQuery(wbChunks(), query);
  wbQ("#wbSearchResults").innerHTML =
    retrieveEvidence(wbChunks(), query, 6, { semanticScores: scores })
      .map((entry) => wbEvidenceHtml(entry))
      .join("") ||
    '<p class="note">未命中关键词，请更换词语或直接查看原文。</p>';
}
function wbBind() {
  if (wbRoot.dataset.wbEventsBound) return;
  wbRoot.dataset.wbEventsBound = "true";
  wbRoot.addEventListener("change", (e) => {
    const t = e.target;
    if (Object.hasOwn(WB_PROJECT_FIELDS, t.id)) wbReadProject();
    else if (t.id === "wbMethodAcknowledged")
      wbWorkspace.methodAcknowledged = t.checked;
    else if (t.id === "wbReportFile") {
      wbHandleFile(t.files?.[0]);
      t.value = "";
    } else if (t.id === "wbAnnualFile") {
      wbHandleAnnualFile(t.files?.[0]);
      t.value = "";
    } else if (t.matches("[data-wb-issue]")) {
      if (wbBusy()) return;
      t.checked
        ? (wbWorkspace.selectedIssueIds = [
            ...new Set([...wbWorkspace.selectedIssueIds, t.dataset.wbIssue]),
          ])
        : (wbWorkspace.selectedIssueIds = wbWorkspace.selectedIssueIds.filter(
            (id) => id !== t.dataset.wbIssue,
          ));
      wbInvalidateTask();
      wbRenderAll({ detail: true });
    } else if (t.matches("[data-wb-provider]")) {
      if (wbBusy()) return;
      const p = wbProviders.find((p) => p.id === t.dataset.wbProvider);
      if (wbGlmOnly) wbProviders.forEach(p => { p.selected = false; });
      if (p) p.selected = t.checked;
      wbRenderControls();
    } else if (t.id === "wbReviewFilter") {
      wbReviewFilter = t.value;
      wbRenderReviewList();
    } else if (t.id === "wbReviewIssue") wbRenderReviewList();
    else if(t.id==="wbEnableSemantic"){if(t.checked)wbStartSemanticIndex();else{wbResetSemantic();wbRenderDocument();}}
    else if (t.id === "wbReviewNotes") wbReadReview();
  });
  wbRoot.addEventListener("input", (e) => {
    if (Object.hasOwn(WB_PROJECT_FIELDS, e.target.id)) wbReadProject();
    else if (e.target.id === "wbReviewNotes") wbReadReview();
  });
  wbRoot.addEventListener("keydown", (e) => {
    const t = e.target.closest('[role="tab"][data-wb-stage]');
    if (!t) return;
    const i = WB_STAGES.indexOf(t.dataset.wbStage),
      next =
        e.key === "ArrowRight"
          ? (i + 1) % 3
          : e.key === "ArrowLeft"
            ? (i + 2) % 3
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? 2
                : null;
    if (next !== null) {
      e.preventDefault();
      wbSetStage(WB_STAGES[next], true);
    }
  });
  wbRoot.addEventListener("submit", (e) => {
    if (e.target.id === "wbProviderForm") {
      e.preventDefault();
      wbAddProvider();
    } else if (e.target.id === "wbSearchForm") {
      e.preventDefault();
      wbRunSearch();
    }
  });
  wbRoot.addEventListener("click", (e) => {
    const t = e.target.closest("button"),
      id = t?.id,
      stage = e.target.closest("[data-wb-stage]");
    if (stage) {
      wbReadReview();
      wbSetStage(stage.dataset.wbStage, true);
    }
    if (id === "wbStart") wbRunBatch(null, { restart: true });
    else if (id === "wbResume") wbRunBatch();
    else if (id === "wbPause") wbQueue?.pause();
    else if (id === "wbStop") wbQueue?.stop();
    else if (id === "wbRetryFailed")
      wbRunBatch(
        Object.entries(wbCurrentBatch()?.states || {})
          .filter(([, s]) => s.status === "failed")
          .map(([id]) => id),
      );
    else if (id === "wbToReview") {
      wbSetStage("review", true);
      if (!wbWorkspace.activeCriterionId)
        wbWorkspace.activeCriterionId =
          criteriaForIssues(wbWorkspace.selectedIssueIds)[0]?.id || "";
      wbRenderReviewList();
      wbRenderReviewDetail();
    } else if (id === "wbOpenSettings") {
      const menu = wbQ(".wb-tools");
      menu.open = true;
      menu.querySelector("summary").focus();
    } else if (id === "wbRefreshProviders" && !wbBusy()) wbLoadProviders();
    else if (id === "wbGovernanceDefault" && !wbBusy()) {
      wbWorkspace.selectedIssueIds = [
        ...new Set([
          ...wbWorkspace.selectedIssueIds,
          ...KEY_ISSUES.filter((i) => i.pillar === "governance").map(
            (i) => i.id,
          ),
        ]),
      ];
      wbInvalidateTask();
      wbSyncInputs();
    } else if (id === "wbDeselectAll" && !wbBusy()) {
      wbWorkspace.selectedIssueIds = [];
      wbInvalidateTask();
      wbSyncInputs();
    } else if (id === "wbClearDocument" && !wbBusy()) {
      ++wbFileGeneration;
      Object.assign(wbWorkspace, {
        documentName: "",
        documentText: "",
        documentId: "",
        documentEncoding: "",
        documentMeta: {},
        documentWarnings: [],
        originalPdf: null,
        figures: [],
        figureTextChunks: [],
      });
      wbChunksCache = null;
      wbFigureChunks = [];
      wbFigureNote = "";
      wbInvalidateTask();
      if (wbWorkspace.annual.text) wbStartSemanticIndex();
      else wbResetSemantic();
      if (wbOriginalUrl) {
        URL.revokeObjectURL(wbOriginalUrl);
        wbOriginalUrl = "";
      }
      wbRenderAll({ detail: true });
      wbStatus(
        "已移除当前报告，历史记录及已保存草稿保留。" +
          (wbWorkspace.annual.name ? "公司年报保留，仍在全文检索中。" : ""),
      );
    } else if (id === "wbRemoveAnnual" && !wbBusy()) {
      ++wbFileGeneration;
      wbWorkspace.annual = { ...newWorkspace().annual };
      wbChunksCache = null;
      wbAnnualFigureChunks = [];
      wbFigureNote = "";
      wbInvalidateTask();
      if (wbWorkspace.documentText) wbStartSemanticIndex();
      else wbResetSemantic();
      wbRenderAll({ detail: true });
      wbStatus("已移除年报，主报告及历史记录保留。");
    } else if (id === "wbSaveComment") wbSaveComment();
    else if (id === "wbRetryCurrent")
      wbRunBatch([wbWorkspace.activeCriterionId]);
    else if (id === "wbSave" || id === "wbSaveReview") wbSave();
    else if (id === "wbRestore") wbRestore();
    else if (id === "wbClearSaved" && !wbBusy())
      wbDatabase("readwrite", (store) => store.delete("current"))
        .then(() => wbStatus("已清除保存副本；当前页面数据仍保留。"))
        .catch((x) => wbStatus(x.message, true));
    else if (id === "wbExportXlsx") wbExport();
    if (t?.dataset.wbReview) wbOpenReview(t.dataset.wbReview);
    if (t?.dataset.wbRetry && !wbBusy()) wbRunBatch([t.dataset.wbRetry]);
    if (t?.dataset.wbPdfPage) wbShowPdf(t.dataset.wbPdfPage,t.dataset.wbPdfSource || 'main');

  });
}
export async function mountWorkbench(root = document.querySelector("#view")) {
  if (!root || !root.querySelector("#wbStart")) return;
  wbRoot = root;
  wbBind();
  wbSyncInputs();
  await wbLoadProviders();
}
