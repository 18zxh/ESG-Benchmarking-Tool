import { esc, dimNames, sourceLink } from '../core.js';
import { head, industryOptions, table, selectedIndustry } from '../ui.js';
import { buildXlsx, downloadXlsx } from '../xlsx.js';

function weightsBar(ind) {
  return `<div class="weight-bar" aria-hidden="true">${ind.dimensions.map((d) => `<span style="width:${d.weight}%"></span>`).join('')}</div><div class="weight-legend">${ind.dimensions.map((d) => `<span>${esc(dimNames[d.name])} <b>${d.weight}%</b></span>`).join('')}</div>`;
}
export function renderWeights(params, data) {
  const code = params.get('industry') || 'CON',
    other = params.get('compare') || '';
  const ind = data.industries.find((x) => x.code === code) || data.industries[0],
    compare = data.industries.find((x) => x.code === other);
  const rows = ind.criteria.map((c) => {
    const d = ind.dimensions.find((d) => d.name === c.dimension);
    const alt = compare?.criteria.find((x) => x.name === c.name);
    return `<tr><td>${esc(c.zh)}<span class="secondary">${esc(c.name)}</span></td><td>${esc(dimNames[c.dimension])}</td><td class="num">${c.weight}%</td><td class="num">${((c.weight / d.weight) * 100).toFixed(2)}%</td><td class="num">${esc(c.change === 'New' ? '新增' : Number(c.change) > 0 ? '+' + c.change : c.change)}</td>${compare ? `<td class="num">${alt ? alt.weight + '%' : '无此标准'}</td>` : ''}</tr>`;
  });
  return (
    head('行业评分权重', '2026 Full CSA。') +
    `<div class="toolbar"><label>选择行业<select data-param="industry">${industryOptions(data.industries, ind.code)}</select></label><label>比较另一行业<select data-param="compare">${industryOptions(data.industries, other, '不比较')}</select></label><button class="btn" data-action="export-weights">导出权重 Excel</button></div><h2>${esc(ind.code)} · ${esc(ind.zh)}</h2><p class="secondary">${esc(ind.name)}</p>${weightsBar(ind)}${compare ? `<h3>对比：${esc(compare.code)} · ${esc(compare.zh)}</h3>${weightsBar(compare)}` : ''}
 ${table(['标准', '维度', '占总分比例', '占所属维度比例¹', '较 2025 变化（百分点）', ...(compare ? [esc(compare.code) + ' 占总分'] : [])], rows, 'weights-table')}<p class="small">¹ 占所属维度比例为本站计算值，保留两位小数，汇总可能有舍入差异。0% 是原表数值；“无此标准”不是 0%。比较行业中仅有的标准见下表。</p>${
   compare
     ? table(
         [esc(compare.code) + ' 独有标准', '占总分比例'],
         compare.criteria
           .filter((c) => !ind.criteria.some((x) => x.name === c.name))
           .map((c) => `<tr><td>${esc(c.zh)}</td><td>${c.weight}%</td></tr>`),
       )
     : ''
 }<p class="source-meta">${sourceLink(ind.sourceFile, ind.sourcePage, '2026 Full CSA')}${compare ? ' · ' + sourceLink(compare.sourceFile, compare.sourcePage, '2026 Full CSA') : ''} · 方法年度 2026 · 62 行业维度合计与标准汇总均已核对为 100%</p>`
  );
}
export async function exportWeights(params, data) {
  const industry = selectedIndustry(data.industries, params.get('industry') || 'CON');
  const rows = [
    [
      '行业代码',
      '行业名称',
      '方法年度',
      '问卷版本',
      '维度',
      '标准',
      '占总分%',
      '较2025变化百分点',
      '来源PDF',
      'PDF页码',
    ],
    ...industry.criteria.map((c) => [
      industry.code,
      industry.zh,
      2026,
      'Full',
      c.dimension,
      c.name,
      c.weight,
      c.change,
      industry.sourceFile,
      industry.sourcePage,
    ]),
  ];
  await downloadXlsx(
    'CSA-2026-Full-' + industry.code + '-权重.xlsx',
    buildXlsx([{ name: '行业权重', rows, freezeRows: 1, autoFilter: true, wrap: true }]),
  );
}
