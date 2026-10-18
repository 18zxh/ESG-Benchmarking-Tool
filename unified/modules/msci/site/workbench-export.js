import { KEY_ISSUES, PILLARS, THEMES } from "./data/key-issues.js";
import { SOURCES } from "./data/core.js";
import { buildXlsx, downloadXlsx } from "./xlsx.js";
import { ALL_CRITERIA, assessmentRecordKey, assessmentDocumentId, latestAiRuns, STATUS_LABELS, evidenceLocation } from "./workbench-core.js";

const TASK_NAMES = {pending:"等待处理",running:"处理中",completed:"初评完成",failed:"初评失败",needs_evidence:"处理失败"};
const nameOf = (items,id) => items.find((x)=>x.id===id)?.name || "";
const reportLocation = (entry, workspace) =>
  (entry.filename || (entry.source === "annual" ? workspace.annual?.name || "公司年报" : workspace.documentName || "主报告")) + " · " + evidenceLocation(entry);
const multi = (runs,field) => runs.map((run) => {
  const value = run.draft[field];
  const text = Array.isArray(value) ? value.join("\n") : String(value || "");
  return text ? (runs.length>1 ? run.providerName+"："+text : text) : "";
}).filter(Boolean).join("\n\n");

// Excel cells have a hard character limit. Continuation rows retain the same
// structural identity, so an unusually long model answer never disappears.
function completeRows(rows, identityColumns) {
  return rows.flatMap((row,index) => {
    if (index===0) return [row];
    const count = Math.max(1,...row.map((value)=>Math.ceil(String(value ?? "").length/30000)));
    return Array.from({length:count},(_,part)=>row.map((value,column)=>{
      if (part===0 || column>=identityColumns) return typeof value==="number" ? (part===0 ? value : "") : String(value ?? "").slice(part*30000,(part+1)*30000);
      return column===0 ? String(row[0])+"（续"+part+"）" : value;
    }));
  });
}
export function buildAssessmentSheets(workspace) {
  const issues = KEY_ISSUES.filter((issue)=>(workspace.selectedIssueIds || []).includes(issue.id));
  if (!issues.length) throw new Error("请至少选择一个关键议题。");
  const selected = new Set(issues.map((issue)=>issue.id));
  const criteria = ALL_CRITERIA.filter((criterion)=>selected.has(criterion.issueId));
  const project = workspace.project || {}, meta = workspace.documentMeta || {};
  const info = [
    ["项目概况","内容"],["客户名称",project.client_name || "待填写"],
    ["报告覆盖年度",project.report_period || "待确认"],["目标披露年度",project.target_period || "待确认"],
    ["报告名称",meta.originalName || workspace.documentName || "未上传"],
    ["公司年报",workspace.annual?.name ? workspace.annual.name+" · "+(workspace.annual.meta?.pageCount || 0)+" 页" : "未上传"],
    ["年报原文件指纹",workspace.annual?.meta?.originalSha256 || ""],
    ["报告组合评估指纹",assessmentDocumentId(workspace)],
    ["客户评级资料及统计边界",project.assessment_scope || "待确认"],
    ["已选议题",issues.map((issue)=>issue.name).join("、")],["已选指标数",criteria.length],
    ["全文审阅页数",workspace.fullReview?.processedPages || 0],["已载入页数",meta.processedPages || 0],["报告总页数",meta.pageCount || 0],
    meta.converterVersion==="glm-native-pdf-v1" ? ["表格识别方式","随原PDF阅读全文，不单独计数"] : ["识别表格数",meta.tableCount || 0],["识别异常",(meta.issues || []).map((issue)=>"第"+issue.page+"页："+issue.message).join("\n") || "无已检测异常"],
    ["原报告指纹",meta.originalSha256 || ""],["解析器",meta.converterVersion || ""],["解析程序指纹",meta.parserSourceSha256 || ""],
    ["任务文档指纹",workspace.documentId || ""],
    ["导出范围","包含全部已选指标；尚未评估和初评失败项目保持各自状态。"],
    ["评论含义","人工评论与智能初评分列保存，评论不等于采纳模型判断。"],
    ["评估口径",workspace.fullReview?.readingComplete ? "原PDF全部物理页已审阅，按完整指标和保留的原文生成披露初评；未找到对应披露写未披露。此结果不是官方评级。" : "建议判断反映相关原文的披露充分性；每项模型收到相关片段，此结果不是官方评级。"],
  ];
  const framework = [["序号","支柱","主题","关键议题","组件数","指标及子指标数","治理关键指标数","方法来源","来源版本","来源指纹"]];
  issues.forEach((issue,index)=>{
    const source = SOURCES[issue.sourceId] || {};
    framework.push([index+1,nameOf(PILLARS,issue.pillar),nameOf(THEMES,issue.theme),issue.name,
      new Set(issue.indicators.map((item)=>item.component).filter(Boolean)).size,issue.indicators.length,issue.keyMetrics.length,
      source.originalFile || "",source.version || "",source.sha256 || ""]);
  });
  const indicators = [["序号","支柱","主题","关键议题","组件","指标","指标要求","层级","上级指标","评分规则原文","处理状态","建议判断","披露现状","披露不足","改进建议","报告出处","评论","方法出处"]];
  const governance = [["序号","支柱","主题","关键议题","类别","关键指标","指标要求","评分规则原文","处理状态","建议判断","披露现状","披露不足","改进建议","报告出处","评论","方法出处"]];
  const evidenceRows = [["关键议题","指标","报告出处","PDF 页数","原文摘录"]];
  let es=0,g=0,e=0;
  for (const criterion of criteria) {
    const issue = issues.find((item)=>item.id===criterion.issueId), item = criterion.item;
    const record = workspace.records?.[assessmentRecordKey(criterion.id,assessmentDocumentId(workspace),project)];
    const runs = latestAiRuns(record).filter((run)=>run.draft?.valid && !run.error && !run.groundingIssues?.length);
    const allRuns = latestAiRuns(record);
    const state = workspace.batch?.states?.[criterion.id]?.status || record?.taskStatus || "pending";
    const entries = [...new Map([...allRuns.flatMap((run)=>run.evidence || []),...(record?.manualEvidence || [])].map((entry)=>[entry.id,entry])).values()];
    const used = new Set(runs.flatMap((run)=>run.draft.evidenceRefs || []));
    const decision = runs.map((run)=>(runs.length>1 ? run.providerName+"：" : "")+(STATUS_LABELS[run.draft.disclosureStatus] || "")+(run.draft.suggestedScore ? "（建议分数："+run.draft.suggestedScore+"）" : "")).join("\n");
    const base = [nameOf(PILLARS,criterion.pillar),nameOf(THEMES,issue.theme),criterion.issueName];
    const result = [TASK_NAMES[state] || "等待处理",decision,multi(runs,"currentDisclosure"),multi(runs,"gaps"),multi(runs,"recommendation"),[...new Set(entries.map(entry=>reportLocation(entry,workspace)))].join("\n"),record?.review?.notes || "",(SOURCES[criterion.sourceId]?.originalFile || "")+"；第 "+criterion.pages.join("、")+" 页"];
    if (criterion.kind==="metric") {
      governance.push([++g,...base,item.categoryCn || item.category || "",item.nameCn || item.name,item.definitionCn || "",[item.scope,item.deduction,item.range].filter(Boolean).join("\n"),...result]);
    } else {
      indicators.push([++es,...base,item.componentCn || item.component || "",item.nameCn || item.name,item.definitionCn || "",item.level===1 ? "一级指标" : (item.level || 1)+"级子指标",item.parentCn || item.parent || "",item.scoringText || "",...result]);
    }
    entries.forEach((entry)=>{e++;evidenceRows.push([criterion.issueName,item.nameCn || item.name,reportLocation(entry,workspace),entry.pdfPage || "",entry.text || ""]);});
  }
  const sheets = [
    {name:"项目概况",rows:info,wrap:true,freezeRows:1,columnWidths:[24,85]},
    {name:"框架结构",rows:framework,wrap:true,freezeRows:1,autoFilter:true,columnWidths:[8,10,18,24,12,18,18,45,22,66]},
  ];
  if (es) sheets.push({name:"评分指标",rows:completeRows(indicators,9),wrap:true,freezeRows:1,autoFilter:true,columnWidths:[8,10,18,24,22,32,55,12,32,36,16,24,55,55,55,28,55,45]});
  if (g) sheets.push({name:"治理关键指标",rows:completeRows(governance,7),wrap:true,freezeRows:1,autoFilter:true,columnWidths:[8,10,18,24,22,32,55,36,16,24,55,55,55,28,55,45]});
  if (e) sheets.push({name:"原文证据",rows:completeRows(evidenceRows,4),wrap:true,freezeRows:1,autoFilter:true,columnWidths:[24,36,50,12,100]});
  return sheets;
}
export function exportAssessmentXlsx(workspace) {
  const sheets = buildAssessmentSheets(workspace);
  const client = String(workspace.project?.client_name || "当前项目").replace(/[\\/:*?"<>|\x00-\x1f]/g,"_").slice(0,80);
  return downloadXlsx(client+"-关键议题评估表.xlsx",buildXlsx(sheets));
}
