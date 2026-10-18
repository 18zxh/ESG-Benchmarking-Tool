import { sourceLink } from '../core.js';
import { head } from '../ui.js';

export function renderHome() {
  return (
    head('把 CSA 方法用到披露工作中', '从报告范围到原文核对，按同一套问题依据完成披露初评。') +
    `<div class="overview-workflow"><section class="overview-step"><span class="overview-number">01</span><h2>上传范围</h2><p>确认企业、官方行业与报告期间，按 2026 Full 方法准备披露。ESG 报告、年报和佐证资料分别记录覆盖期间；实际适用性以门户问卷为准。</p><p class="source-meta">${sourceLink('CSA_Methodology_Handbook_CON.pdf', 5, '问卷适用范围')}</p></section><section class="overview-step"><span class="overview-number">02</span><h2>披露初评</h2><p>按问题库的原文要求查找报告片段，保留文件、页码和待核实事项。可连接自己的 AI 模型辅助分析。</p><p class="source-meta">${sourceLink('SP_Global_ESG_Scores_Methodology.pdf', 10, '披露评分方法')}</p></section><section class="overview-step"><span class="overview-number">03</span><h2>人工复核</h2><p>对照问题要求与原 PDF，确认已披露信息，保存复核意见并导出 Excel。</p><p class="source-meta">${sourceLink('SP_Global_ESG_Scores_Methodology.pdf', 8, '质量核对说明')}</p></section></div>
 <div class="overview-next"><a class="btn primary" href="#/workbench">进入报告评估工作台</a><a href="#/questions">先查看问题要求</a></div><p class="overview-boundary small">本站初评用于整理披露与证据，不代表标普官方分数。完整企业门户问卷和问题级评分矩阵尚未取得，实际适用性以企业门户问卷为准。</p>`
  );
}
