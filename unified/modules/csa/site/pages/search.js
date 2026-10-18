import { esc, normalize, qName } from '../core.js';
import { isLibraryQuestion } from '../question-policy.js';
import { head, empty } from '../ui.js';
import { qsHref } from '../router.js';

function companySearchText(company, aliases = []) {
  return normalize(
    [
      company.name,
      ...aliases.filter((a) => a.companyId === company.id).flatMap((a) => a.aliases),
    ].join(' '),
  );
}
export async function renderSearch(params, data, getData) {
  const q = params.get('q') || '',
    t = normalize(q);
  if (!t)
    return (
      head('搜索资料', '搜索行业、企业、问题与资料标题。') +
      '<form data-filter-search><label>搜索词<input name="q" type="search" placeholder="输入关键词"></label><button class="btn primary">搜索</button></form>'
    );
  const [qi, primary] = await Promise.all([
    getData('question-index'), getData('question-primary'),
  ]);
  let results = [];
  for (const i of data.industries)
    if (normalize(i.code + ' ' + i.zh + ' ' + i.name).includes(t))
      results.push({
        title: i.code + ' · ' + i.zh,
        info: '行业评分权重 · 2026 Full',
        url: qsHref('weights', { industry: i.code }),
      });
  for (const c of data.companies)
    if (companySearchText(c, data.aliases).includes(t))
      results.push({
        title: c.name,
        info: `企业行业 · ${c.industry} · 名单来源 2026-05-01`,
        url: qsHref('weights', { industry: c.industry }),
      });
  for (const s of data.sources)
    if (normalize(s.title + ' ' + (s.file || '')).includes(t))
      results.push({
        title: s.title,
        info: '资料来源 · ' + s.status,
        url: qsHref('resources', { q: s.title }),
      });
  const matched = qi.filter((x) => isLibraryQuestion(x, primary) &&
    normalize([qName(x), x.title, x.criterionZh, x.industry].join(' ')).includes(t),
  );
  const dedup = new Set();
  for (const x of matched) {
    const key = x.title + '|' + x.criterion;
    if (dedup.has(key)) continue;
    dedup.add(key);
    results.push({
      title: qName(x),
      info: `一级主问题 · 首个匹配行业 ${x.industry}`,
      url: qsHref('questions', { industry: x.industry, q: x.title, id: x.id }),
    });
  }
  if (/djsi|djbic|道琼斯|best.in.class|指数/.test(t))
    results.unshift({
      title: 'Dow Jones Best-in-Class 指数（原 DJSI）',
      info: '来源 PDF · 2026-05-01 日期快照',
      url: '#/resources?category=index-components',
    });
  if (/模型|model|score|评分|方法|csa|esg/.test(t))
    results.unshift({
      title: 'CSA Score、ESG Score 与模型补值',
      info: '方法文件导读 · 英文 PDF 依据',
      url: '#/methods',
    });
  return (
    head(
      '资料搜索',
      `“${esc(q)}” · ${results.length} 个匹配结果。相同问题标题合并展示，请在问题库确认企业实际行业。`,
    ) +
    `<form class="toolbar" data-filter-search><label class="search-field">搜索词<input name="q" type="search" value="${esc(q)}"></label><button class="btn">搜索</button></form><div class="search-results">${
      results
        .slice(0, 100)
        .map(
          (r) =>
            `<article><h3><a href="${esc(r.url)}">${esc(r.title)}</a></h3><p>${esc(r.info)}</p></article>`,
        )
        .join('') || empty('没有匹配结果，请尝试企业英文全称、行业名称或其他关键词。')
    }</div>${results.length > 100 ? '<p class="small">先展示前 100 个结果，请细化搜索。</p>' : ''}`
  );
}
