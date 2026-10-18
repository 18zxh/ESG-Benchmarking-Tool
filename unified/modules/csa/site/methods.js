import { esc } from './core.js';

const guideRows = [
  {
    topic: '核心方法',
    files: [
      {
        file: 'CSA_Measuring_Sustainability_Performance_2026.pdf',
        name: '可持续绩效衡量',
        english: 'Measuring Sustainability Performance',
        summary:
          'CSA 问卷的总览文件，回答“CSA 到底考什么、怎么打分”。说明问卷如何按三个维度（治理与经济、环境、社会）及其下的标准组织，企业如何按行业选择模块作答；问题答案如何按 0–100 计分，标准权重与维度权重如何逐级汇总为 CSA Score。前半部分介绍 Materiality（重要性）评估：企业结合行业重要性地图与自身影响，决定各标准的披露深度。后半部分说明 Media and Stakeholder Analysis（MSA）如何进入评分，以及问卷每年的更新机制。第一次接触 CSA 方法体系，先读这一份。本站另有中文双语辅助版本，可在“资料与版本”查阅；方法判断以英文母本为准。',
      },
    ],
  },
  {
    topic: '先读评分总览，再查 ESG score 方法',
    files: [
      {
        file: 'SP_Global_ESG_Scores_Methodology.pdf',
        name: 'S&P Global ESG Score 评分方法',
        english: 'S&P Global ESG Scores Methodology',
        summary:
          'S&P Global ESG Scores 的完整方法文件。先区分两个概念：CSA Score 来自企业问卷答案，ESG Score 是在问卷得分基础上经行业校准、缺失数据估算和汇总后的最终分数。文件给出评分结构（总分、标准分、行业平均分）、未答题时的模型估算（estimation）规则与数据覆盖门槛、各维度权重的聚合方式，以及分数的持续监测与年度复核流程。最后一章专门列出方法局限，例如估算数据带来的不确定性。当你要回答“为什么问卷得分和 ESG Score 不一样”“没答的题是怎么补出来的”“这个分数有多可靠”时，以这份文件为依据。本站另有中文双语辅助版本，可在“资料与版本”查阅。',
      },
    ],
  },
  {
    topic: '行业权重另列',
    files: [
      {
        file: 'CSA_Weights_2026.pdf',
        name: '行业评分权重',
        english: 'CSA Criteria Weights 2026',
        summary:
          '2026 Full CSA 各行业评分权重表。按 62 个行业逐一列出治理与经济、环境、社会三个维度及其下各标准占总分的百分比，并给出相对 2025 年的变化百分点，标注新增或取消的标准。同一 CSA 行业内所有企业使用同一套权重；企业实际需要回答哪些问题，仍以其线上门户问卷为准。要查“我所在行业哪一块权重最高”“今年权重动了什么”，直接按行业代码翻这份表；在“行业评分权重”页面选行业即可查看同样的数据并导出。',
      },
    ],
  },
  {
    topic: '行业问题说明与门户',
    files: [
      {
        file: 'CSA_Methodology_Handbook_CON.pdf',
        name: '行业 Methodology Handbook',
        english: '2026 CSA Methodology Handbook · industry-specific',
        summary:
          '行业补充说明手册，62 个行业各一份，本站以建筑与工程（CON）为入口。逐条给出本行业问卷问题的问题布局（Question Layout）与资料／证据要求（Evidence Guidance），说明每个维度、标准下问题的适用范围、计分口径，以及需要准备的公开证明材料。本站“问题与证据要求”页面已按行业提取中英文条目与原文页码，可直接检索阅读，无需逐页翻 PDF。需要注意：手册描述的是通用问题说明，企业实际可见的题目、适用性与编辑范围，以其线上门户问卷为准。',
      },
      {
        file: 'CSA_Online_Portal_Guide_2026.pdf',
        name: '企业门户操作指南',
        english: 'CSA Online Portal Guide',
        summary:
          '企业 CSA 门户的操作手册，2026 年 3 月更新。说明如何用企业授权账户登录门户，进入 Frameworks → CSA → Response → Questionnaires 并选对企业和年度；如何查看问卷内容，在 Export 中选择“Export your questionnaire in PDF”、填写接收邮箱，导出包含已填答案、企业评论、理由与定义的完整问卷 PDF。文件还记录了页面结构和常见问题。当需要把企业线上问卷导出出来、逐题核对适用性与证据要求时，按这份指南操作；门户界面如有更新，以当前页面为准。',
      },
    ],
  },
  {
    topic: '年度更新与 MSA',
    files: [
      {
        file: 'CSA_2026_Methodology_Updates_Overview.pdf',
        name: '年度方法更新',
        english: 'CSA 2026 Methodology Updates Overview',
        summary:
          '2026 年度方法更新说明，集中回答“今年方法改了什么”。逐项列出本周期相对上一年的变化：问题的合并、删除与新增，证据公开要求（Public documentation）的调整，以及人工智能、供应链、气候、包装等主题的口径变化，并标注受影响的行业范围。做新一年评估或对比往年结论之前，先用这份文件确认变化点；具体问题口径和权重仍以对应行业 Handbook 与权重表为准。历史规则背景可参考 2025 年度评分方法文件。',
      },
      {
        file: 'MSA_Methodology_Guidebook.pdf',
        name: 'MSA 方法指南',
        english: 'Media and Stakeholder Analysis Methodology Guidebook',
        summary:
          'Media and Stakeholder Analysis（MSA）持续争议分析的正式方法指南，2026 年 6 月版。说明标普如何持续监测媒体与利益相关方信息、筛选符合条件的争议事件，并按重要性、影响、责任归属与企业回应四个角度开展案例评估，最终决定是否下调相关标准得分乃至总分。2026 年 3 月 16 日起，争议筛查改用标普自有筛查模型，此前由 RepRisk 支持。官方并不公开按新闻条数的机械扣分公式，本站也不会自行推算 MSA 扣分；评估时只记录争议事实与来源，评分影响留给人工判断。',
      },
      {
        file: 'MSA_Upcoming_Changes.pdf',
        name: 'MSA 变更预告（历史）',
        english: 'MSA Upcoming Changes',
        summary:
          '2025 年 12 月发布的 MSA 变更预告，属历史文件。内容是提前告知争议筛查服务与流程即将调整的背景和计划安排，用于追溯“为什么 MSA 流程变了”。文件中的实施时间只是预告安排，不构成已确认的生效日期；当前适用规则一律以 2026 年 6 月版 MSA 方法指南为准。除非需要核对变更沿革，日常方法判断不必阅读本文件。',
      },
      {
        file: 'CSA_Annual_Scoring_Methodology_2025.pdf',
        name: '年度评分方法（历史）',
        english: 'CSA Annual Scoring & Methodology Review 2025',
        summary:
          '2025 年度评分与方法回顾，属历史文件。记录 2025 周期内评分方法的执行情况、评分分布与方法调整背景，帮助理解方法的演变脉络，例如某项规则是在什么考虑下形成的。它不能覆盖 2026 年已经明确的新要求：凡涉及 2026 评估，问题口径、证据公开要求和行业权重均以 2026 各文件为准。仅在需要追溯“去年怎么算、为什么这么改”时查阅。',
      },
    ],
  },
  {
    topic: '报告样例',
    files: [
      {
        file: 'Sample_Company_Benchmarking_Report_2026.pdf',
        name: '企业对标报告样例',
        english: 'Company Benchmarking Report · Sample',
        summary:
          '企业对标报告（Company Benchmarking Report）的官方样例，2026 年 7 月版。展示完整报告结构：企业总分与同业（peer）分布的对比图、各维度与标准的得分差距（gap analysis）、权重信息，以及改进建议的呈现方式。样例公司是虚构的 Sample Company，基准数据截至 2026-07-13，全部数字仅为演示，不构成任何真实企业的评级结论。拿到对标报告后该看哪些部分、差距怎么读，用这份样例对照。',
      },
      {
        file: 'Sample_CSA_Performance_Outline_Report_2025.pdf',
        name: 'CSA 表现概要样例',
        english: 'CSA Performance Outline Report · Sample',
        summary:
          'CSA 表现概要报告（Performance Outline Report）的官方样例，2025 年 6 月版。按维度—标准层级给出单企业的表现概要，展示各标准的得分概览、说明文字与注释的排布方式，相比对标报告更侧重企业自身的梳理而非同业比较。样例公司为虚构公司，数据截至 2025-06-16。用于了解概要类报告的结构与阅读顺序，不作为真实评级数据使用。',
      },
      {
        file: 'Sample_Benchmarking_Report_on_Materiality.pdf',
        name: '重要性对标报告样例',
        english: 'Benchmarking Report on Materiality · Sample',
        summary:
          '重要性对标报告（Benchmarking Report on Materiality）的官方样例。围绕 Materiality（重要性）主题展示对标写法：行业层面的重要性标准与企业实际表现的逐项对照、企业相对同业所处位置与差距说明。样例封面仍保留“Company XYZ, Month YYYY”占位，基准年份为 2024（含 2021–2024 区间），数据截至 2025-01-05，这些均为样例数字。用于理解重要性维度的报告呈现方式，不纳入真实企业评级。',
      },
    ],
  },
];

export function renderMethods(data) {
  const metadata = new Map(data.catalog.records.filter((s) => s.file).map((s) => [s.file, s]));
  const fileHtml = (f) => {
    const m = metadata.get(f.file);
    return `<article class="guide-file"><div class="method-module-heading"><h3>${esc(f.name)}</h3><span class="badge">${esc(m?.versionLabel || '日期未注明')}</span></div><p class="secondary" lang="en">${esc(f.english)}</p><p class="guide-summary">${esc(f.summary)}</p><div class="actions"><a class="btn small-btn" target="_blank" rel="noopener" href="sources/${encodeURIComponent(f.file)}">查看详情</a></div></article>`;
  };
  return `<p class="table-scroll-hint small">表格可左右滑动，查看右侧方法文件。</p><div class="table-wrap" tabindex="0" aria-label="方法文件导读表，可左右滑动"><table class="data method-guide-table"><thead><tr><th scope="col">核心方法</th><th scope="col">方法文件</th></tr></thead><tbody>${guideRows
    .map(
      (row) =>
        `<tr><th scope="row">${esc(row.topic)}</th><td>${row.files.map(fileHtml).join('')}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}
