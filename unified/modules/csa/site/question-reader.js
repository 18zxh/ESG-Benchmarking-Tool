import { esc } from './core.js';
import { parseLayout } from './question-layout.js';

export const sourceTextOf = (value, language = 'zh') =>
  typeof value === 'string' ? value : value?.[language] || '';
export const templateSourceFields = [
  'title',
  'layout',
  'rationale',
  'guidance',
  'disclosure',
  'year',
  'version',
];
export function assertQuestionTemplate(question, template) {
  if (
    !template ||
    templateSourceFields.some((field) => template.source?.[field] !== question[field])
  ) {
    throw new Error('本题共用来源不一致，请核对资料版本。');
  }
}
export const blockKinds = {
  prompt: '主问题',
  paragraph: '说明',
  heading: '小节',
  radio: '原文分支',
  'source-radio': '原文分支',
  check: '原文复选项（未选择）',
  'source-check': '原文复选项（未选择）',
  select: '选项',
  'source-menu': '菜单信息',
  field: '填报项',
  table: '原文表格',
  bullet: '原文条目',
};

export function questionBlocks(question, template, structures) {
  assertQuestionTemplate(question, template);
  const curated = structures.find((entry) => entry.sourceText === question.layout);
  return {
    blocks: curated?.blocks || parseLayout(template?.zh.layout || '', 'zh'),
    method: curated?.reviewMethod || (question.layout ? 'source-segmented' : 'not-extracted'),
    curated,
  };
}

// This view uses a reviewed primary sentence, not the full questionnaire layout.
export function primaryQuestion(question, template, library) {
  assertQuestionTemplate(question, template);
  const override = library.overrides[question.id];
  if (override?.status === 'exclude' || override?.status === 'missing') return null;
  const id = override?.entry || library.mapping[template.id];
  if (!id && !question.layout) return null;
  const entry = library.entries[id];
  const field = override?.sourceField || 'layout';
  const source = String(field === 'pdf' ? override.sourceText : question[field] || '')
    .replace(/\s+/g, ' ')
    .trim();
  const matches = field === 'layout' ? source.startsWith(entry?.en) : source.includes(entry?.en);
  if (
    !entry?.en ||
    !entry?.zh ||
    !matches ||
    (field === 'pdf' && (override.sourceFile !== question.sourceFile || !override.sourcePage))
  ) {
    throw new Error('主问题与原始资料不一致，请核对问题库版本。');
  }
  return { id, ...entry };
}

export function renderPrimaryQuestion(question, template, library) {
  const primary = primaryQuestion(question, template, library);
  return primary
    ? `<div class="q-primary" data-primary-id="${esc(primary.id)}"><p class="q-primary-zh" lang="zh-CN">${esc(primary.zh)}</p><p class="q-primary-en" lang="en">${esc(primary.en)}</p></div>`
    : '<div class="q-primary"><p class="q-primary-zh" lang="zh-CN">主问题原文尚未取得。</p><p class="q-primary-en" lang="en">The primary question text is not yet available.</p></div>';
}

// Flat rows retain hierarchy, table coordinates and branch labels for Excel.
export function flattenBlocks(blocks, path = '', parent = '') {
  const rows = [];
  (blocks || []).forEach((block, index) => {
    const id = path ? path + '.' + (index + 1) : String(index + 1);
    const markedText = (language) => {
      const text = sourceTextOf(block.text, language);
      return ['check', 'source-check'].includes(block.kind) && !/^\s*[□☐]/.test(text)
        ? '□ ' + text
        : text;
    };
    rows.push({
      id,
      parent,
      kind: block.kind,
      zh: markedText('zh'),
      en: markedText('en'),
      row: '',
      column: '',
      blank: false,
    });
    if (block.options)
      block.options.forEach((option, n) =>
        rows.push({
          id: id + '.option.' + (n + 1),
          parent: id,
          kind: 'select-option',
          zh: sourceTextOf(option.text),
          en: sourceTextOf(option.text, 'en'),
          row: '',
          column: '',
          blank: false,
        }),
      );
    if (block.kind === 'table') {
      block.columns.forEach((column, n) =>
        rows.push({
          id: id + '.header.' + (n + 1),
          parent: id,
          kind: 'table-header',
          zh: sourceTextOf(column),
          en: sourceTextOf(column, 'en'),
          row: 0,
          column: n + 1,
          blank: false,
        }),
      );
      block.rows.forEach((row, r) =>
        row.forEach((cell, c) => {
          const cellId = id + '.cell.' + (r + 1) + '.' + (c + 1);
          rows.push({
            id: cellId,
            parent: id,
            kind: 'table-cell',
            zh: sourceTextOf(cell),
            en: sourceTextOf(cell, 'en'),
            row: r + 1,
            column: c + 1,
            blank: !sourceTextOf(cell) && !sourceTextOf(cell, 'en') && !cell?.blocks,
          });
          if (cell?.blocks) rows.push(...flattenBlocks(cell.blocks, cellId, cellId));
        }),
      );
    }
    if (block.children) rows.push(...flattenBlocks(block.children, id, id));
  });
  return rows;
}
export function structuredChineseText(blocks) {
  return flattenBlocks(blocks)
    .map((row) =>
      row.blank
        ? `${row.id} [原表空白填写位置]`
        : `${row.id} ${row.kind === 'select-option' ? '选项：' : ''}${row.zh}`,
    )
    .join('\n');
}
