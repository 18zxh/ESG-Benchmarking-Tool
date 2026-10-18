import { esc, normalize } from './core.js';

const categories = [
  ['core-methodology', '核心方法'],
  ['industry-handbook', '行业 Handbook'],
  ['updates-msa', '年度更新与 MSA'],
  ['index-components', '指数名单'],
  ['sample-reports', '样例报告'],
  ['translation', '双语辅助'],
  ['questionnaire', '门户问卷'],
];
const fallbackCategory = (s) =>
  ({
    original: 'core-methodology',
    'industry-handbook': 'industry-handbook',
    'index-components': 'index-components',
    'sample-questionnaire': 'questionnaire',
    'handbook-index': 'questionnaire',
    translation: 'translation',
  })[s.role] || 'sample-reports';
const coreOrder = [
  'SP_Global_ESG_Scores_Methodology',
  'CSA_Weights_2026',
  'CSA_Measuring_Sustainability_Performance_2026',
  'CSA_Annual_Scoring_Methodology_2025',
];
const safeLink = (url, label) =>
  /^https:\/\//.test(url || '')
    ? `<a target="_blank" rel="noopener" href="${esc(url)}">${esc(label)}</a>`
    : '';

export class Resources {
  constructor(main, data) {
    Object.assign(this, { main, data });
  }
  metadata(source) {
    const records =
      this.data.catalog?.records || this.data.catalog?.documents || this.data.catalog || [];
    return Array.isArray(records)
      ? records.find((m) => (source.file ? m.file === source.file : m.id === source.id)) || {}
      : {};
  }
  category(source) {
    let value = this.metadata(source).category || fallbackCategory(source);
    return value.includes('questionnaire') || value.includes('handbook-index')
      ? 'questionnaire'
      : value;
  }
  render(params) {
    const query = normalize(params.get('q') || '');
    const category = params.get('category') || '';
    const rows = this.data.sources.filter(
      (s) =>
        (!category || this.category(s) === category) &&
        (!query ||
          normalize(
            [
              s.title,
              s.file,
              s.industry,
              this.metadata(s).versionLabel,
              this.metadata(s).category,
            ].join(' '),
          ).includes(query)),
    );
    const groups = categories.filter(([key]) => rows.some((s) => this.category(s) === key));
    return `<header class="page-head"><h1>资料与版本</h1></header>
      <div class="toolbar"><form data-filter-search class="search-field"><label>搜索资料<input name="q" type="search" value="${esc(params.get('q') || '')}" placeholder="文件名称、行业代码或版本"></label></form><label>分类<select data-param="category"><option value="">全部分类</option>${categories.map(([key, label]) => `<option value="${key}" ${category === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>
      ${
        groups
          .map(
            ([
              key,
              label,
            ]) => `<section class="resource-category"><h2>${label}<span class="resource-count">${rows.filter((s) => this.category(s) === key).length} 份</span></h2>${
              key === 'industry-handbook'
                ? '<p class="small">62 个行业各自一份补充说明手册。本站按 2026 Full 方法整理；企业实际问题范围与编辑权限，以其门户问卷为准。</p>'
                : ''
            }
      <p class="table-scroll-hint small">表格可左右滑动，查看版本和文件操作。</p><div class="table-wrap resource-table-wrap" tabindex="0" aria-label="分类资料表，可左右滑动"><table class="data resource-table"><thead><tr><th scope="col">文件与用途</th><th scope="col">文件版本</th></tr></thead><tbody>${rows
        .filter((s) => this.category(s) === key)
        .sort((a, b) =>
          key === 'core-methodology' ? coreOrder.indexOf(a.id) - coreOrder.indexOf(b.id) : 0,
        )
        .map((s) => this.sourceRow(s))
        .join('')}</tbody></table></div></section>`,
          )
          .join('') || '<p class="state-empty">没有找到匹配资料，请放宽分类或搜索词。</p>'
      }`;
  }
  sourceRow(source) {
    const m = this.metadata(source),
      i = this.data.industries.find((i) => i.code === source.industry);
    const version = m.versionDate ? m.versionLabel || m.versionDate : '版次日期未注明';
    return `<tr><th scope="row">${esc(source.title)}${i ? `<span class="secondary">${esc(i.zh)} · ${esc(i.name)}</span>` : ''}<div class="resource-actions">${safeLink(source.url || m.sourceUrl, '官方原链接')}${source.file ? `<a href="sources/${encodeURIComponent(source.file)}" target="_blank" rel="noopener">阅读 PDF</a><a href="sources/${encodeURIComponent(source.file)}" download="${esc(source.file)}">下载</a>` : ''}</div></th>
    <td>${esc(version)}</td></tr>`;
  }
}
