import { esc, normalize, dimNames, qName, sourceLink } from '../core.js';
import { head, options, industryOptions, empty, pageControls } from '../ui.js';
import {
  primaryQuestion,
  renderPrimaryQuestion,
  assertQuestionTemplate,
} from '../question-reader.js';
import { structuredMethodHtml } from '../question-layout.js';
import { buildQuestionSheets } from '../question-export.js';
import { isLibraryQuestion, questionEvidence } from '../question-policy.js';
import { buildXlsx, downloadXlsx } from '../xlsx.js';

function questionAid(translations, field, value) {
  return translations?.translations?.[field]?.[value] || '';
}
function detailBlock(title, zh, open = false) {
  if (!zh) return '';
  return `<details class="q-block" ${open ? 'open' : ''}><summary>${esc(title)}</summary>${structuredMethodHtml(zh)}</details>`;
}
function questionChineseName(x, translations) {
  return qName(x) !== x.title ? qName(x) : questionAid(translations, 'title', x.title) || x.title;
}
export async function renderQuestions(params, data, getData) {
  const code = params.get('industry') || 'CON',
    ind = data.industries.find((x) => x.code === code) || data.industries[0];
  const [qs, translations, primary, shared] = await Promise.all([
    getData('questions-' + ind.code),
    getData('question-translations'),
    getData('question-primary'),
    getData('question-templates'),
  ]);
  const q = normalize(params.get('q') || ''),
    dim = params.get('dim') || '',
    crit = params.get('criterion') || '',
    dis = params.get('disclosure') || '';
  const visible = qs.filter((x) => isLibraryQuestion(x, primary));
  const evidenceOptions = [...new Map(visible.map((x) => {
    const evidence = questionEvidence(x);
    return [evidence.key, evidence.label];
  })).entries()];
  const filtered = visible.filter((x) => {
    const main = primaryQuestion(x, shared.templates[shared.mapping[x.id]], primary);
    return (
      (!dim || x.dimension === dim) &&
      (!crit || x.criterion === crit) &&
      (!dis || questionEvidence(x).key === dis) &&
      (!q ||
        normalize(
          [
            questionChineseName(x, translations),
            x.title,
            x.criterionZh,
            x.criterion,
            main?.zh,
            main?.en,
          ].join(' '),
        ).includes(q))
    );
  });
  const page = Math.min(
    Math.max(0, Number(params.get('page')) || 0),
    Math.max(0, Math.ceil(filtered.length / 30) - 1),
  );
  const clearFilter = new URLSearchParams(params);
  clearFilter.delete('q');
  clearFilter.delete('page');
  return (
    head('问题与证据要求', '查看各行业的一级主问题。') +
    `<div class="toolbar question-filters"><label>行业<select data-param="industry">${industryOptions(data.industries, ind.code)}</select></label><label>维度<select data-param="dim">${options(
      [...new Set(visible.map((x) => x.dimension))].map((x) => [x, dimNames[x]]),
      dim,
      '全部维度',
    )}</select></label><label>标准<select data-param="criterion">${options(
      [...new Set(visible.filter((x) => !dim || x.dimension === dim).map((x) => x.criterion))].map(
        (x) => [x, visible.find((y) => y.criterion === x).criterionZh],
      ),
      crit,
      '全部标准',
    )}</select></label><label>资料要求<select data-param="disclosure">${options(evidenceOptions, dis, '全部要求')}</select></label></div>
 ${q ? `<p class="small filter-note">已按“${esc(params.get('q') || '')}”筛选问题。<a href="#/questions?${clearFilter}">清除筛选</a></p>` : ''}
 <div class="question-library-tools"><button class="btn" data-action="export-questions">导出 Excel</button></div>
 <div class="q-list">${
   filtered
     .slice(page * 30, (page + 1) * 30)
     .map((x) => {
       const template = shared.templates[shared.mapping[x.id]];
       const evidence = questionEvidence(x);
       assertQuestionTemplate(x, template);
       return `<details id="${esc(x.id)}" ${params.get('id') === x.id ? 'open' : ''}><summary><svg class="q-expand" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 8h10"/><path class="q-plus" d="M8 3v10"/></svg><span class="q-title"><strong>${esc(questionChineseName(x, translations))}</strong><span class="secondary">${esc(x.title)} · ${esc(x.criterionZh)} · ${esc(dimNames[x.dimension])}</span></span><span class="badge" title="${esc(evidence.summary)}">${esc(evidence.label)}</span></summary><div class="q-detail">
  ${renderPrimaryQuestion(x, template, primary)}
  <div class="q-meta small">${esc(evidence.label)}${evidence.fromGuidance ? ` · ${esc(evidence.summary)}` : ''} · 标准占总分 ${x.weight}% · ${x.page}–${x.endPage} 页</div>
  ${detailBlock('问题布局', questionAid(translations, 'layout', x.layout), true)}
  ${detailBlock('证据要求', questionAid(translations, 'guidance', x.guidance), true)}
  ${detailBlock('评分依据', questionAid(translations, 'rationale', x.rationale))}
  <p class="source-meta">${sourceLink(x.sourceFile, x.page, '查看官方 PDF')}</p>
  </div></details>`;
     })
     .join('') || empty('没有匹配问题，请调整行业或筛选条件。')
 }</div>${pageControls(page, filtered.length)}`
  );
}
export async function exportQuestions(button, data, getData, industryCode = '') {
  const industry = data.industries.find((item) => item.code === industryCode) || data.industries[0];
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = '正在整理问题库…';
  try {
    const [questions, translations, primary, methodSchema] = await Promise.all([
      getData('questions-' + industry.code),
      getData('question-translations'),
      getData('question-primary'),
      getData('assessment-method-schema'),
    ]);
    button.textContent = '正在生成 Excel…';
    await downloadXlsx(
      `CSA-2026-${industry.code}-Full-评级方法与AI依据.xlsx`,
      buildXlsx(buildQuestionSheets(industry, questions, translations, primary, methodSchema)),
    );
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
}
