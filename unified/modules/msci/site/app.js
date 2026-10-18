import { META, CORE_MODULES, SOURCES } from "./data/core.js";
import { PILLARS, THEMES, KEY_ISSUES, KEY_ISSUE_STATS } from "./data/key-issues.js";
import { buildXlsx, downloadXlsx } from "./xlsx.js";
import { workbenchView, mountWorkbench } from "./workbench.js";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function highlight(value, terms = []) {
  const text = String(value || "");
  if (!terms.length) return esc(text);
  const re = new RegExp("(" + terms.filter(Boolean).map(escapeRe).join("|") + ")", "gi");
  return text.split(re).map((part, i) => i % 2 ? `<mark>${esc(part)}</mark>` : esc(part)).join("");
}
function snippet(body, terms, len = 160) {
  const text = String(body || ""), low = text.toLowerCase();
  const matches = terms.map((t) => low.indexOf(t.toLowerCase())).filter((p) => p >= 0);
  const start = matches.length ? Math.max(0, Math.min(...matches) - 45) : 0;
  return (start ? "…" : "") + text.slice(start, start + len) + (start + len < text.length ? "…" : "");
}
const pillarName = (id) => PILLARS.find((p) => p.id === id)?.name || "";
const pillarNameEn = (id) => PILLARS.find((p) => p.id === id)?.nameEn || "";
const themeName = (id) => THEMES.find((t) => t.id === id)?.name || "";
const themeNameEn = (id) => THEMES.find((t) => t.id === id)?.nameEn || "";
const typeName = (id) => ({ risk: "风险议题", opportunity: "机遇议题", governance: "治理议题" }[id] || id);
const biText = (cn, en, terms = []) => `<span class="lg-zh">${highlight(cn || en, terms)}</span>`;
const pageLabel = (pages) => [...new Set(pages || [])].join("、");

function sourceRef(id, pages, compact = false) {
  const s = SOURCES[id];
  if (!s) return "";
  const ps = pages?.length ? pages : [1];
  return `<div class="source-ref ${compact ? "compact" : ""}"><button type="button" class="source-pdf" data-open-pdf="${id}" data-page="${ps[0]}" aria-label="查看${esc(s.title)} PDF 第 ${ps[0]} 页">${esc(s.version)} 查看 PDF</button></div>`;
}
function tableHtml(t) {
  if (!t) return "";
  return `<div class="table-wrap"><table class="data"><thead><tr>${t.headers.map((v) => `<th scope="col">${esc(v)}</th>`).join("")}</tr></thead><tbody>${t.rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
const pdfUrls = new Map();
function pdfUrl(id, page) {
  if (!pdfUrls.has(id)) {
    if (typeof EMBEDDED_PDFS !== "undefined" && EMBEDDED_PDFS[id]) {
      const binary = atob(EMBEDDED_PDFS[id]);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      pdfUrls.set(id, URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })));
    } else pdfUrls.set(id, new URL(SOURCES[id].file, location.href.split("#")[0]).href);
  }
  return pdfUrls.get(id) + "#page=" + page;
}

function viewCore(id) {
  const m = CORE_MODULES.find((m) => m.id === id), s = SOURCES[m.sourceId];
  return `<header class="page-head"><h1>${esc(m.title)}</h1></header>
  <div class="reading-layout"><div class="chapter-content">${m.sections.map((section, i) => `<section class="chapter" id="section-${section.id}"><p class="chapter-num">${String(i + 1).padStart(2, "0")}</p><h2>${esc(section.title)}</h2>${section.body.map((p) => `<p>${esc(p)}</p>`).join("")}${tableHtml(section.table)}${section.note ? `<p class="source-warning">${esc(section.note)}</p>` : ""}${sourceRef(m.sourceId, section.pages)}</section>`).join("")}</div></div>
  <p class="version-foot">数据来源：${esc(s.title)}原始方法文件（${esc(s.version)}）。<a href="${META.officialUrl}" target="_blank" rel="noopener">查看 MSCI 方法文件页面 ↗</a></p>`;
}

function viewSource(id, params) {
  const s = SOURCES[id];
  if (!s) return `<div class="empty"><strong>未找到来源文件</strong><a href="#/issues">返回关键议题</a></div>`;
  const page = Math.max(1, Math.min(s.pages, Math.trunc(Number(params.get("page"))) || 1));
  const back = CORE_MODULES.some((m) => m.id === id) ? `#/${id}` : `#/issues/${id}`;
  return `<nav class="crumb" aria-label="原文位置"><a href="${back}">返回${esc(s.title)}</a><span class="sep">/</span><span aria-current="page">来源原文</span></nav>
  <header class="page-head"><h1>${esc(s.title)} · 原文</h1><p class="lede">${esc(s.version)}</p></header>
  <div class="page-controls"><a class="btn ${page <= 1 ? "disabled" : ""}" ${page > 1 ? `href="#/source/${id}?page=${page-1}"` : 'aria-disabled="true"'}>上一页</a><form id="sourcePageForm" data-source="${id}"><label for="sourcePageInput">PDF 页码</label><input id="sourcePageInput" type="number" min="1" max="${s.pages}" value="${page}" required /><button class="btn" type="submit">跳转</button><span>/ ${s.pages}</span></form><a class="btn ${page >= s.pages ? "disabled" : ""}" ${page < s.pages ? `href="#/source/${id}?page=${page+1}"` : 'aria-disabled="true"'}>下一页</a><button class="btn primary" type="button" data-open-pdf="${id}" data-page="${page}">打开原始 PDF ↗</button></div>
  <p class="reading-note">表格、图形和特殊字体的提取可能丢失布局；精确引用或判断边界时，请打开上方原始 PDF。页码按 PDF 文件的实际页序计算。</p>
  <pre class="pdf-text" lang="en">${esc(s.textPages[page-1])}</pre><details class="file-provenance"><summary>文件来源与校验信息</summary><dl><dt>原文件</dt><dd>${esc(s.originalFile)}</dd><dt>SHA-256</dt><dd class="mono">${esc(s.sha256)}</dd></dl></details>`;
}

const KIND_LABELS = { symbols:"术语与符号",methodology:"评级方法",process:"评级流程",history:"模型更新历史",issue:"关键议题",indicator:"议题指标",metric:"治理关键指标",source:"PDF 原文页" };
const KIND_GROUPS = { all:()=>true, core:(e)=>CORE_MODULES.some((m)=>m.id===e.kind), issue:(e)=>e.kind==="issue", metric:(e)=>["indicator","metric"].includes(e.kind), source:(e)=>e.kind==="source" };
const SEARCH_KINDS = new Set(Object.keys(KIND_GROUPS));
const SEARCH_PILLARS = new Set(["all", ...PILLARS.map((p)=>p.id)]);
const SEARCH_TYPES = new Set(["all", "risk", "opportunity", "governance"]);
function normalizeSearchFilters({kind="all",pillar="all",type="all"}={}) {
  return {
    kind: SEARCH_KINDS.has(kind) ? kind : "all",
    pillar: SEARCH_PILLARS.has(pillar) ? pillar : "all",
    type: SEARCH_TYPES.has(type) ? type : "all",
  };
}
const INDEX=[];
for (const m of CORE_MODULES) for (const s of m.sections) INDEX.push({id:`${m.id}-${s.id}`,kind:m.id,title:s.title,titleEn:m.titleEn,body:[...s.body,s.note,s.sourceText,s.table?.rows.flat().join(" "),...s.pages.map((p)=>SOURCES[m.sourceId].textPages[p-1])].filter(Boolean).join(" "),keys:`${m.title} ${m.titleEn}`,route:`#/${m.id}?section=${s.id}`,meta:`${m.title} · ${SOURCES[m.sourceId].version} · PDF ${pageLabel(s.pages)}`});
for(const issue of KEY_ISSUES) {
  const common={pillar:issue.pillar,type:issue.type,theme:issue.theme};
  INDEX.push({...common,id:"issue-"+issue.id,kind:"issue",title:issue.name,titleEn:issue.nameEn,body:[issue.summary,issue.intro,...issue.risksCn,...issue.risks,issue.sourceNote,...issue.rules.flatMap(r=>r.body)].filter(Boolean).join(" "),keys:`${pillarName(issue.pillar)} ${themeName(issue.theme)} ${typeName(issue.type)} ${issue.id}`,route:`#/issues/${issue.id}`,meta:`${themeName(issue.theme)} · ${issue.doc.versionLabel}`});
  issue.indicators.forEach((ind,n)=>INDEX.push({...common,id:`ind-${issue.id}-${n}`,kind:"indicator",title:ind.nameCn,titleEn:ind.name,body:[ind.definitionCn,ind.definition,ind.sourceNote].filter(Boolean).join(" "),keys:`${issue.name} ${issue.nameEn} ${ind.componentCn} ${ind.component}`,route:`#/issues/${issue.id}?item=ind-${n}`,meta:`${issue.name} · PDF ${pageLabel(ind.sourcePages)}`}));
  issue.keyMetrics.forEach((km,n)=>INDEX.push({...common,id:`km-${issue.id}-${n}`,kind:"metric",title:km.nameCn,titleEn:km.fullName,body:[km.definitionCn,km.definition,km.scoringText].filter(Boolean).join(" "),keys:`${issue.name} ${issue.nameEn} ${km.categoryCn} ${km.category}`,route:`#/issues/${issue.id}?item=km-${n}`,meta:`${issue.name} · PDF ${pageLabel(km.sourcePages)}`}));
}
for (const s of Object.values(SOURCES)) s.textPages.forEach((text,n)=>INDEX.push({id:`source-${s.id}-${n+1}`,kind:"source",title:`${s.title} · 第 ${n+1} 页`,titleEn:s.originalFile,body:text,keys:`${s.title} ${s.version}`,pillar:KEY_ISSUES.find((i)=>i.id===s.id)?.pillar,type:KEY_ISSUES.find((i)=>i.id===s.id)?.type,route:`#/source/${s.id}?page=${n+1}`,meta:s.version}));
const parseTerms = (q) => String(q || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
function searchEntries(q, filters={}) {
  const {kind,pillar,type}=normalizeSearchFilters(filters);
  const terms=parseTerms(q), fn=KIND_GROUPS[kind] || KIND_GROUPS.all;
  const pool=INDEX.filter(e=>fn(e)&&(pillar==="all" || e.pillar===pillar)&&(type==="all" || e.type===type));
  const results=[];
  for(const entry of pool) {
    const fields=[entry.title,entry.titleEn,entry.keys,entry.body].map(s=>String(s||"").toLowerCase());
    let score=0,match=true;
    for(const term of terms) { const hits=fields.map(s=>s.includes(term)); if(!hits.some(Boolean)){match=false;break;} score+=hits.reduce((n,h,i)=>n+(h?[12,8,5,3][i]:0),0); }
    if(match) results.push({entry,score:score+(entry.kind==="source" ? -1 : 0),terms});
  }
  return results.sort((a,b)=>b.score-a.score || a.entry.title.localeCompare(b.entry.title,"zh"));
}

const issueState={pillar:"all"};

function viewIssues() {
  return `
  <header class="page-head">
    <h1>关键议题</h1>
    
    <p class="lede">MSCI ESG 评级框架为 3 个支柱 → 10 个主题 → 33 个关键议题。环境与社会通常按行业选取 2–7 个议题；治理具有普遍重要性，个别指标及发行人仍有适用边界。33 份议题 PDF 的指标已逐项核对并补齐子指标。</p>
  </header>
  <div class="issue-counts"><span><b>469</b> 环境与社会指标（含子指标）</span><span><b>107</b> 治理关键指标</span></div>
  ${sourceRef("methodology", [6,12])}
  <div class="toolbar">
    <button class="btn" id="exportToggle" type="button" aria-expanded="false" aria-controls="exportPanel">
      ${navIcon("download")} 导出 Excel 框架与评分指标
    </button>
  </div>

  <div class="export-panel" id="exportPanel" hidden>
    <div class="export-actions">
      <span class="note">快速选择：</span>
      <button class="chip" type="button" data-sel="all">全选</button>
      <button class="chip" type="button" data-sel="none">清空</button>
      <button class="chip" type="button" data-sel="env">仅环境</button>
      <button class="chip" type="button" data-sel="soc">仅社会</button>
      <button class="chip" type="button" data-sel="gov">仅治理</button>
      <label class="check"><input type="checkbox" id="exportEn" /> 包含英文原文</label>
      <span class="note" id="exportCount"></span>
    </div>
    <div class="export-tree" id="exportTree">${exportTreeHtml()}</div>
    <div class="export-actions">
      <button class="btn primary" type="button" id="exportGo">导出所选议题（.xlsx）</button>
      <span class="note" id="exportStatus">导出内容含「导出说明 / 框架结构 / 评分指标」，选择治理议题时另含「治理关键指标」工作表。</span>
    </div>
  </div>

  <div class="hier-table hier-3" id="issueGrid"></div>
  <p class="note" style="margin-top:12px">数据来源：33 份关键议题方法论文档（2026 年 3 月版 31 份、6 月版 2 份）。</p>`;
}

function renderIssueGrid() {
  const grid = $("#issueGrid");
  if (!grid) return;
  const list = KEY_ISSUES.filter((i) => issueState.pillar === "all" || i.pillar === issueState.pillar);
  const groups = PILLARS.map((p) => ({
    ...p,
    themes: THEMES.filter((t) => t.pillar === p.id)
      .map((t) => ({ ...t, issues: list.filter((i) => i.theme === t.id) }))
      .filter((t) => t.issues.length),
  })).filter((p) => p.themes.length);

  const themeCount = groups.reduce((n, p) => n + p.themes.length, 0);
  const cells = [
    `<div class="ht-head" style="grid-column:1;grid-row:1">支柱 <span class="ht-head-num">${groups.length}</span></div>`,
    `<div class="ht-head" style="grid-column:2;grid-row:1">主题 <span class="ht-head-num">${themeCount}</span></div>`,
    `<div class="ht-head" style="grid-column:3;grid-row:1">关键议题 <span class="ht-head-num">${list.length}</span></div>`,
    `<div class="ht-head" style="grid-column:4;grid-row:1">来源</div>`,
  ];

  let row = 2; // 第 1 行为表头
  for (const p of groups) {
    const pStart = row;
    const body = [];
    for (const t of p.themes) {
      body.push(`<div class="ht-theme" style="grid-column:2;grid-row:${row}/span ${t.issues.length}">
          <b>${esc(t.name)}</b>
          <span class="ht-count">${t.issues.length} 个议题</span>
        </div>`);
      for (const i of t.issues) {
        body.push(`<a class="ht-issue" style="grid-column:3;grid-row:${row}" href="#/issues/${i.id}"
            title="${esc(i.summary)}">
            <span>${esc(i.name)}</span>
            
            <span class="badge-type ${i.type}">${esc(typeName(i.type))}</span>
          </a>`);
        body.push(`<div class="ht-version" style="grid-column:4;grid-row:${row}"><button type="button" class="source-pdf" data-open-pdf="${i.sourceId}" data-page="1" aria-label="查看${esc(i.name)} PDF">${esc(i.doc.versionLabel)} 查看 PDF</button></div>`);
        row++;
      }
    }
    const pCount = row - pStart;
    const active = issueState.pillar === p.id;
    cells.push(`<button class="ht-pillar" type="button" data-pillar="${p.id}" aria-pressed="${active}"
        style="grid-column:1;grid-row:${pStart}/span ${pCount}"
        title="${active ? "点击取消该支柱筛选" : "点击仅显示该支柱议题"}">
        <b>${esc(p.name)}支柱</b>
        <span class="ht-count">${pCount} 个议题</span>
      </button>`);
    cells.push(...body);
  }

  grid.innerHTML = list.length
    ? cells.join("")
    : `<div class="empty" style="grid-column:1/-1"><strong>没有议题</strong>请点击左侧支柱取消筛选。</div>`;

  grid.querySelectorAll("button.ht-pillar").forEach((btn) =>
    btn.addEventListener("click", () => {
      issueState.pillar = issueState.pillar === btn.dataset.pillar ? "all" : btn.dataset.pillar;
      mountIssues();
    })
  );
}

function syncIssuesUrl() {
  const q = new URLSearchParams();
  if (issueState.pillar !== "all") q.set("pillar", issueState.pillar);
  const qs = q.toString();
  history.replaceState(null, "", "#/issues" + (qs ? "?" + qs : ""));
}

function mountIssues() {
  const viewEl = $("#view");
  viewEl.innerHTML = viewIssues();
  bindExportPanel();
  renderIssueGrid();
  syncIssuesUrl();
}


/* ==========================================================================
   导出 Excel（关键议题框架与评分指标，可选择范围）
   ========================================================================== */
const exportSel = new Set(KEY_ISSUES.map((i) => i.id)); // 默认全选

function exportScopeLabel(ids) {
  const set = new Set(ids);
  if (ids.length === KEY_ISSUES.length) return "全部议题";
  const fullPillars = PILLARS.filter((p) => KEY_ISSUES.filter((i) => i.pillar === p.id).every((i) => set.has(i.id)));
  if (fullPillars.length && KEY_ISSUES.every((i) => set.has(i.id) || !fullPillars.some((p) => p.id === i.pillar))) {
    return fullPillars.map((p) => p.name).join("+");
  }
  const fullThemes = THEMES.filter((t) => {
    const s = KEY_ISSUES.filter((i) => i.theme === t.id);
    return s.length && s.every((i) => set.has(i.id));
  });
  if (fullThemes.length && KEY_ISSUES.every((i) => set.has(i.id) || !fullThemes.some((t) => t.id === i.theme))) {
    return fullThemes.map((t) => t.name).join("+");
  }
  return `${ids.length}个议题`;
}

function exportComponentCount(issue) {
  return new Set(issue.indicators.map((x) => x.component).filter(Boolean)).size;
}

function buildExportSheets(list, withEn) {
  const col=(cn,en)=>withEn ? [cn,en] : [cn];
  const info=[
    ["MSCI ESG 关键议题 · 源文件核验版"],["导出时间",new Date().toISOString()],["内容核对日期",META.checkedOn],
    ["议题范围",exportScopeLabel(list.map(i=>i.id))],["议题数量",list.length],
    ["环境与社会指标（含子指标）",list.reduce((n,i)=>n+i.indicators.length,0)],["治理关键指标",list.reduce((n,i)=>n+i.keyMetrics.length,0)],
    ["文档版本",[...new Set(list.map(i=>i.doc.versionLabel))].join(" / ")],["包含英文原文",withEn ? "是" : "否"],
    ["来源", "随网站保存的 33 份 MSCI 关键议题原始 PDF；页码按文件页序计算。"],
    ["使用说明","中文为译文或解读，精确表述以英文 PDF 为准。指标与子指标均单列；原文标尺冲突或残句见“核对提示”。未披露的字段写“原文未单列”。公开方法文件不足以复算完整官方评级。"],
  ];
  const framework=[["序号",...col("支柱","Pillar"),...col("主题","Theme"),...col("关键议题","Key Issue"),"类型","组件数","指标及子指标数","治理关键指标数","文档版本","文档页数","源 PDF 文件","核对提示"]];
  const indicators=[["序号",...col("支柱","Pillar"),...col("主题","Theme"),...col("关键议题","Key Issue"),...col("组件","Component"),...col("指标","Indicator"),...col("定义","Definition"),"层级",...col("上级指标","Parent Indicator"),"文档版本","PDF 页码","源 PDF 文件","核对提示"]];
  const governance=[["序号",...col("关键议题","Key Issue"),...col("类别","Category"),...col("关键指标","Key Metric"),...col("定义","Definition"),"适用范围（英文原文）","典型扣分／贡献（英文原文）","贡献区间（英文原文）","文档版本","PDF 页码","源 PDF 文件"]];
  let n2=0,n3=0;
  const fields=(cn,en)=>withEn ? [cn,en] : [cn];
  for(const [n,i] of list.entries()) {
    const source=SOURCES[i.sourceId];
    const base=[...fields(pillarName(i.pillar),pillarNameEn(i.pillar)),...fields(themeName(i.theme),themeNameEn(i.theme)),...fields(i.name,i.nameEn)];
    framework.push([n+1,...base,typeName(i.type),exportComponentCount(i),i.indicators.length,i.keyMetrics.length,i.doc.versionLabel,i.doc.pages,source.originalFile,i.sourceNote || "无已识别异常"]);
    for(const a of i.indicators)indicators.push([++n2,...base,...fields(a.componentCn,a.component),...fields(a.nameCn,a.name),...fields(a.definitionCn,a.definition),a.level===1 ? "一级指标" : `${a.level} 级子指标`,...fields(a.parentCn || "不适用",a.parent || "Not applicable"),i.doc.versionLabel,pageLabel(a.sourcePages),source.originalFile,a.sourceNote || "无已识别异常"]);
    for(const a of i.keyMetrics)governance.push([++n3,...fields(i.name,i.nameEn),...fields(a.categoryCn,a.category),...fields(a.nameCn,a.name),...fields(a.definitionCn,a.definition),a.scope || "原文未单列",a.deduction || "原文未单列",a.range || "原文未单列",i.doc.versionLabel,pageLabel(a.sourcePages),source.originalFile]);
  }
  const sheets=[{name:"导出说明",rows:info,plainHeader:true},{name:"框架结构",rows:framework,plainHeader:true},{name:"评分指标",rows:indicators,plainHeader:true}];
  if(n3)sheets.push({name:"治理关键指标",rows:governance,plainHeader:true});
  return sheets;
}


function setExportStatus(msg, ok = true) {
  const el = $("#exportStatus");
  if (el) { el.textContent = msg; el.classList.toggle("export-error", !ok); }
}

function exportIssues(ids, withEn) {
  const list = KEY_ISSUES.filter((i) => ids.includes(i.id));
  if (!list.length) { setExportStatus("请至少选择一个议题后再导出。", false); return; }
  const sheets = buildExportSheets(list, withEn);
  const bytes = buildXlsx(sheets);
  const d = new Date();
  const ds = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const label = exportScopeLabel(ids).replace(/[\\/:*?"<>|\s]/g, "");
  const download = downloadXlsx(`MSCI关键议题_框架与评分指标_${label}_${ds}.xlsx`, bytes);
  setExportStatus(`已生成 ${list.length} 个议题：框架结构 ${list.length} 行、评分指标 ${list.reduce((n, i) => n + i.indicators.length, 0)} 行${list.some((i) => i.keyMetrics.length) ? "、治理关键指标 " + list.reduce((n, i) => n + i.keyMetrics.length, 0) + " 行" : ""}。`);
  const status = $("#exportStatus");
  if (status && download?.url) {
    const link = document.createElement("a");
    link.href = download.url; link.download = download.filename; link.id = "exportDownload";
    link.textContent = "下载 Excel"; link.className = "export-download";
    status.appendChild(link);
  }
}

function exportTreeHtml() {
  return PILLARS.map((p) => {
    const themes = THEMES.filter((t) => t.pillar === p.id);
    return `<div class="exp-group">
      <label class="exp-pillar ${p.id}">
        <input type="checkbox" data-pillar="${p.id}" />
        <b>${esc(p.name)}支柱</b>
      </label>
      <div class="exp-themes">
        ${themes.map((t) => {
          const issues = KEY_ISSUES.filter((i) => i.theme === t.id);
          return `<div class="exp-theme">
            <label class="exp-theme-label"><input type="checkbox" data-theme="${t.id}" /><b>${esc(t.name)}</b></label>
            <div class="exp-issues">
              ${issues.map((i) => `<label class="exp-issue"><input type="checkbox" data-issue="${i.id}" /><span>${esc(i.name)}</span><span class="note mono">${esc(i.doc?.versionLabel || "")}</span></label>`).join("")}
            </div>
          </div>`;
        }).join("")}
      </div>
    </div>`;
  }).join("");
}

function syncExportTree() {
  const tree = $("#exportTree");
  if (!tree) return;
  tree.querySelectorAll("input[data-issue]").forEach((cb) => { cb.checked = exportSel.has(cb.dataset.issue); });
  const tri = (cb, items) => {
    const n = items.filter((i) => exportSel.has(i.id)).length;
    cb.checked = n === items.length && n > 0;
    cb.indeterminate = n > 0 && n < items.length;
  };
  tree.querySelectorAll("input[data-theme]").forEach((cb) => tri(cb, KEY_ISSUES.filter((i) => i.theme === cb.dataset.theme)));
  tree.querySelectorAll("input[data-pillar]").forEach((cb) => tri(cb, KEY_ISSUES.filter((i) => i.pillar === cb.dataset.pillar)));
  const c = $("#exportCount");
  if (c) c.textContent = `已选 ${exportSel.size} / ${KEY_ISSUE_STATS.issues} 个议题`;
}

function bindExportPanel() {
  // 详情页「导出本议题」按钮（不依赖列表页的导出面板）
  document.querySelectorAll("[data-export-issue]").forEach((btn) =>
    btn.addEventListener("click", () => exportIssues([btn.dataset.exportIssue], $("#exportEn")?.checked !== false))
  );

  const toggle = $("#exportToggle");
  const panel = $("#exportPanel");
  if (!toggle || !panel) return;
  toggle.addEventListener("click", () => {
    const open = panel.hidden;
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) syncExportTree();
  });

  const tree = $("#exportTree");
  if (tree) {
    tree.addEventListener("change", (e) => {
      const t = e.target;
      const apply = (items, on) => items.forEach((i) => (on ? exportSel.add(i.id) : exportSel.delete(i.id)));
      if (t.dataset.issue) { apply([KEY_ISSUES.find((i) => i.id === t.dataset.issue)], t.checked); }
      else if (t.dataset.theme) { apply(KEY_ISSUES.filter((i) => i.theme === t.dataset.theme), t.checked); }
      else if (t.dataset.pillar) { apply(KEY_ISSUES.filter((i) => i.pillar === t.dataset.pillar), t.checked); }
      syncExportTree();
    });
  }

  document.querySelectorAll("[data-sel]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const mode = btn.dataset.sel;
      exportSel.clear();
      const add = (items) => items.forEach((i) => exportSel.add(i.id));
      if (mode === "all") add(KEY_ISSUES);
      if (mode === "env") add(KEY_ISSUES.filter((i) => i.pillar === "environmental"));
      if (mode === "soc") add(KEY_ISSUES.filter((i) => i.pillar === "social"));
      if (mode === "gov") add(KEY_ISSUES.filter((i) => i.pillar === "governance"));
      syncExportTree();
      setExportStatus("");
    })
  );

  const go = $("#exportGo");
  if (go) go.addEventListener("click", () => exportIssues([...exportSel], $("#exportEn")?.checked !== false));
}


/* ==========================================================================
   视图：议题详情
   ========================================================================== */
function viewIssueDetail(id, params) {
  const issue=KEY_ISSUES.find(i=>i.id===id);
  if(!issue)return `<div class="empty"><strong>未找到该议题</strong><a href="#/issues">返回关键议题列表</a></div>`;
  const compGroups=[],kmGroups=[];
  for(const ind of issue.indicators) {
    let g=compGroups.find(g=>g.key===ind.component);
    if(!g){g={key:ind.component,cn:ind.componentCn,items:[]};compGroups.push(g);}g.items.push(ind);
  }
  for(const km of issue.keyMetrics) {
    let g=kmGroups.find(g=>g.key===km.category);
    if(!g){g={key:km.category,cn:km.categoryCn,items:[]};kmGroups.push(g);}g.items.push(km);
  }
  const indCells=[`<div class="ht-head" style="grid-column:1;grid-row:1">组件 <span class="ht-head-num">${compGroups.length}</span></div>`,`<div class="ht-head" style="grid-column:2;grid-row:1">指标（含子指标） <span class="ht-head-num">${issue.indicators.length}</span></div>`];
  let row=2;
  for(const g of compGroups) {
    const en=g.key==="Covered Bond Issuers" ? "Treatment of covered bonds issuers" : `${issue.nameEn} ${g.key} score`;
    indCells.push(`<div class="ht-label" style="grid-column:1;grid-row:${row}/span ${g.items.length}"><b>${esc(g.cn)}</b></div>`);
    for(const ind of g.items) {
      const n=issue.indicators.indexOf(ind);
      indCells.push(`<article class="ht-row ${ind.level>1 ? "sub" : ""} ${ind.level===3 ? "sub-deep" : ""}" style="grid-column:2;grid-row:${row}" id="item-ind-${n}">
      ${ind.level>1 ? `<p class="parent-label">${ind.level===3 ? "三级" : "二级"}子指标 · 隶属${esc(ind.parentCn || ind.parent)}</p>` : ""}
      <h4>${biText(ind.nameCn,ind.name)}</h4><p>${biText(ind.definitionCn,ind.definition)}</p>${ind.sourceNote ? `<p class="source-warning">${esc(ind.sourceNote)}</p>` : ""}${sourceRef(id,ind.sourcePages,true)}</article>`);row++;
    }
  }
  const kmCells=[`<div class="ht-head" style="grid-column:1;grid-row:1">类别 <span class="ht-head-num">${kmGroups.length}</span></div>`,`<div class="ht-head" style="grid-column:2;grid-row:1">治理关键指标 <span class="ht-head-num">${issue.keyMetrics.length}</span></div>`];
  row=2;
  for(const g of kmGroups) {
    kmCells.push(`<div class="ht-label" style="grid-column:1;grid-row:${row}/span ${g.items.length}"><b>${esc(g.cn)}</b></div>`);
    for(const km of g.items) {
      const n=issue.keyMetrics.indexOf(km);
      kmCells.push(`<article class="ht-row" style="grid-column:2;grid-row:${row}" id="item-km-${n}"><h4>${biText(km.nameCn,km.name)}</h4><p>${biText(km.definitionCn,km.definition)}</p>
      <details class="scoring-rules"><summary>适用范围与扣分规则（英文原文）</summary><dl><dt>适用范围</dt><dd lang="en">${esc(km.scope || "原文未单列")}</dd><dt>典型扣分／贡献（正负号照录）</dt><dd lang="en">${esc(km.deduction || "原文未单列")}</dd><dt>得分贡献区间</dt><dd lang="en">${esc(km.range || "原文未单列")}</dd></dl><p class="lg-en" lang="en">${esc(km.scoringText)}</p></details>${sourceRef(id,km.sourcePages,true)}</article>`);row++;
    }
  }
  return `<div class="detail-head"><nav class="crumb" aria-label="结构位置"><a href="#/issues">关键议题</a><span class="sep">/</span><a href="#/issues?pillar=${issue.pillar}">${esc(pillarName(issue.pillar))}支柱</a><span class="sep">/</span><span>${esc(themeName(issue.theme))}</span></nav>
  <div class="detail-title"><h1>${esc(issue.name)}</h1><span class="badge-type ${issue.type}">${typeName(issue.type)}</span></div><p class="lede">${esc(issue.summary)}</p>${sourceRef(id,issue.introPages)}</div>
  <div class="toolbar"><button class="btn" type="button" data-export-issue="${id}">导出本议题 Excel</button><span class="note" id="exportStatus" aria-live="polite">含中英文、源文件版本与 PDF 页码。</span></div>
  ${issue.sourceNote ? `<p class="source-warning">${esc(issue.sourceNote)} <a href="#/methodology?section=hierarchy">查看当前框架</a></p>` : ""}
  <div class="issue-counts"><span><b>${issue.indicators.length || issue.keyMetrics.length}</b> ${issue.indicators.length ? "指标及子指标" : "治理关键指标"}</span><span>${esc(issue.doc.versionLabel)}</span></div>
  <section class="section scoring-context"><h2>如何理解本议题的评分</h2><p>${esc(issue.scoringNote)}</p>${sourceRef("methodology",issue.scoringPages)}<p class="note">本页指标按源 PDF 的组件及标题层级整理；子指标包含在条目数中。行业分支、敞口构建、例外及权重需结合原始 PDF 查阅。</p></section>
  ${issue.risks.length ? `<section class="section"><h2>关联风险</h2><ul>${issue.risks.map((r,n)=>`<li>${biText(issue.risksCn[n],r)}</li>`).join("")}</ul>${sourceRef(id,issue.riskPages)}</section>` : ""}
  ${issue.rules.map(r=>`<section class="section"><h2>${esc(r.title)}</h2>${r.body.map(p=>`<p>${esc(p)}</p>`).join("")}${tableHtml(r.table)}${r.note ? `<p class="source-warning">${esc(r.note)}</p>` : ""}${sourceRef(id,r.pages)}</section>`).join("")}
  ${compGroups.length ? `<section class="section"><h2>组件与管理指标 <small>${issue.indicators.length} 条</small></h2><div class="hier-table hier-2">${indCells.join("")}</div></section>` : ""}
  ${kmGroups.length ? `<section class="section"><h2>治理类别与关键指标 <small>${issue.keyMetrics.length} 条</small></h2><div class="hier-table hier-2">${kmCells.join("")}</div></section>` : ""}`;
}

const searchState={q:"",kind:"all",pillar:"all",type:"all",page:1};
const QUICK_QUERIES=["AAA","WAKIS","缓冲带","碳排放目标","董事会固化","税收透明度","v5.0.2"];
function viewSearch() {
  return `<header class="page-head"><h1>知识查询</h1><p class="lede">检索四个新模块、关键议题、指标及源 PDF 全文。支持中英文；多个关键词按同时匹配查询。</p></header>
  <div class="search-panel"><form class="search-big" id="searchForm" role="search"><input type="search" id="searchInput" aria-label="检索关键词" placeholder="例如：治理扣分、碳排放目标、税收透明度…" value="${esc(searchState.q)}" /><button type="submit">检索</button></form>
  <div class="filters" role="group" aria-label="检索条件"><div class="filter-group" id="kindFilter"><span>范围</span>${Object.entries({all:"全部",core:"四个新模块",issue:"关键议题",metric:"指标",source:"PDF 原文"}).map(([k,v])=>`<button class="chip" type="button" data-v="${k}" aria-pressed="${searchState.kind===k}">${v}</button>`).join("")}</div>
  <div class="filter-group" id="pillarFilterS"><span>支柱</span>${[{id:"all",name:"全部"},...PILLARS].map(p=>`<button class="chip" type="button" data-v="${p.id}" aria-pressed="${searchState.pillar===p.id}">${p.name}</button>`).join("")}</div>
  <div class="filter-group" id="typeFilterS"><span>类型</span>${Object.entries({all:"全部",risk:"风险",opportunity:"机遇",governance:"治理"}).map(([k,v])=>`<button class="chip" type="button" data-v="${k}" aria-pressed="${searchState.type===k}">${v}</button>`).join("")}</div></div>
  <p class="search-hint">支柱和类型仅适用于议题、指标及议题 PDF；选择后，四个新模块不进入结果。</p><div class="quick-queries">${QUICK_QUERIES.map(q=>`<button class="chip" type="button" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div></div>
  <p class="result-count" id="resultCount" aria-live="polite"></p><div class="result-list" id="resultList"></div><div id="resultPages" class="page-controls"></div>`;
}
function renderResults() {
  const results=searchEntries(searchState.q,searchState),size=30,totalPages=Math.max(1,Math.ceil(results.length/size));
  searchState.page=Math.max(1,Math.min(searchState.page,totalPages));
  const start=(searchState.page-1)*size,end=Math.min(start+size,results.length);
  $("#resultCount").textContent=`共 ${results.length} 条${searchState.q ? `与“${searchState.q}”匹配` : "知识条目"}${results.length ? ` · 显示第 ${start+1}–${end} 条` : ""}`;
  $("#resultList").innerHTML=results.length ? results.slice(start,end).map(({entry:e,terms})=>`<a class="result" href="${e.route}"><div class="result-head"><span class="result-kind">${KIND_LABELS[e.kind]}</span><h3>${highlight(e.title,terms)}</h3><span class="note">${esc(e.meta)}</span></div><p>${highlight(snippet(e.body,terms),terms)}</p></a>`).join("") : `<div class="empty"><strong>没有匹配的结果</strong>试试减少关键词，或把支柱、类型与范围恢复为“全部”。</div>`;
  $("#resultPages").innerHTML=results.length>size ? `<button type="button" class="btn" data-results-page="${searchState.page-1}" ${searchState.page===1 ? "disabled" : ""}>上一页</button><span>第 ${searchState.page} / ${totalPages} 页</span><button type="button" class="btn" data-results-page="${searchState.page+1}" ${searchState.page===totalPages ? "disabled" : ""}>下一页</button>` : "";
  $("#resultPages").querySelectorAll("button").forEach(b=>b.addEventListener("click",()=>{searchState.page=Number(b.dataset.resultsPage);renderResults();$("#resultCount").scrollIntoView({block:"start"});}));
}
function bindSearch() {
  const form=$("#searchForm"),input=$("#searchInput");
  const sync=()=>{searchState.page=1;history.replaceState(null,"",`#/search?q=${encodeURIComponent(searchState.q)}&kind=${searchState.kind}&pillar=${searchState.pillar}&type=${searchState.type}`);renderResults();};
  form.addEventListener("submit",e=>{e.preventDefault();searchState.q=input.value.trim();sync();});
  let timer;input.addEventListener("input",()=>{clearTimeout(timer);timer=setTimeout(()=>{if(input.isConnected){searchState.q=input.value.trim();sync();}},180);});
  for(const [sel,key] of [["#kindFilter","kind"],["#pillarFilterS","pillar"],["#typeFilterS","type"]]) $(sel).querySelectorAll("button").forEach(b=>b.addEventListener("click",()=>{searchState[key]=b.dataset.v;$(sel).querySelectorAll("button").forEach(c=>c.setAttribute("aria-pressed",String(c===b)));sync();}));
  document.querySelectorAll("[data-q]").forEach(b=>b.addEventListener("click",()=>{searchState.q=b.dataset.q;input.value=searchState.q;sync();}));
  renderResults();
}

const NAV=[...CORE_MODULES.map(m=>({id:m.id,label:m.title,route:`#/${m.id}`,desc:""})),{id:"issues",label:"关键议题",route:"#/issues",desc:""},{id:"workbench",label:"智能评估工作台",route:"#/workbench",desc:""}];
function navIcon(id) {
  const paths = {
    symbols: '<path d="M5 6h14M5 12h14M5 18h9"/>',
    methodology: '<path d="m12 3 9 5-9 5-9-5 9-5ZM3 13l9 5 9-5M3 18l9 5 9-5"/>',
    process: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8m2 2h8"/>',
    history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    issues: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    workbench: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m8 9 2 2 4-4M8 15h8"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[id] || paths.symbols}</svg>`;
}
function renderNav(active) {
  const modules=NAV.filter(n=>n.id!=="workbench"),tools=[NAV.find(n=>n.id==="workbench")];
  $("#mainNav").innerHTML=`<span class="nav-label">知识模块</span>${modules.map(n=>`<a href="${n.route}" data-nav="${n.id}" ${n.id===active ? 'class="active" aria-current="page"' : ""}><span class="nav-ico" aria-hidden="true">${navIcon(n.id)}</span><span>${esc(n.label)}</span>${n.desc ? `<span class="nav-count">${esc(n.desc)}</span>` : ""}</a>`).join("")}<span class="nav-label utility-label">评估与查询</span>${tools.map(n=>`<a href="${n.route}" data-nav="${n.id}" ${n.id===active ? 'class="active" aria-current="page"' : ""}><span class="nav-ico" aria-hidden="true">${navIcon(n.id)}</span><span>${esc(n.label)}</span>${n.desc ? `<span class="nav-count">${esc(n.desc)}</span>` : ""}</a>`).join("")}<a href="#/search" data-nav="search" ${active==="search" ? 'class="active" aria-current="page"' : ""}><span class="nav-ico" aria-hidden="true">${navIcon("search")}</span><span>知识查询</span></a>`;
}
function parseHash() {
  const [path,query]=location.hash.replace(/^#\/?/,"").split("?"),segments=path.split("/").filter(Boolean);
  return {view:segments[0] || "issues",arg:segments[1] || "",params:new URLSearchParams(query || "")};
}
function render() {
  const {view,arg,params}=parseHash();
  let active=view,html="";
  if(CORE_MODULES.some(m=>m.id===view))html=viewCore(view);
  else if(view==="source"){html=viewSource(arg,params);active=CORE_MODULES.some(m=>m.id===arg) ? arg : "issues";}
  else if(view==="search"){
    searchState.q=params.get("q") || "";Object.assign(searchState,normalizeSearchFilters({kind:params.get("kind"),pillar:params.get("pillar"),type:params.get("type")}));searchState.page=1;html=viewSearch();
  }else if(view==="workbench"){
    html=workbenchView();
  }else if(view==="issues" || !location.hash){
    if(arg)html=viewIssueDetail(arg,params);
    else{issueState.pillar=PILLARS.some(p=>p.id===params.get("pillar")) ? params.get("pillar") : "all";html=viewIssues();}
  }else {active="issues";html=`<div class="empty"><strong>此模块已调整</strong><p>旧模块已由术语与符号、评级方法、评级流程和模型更新历史替换。</p><a href="#/issues">返回关键议题</a></div>`;}
  $("#view").innerHTML=html;renderNav(active);
  if(view==="workbench")mountWorkbench($("#view"));
  if(view==="issues" && !arg || !location.hash){bindExportPanel();renderIssueGrid();}
  if(view==="issues" && arg)bindExportPanel();
  if(view==="search")bindSearch();
  const sourceForm=$("#sourcePageForm");if(sourceForm)sourceForm.addEventListener("submit",e=>{e.preventDefault();location.hash=`#/source/${sourceForm.dataset.source}?page=${$("#sourcePageInput").value}`;});
  closeNav();window.scrollTo({top:0,behavior:"auto"});
  const target=params.get("section") ? $("#section-"+CSS.escape(params.get("section"))) : params.get("item") ? $("#item-"+CSS.escape(params.get("item"))) : null;
  if(target){target.classList.add("is-target");requestAnimationFrame(()=>target.scrollIntoView({block:"start",behavior:"auto"}));}
  document.title=`${view==="source" ? "来源原文" : NAV.find(n=>n.id===active)?.label || "知识查询"} · MSCI ESG 评级知识库`;
}
function openNav(){ $("#sidebar").inert=false;$("#sidebar").classList.add("open");$("#view").inert=window.innerWidth<1024;$("#scrim").hidden=false;$("#navToggle").setAttribute("aria-expanded","true");$("#navToggle").setAttribute("aria-label","关闭导航"); }
function closeNav(){ $("#sidebar").classList.remove("open");$("#sidebar").inert=window.innerWidth<1024;$("#view").inert=false;$("#scrim").hidden=true;$("#navToggle").setAttribute("aria-expanded","false");$("#navToggle").setAttribute("aria-label","打开导航"); }
function bindChrome() {
  $("#navToggle").addEventListener("click",()=>$("#sidebar").classList.contains("open") ? closeNav() : openNav());
  $("#scrim").addEventListener("click",closeNav);
  $("#mainNav").addEventListener("click",e=>{if(e.target.closest("a"))closeNav();});
  $("#topbarSearch").addEventListener("submit",e=>{e.preventDefault();location.hash=`#/search?q=${encodeURIComponent($("#globalSearchInput").value.trim())}`;});
  document.addEventListener("click",e=>{const b=e.target.closest("[data-open-pdf]");if(b){const url=pdfUrl(b.dataset.openPdf,Number(b.dataset.page)||1);window.open(url,"_blank","noopener");}});
  document.addEventListener("keydown",e=>{if(e.key==="Escape" && $("#sidebar").classList.contains("open")){closeNav();$("#navToggle").focus();}if(e.key==="/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)){e.preventDefault();const input=$("#globalSearchInput");if(input.offsetParent!==null)input.focus();else location.hash="#/search";}});
  window.addEventListener("resize",()=>{if(window.innerWidth>=1024)closeNav();else if(!$("#sidebar").classList.contains("open"))$("#sidebar").inert=true;});
  window.addEventListener("hashchange",render);
}
bindChrome();render();
