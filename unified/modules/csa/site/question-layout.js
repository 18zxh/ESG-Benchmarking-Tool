import { esc } from './core.js';

const headingLabelSource =
  'Specific Question Guidance(?:\\s*&\\s*Definitions)?|Question-Specific Guidance(?:\\s*&\\s*Definitions)?|Data Requirements|Disclosure Requirements|Standards\\s*&\\s*Frameworks|References|特定问题指南(?:与定义)?|具体问题指南(?:与定义)?|问题特定指南(?:与定义)?|问题特定指导(?:与定义)?|数据要求|披露要求|标准与框架|参考资料|参考文献';
const headingPattern = new RegExp('^(' + headingLabelSource + ')$', 'i');
const inlineHeadingPattern = new RegExp(
  '^(' + headingLabelSource + ')(?:\\s*[:：]\\s*|\\s+)(.+)$',
  'i',
);
const choicePattern = /^(o(?=\s|$)|○|◯|□|☐)\s*(.*)$/;
const dropdownPattern =
  /^(Dropdown(?: menu)?|Drop-down(?: menu)?|Drodown(?: menu)?|下拉菜单)\s*[:：]?\s*$/i;

// This parses layout marks and wraps existing text; it performs no translation.
export function parseLayout(text, language = 'en') {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n');
  const blocks = [];
  let current = null;
  let index = 0,
    markIndex = 0;
  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };
  const append = (value) => {
    if (!current) current = { kind: 'paragraph', text: { [language]: value } };
    else current.text[language] += ' ' + value;
  };
  while (index < lines.length) {
    const line = lines[index++].trim();
    if (!line) {
      flush();
      continue;
    }
    const mark = line.match(choicePattern);
    if (mark) {
      flush();
      current = {
        kind: mark[1] === '□' || mark[1] === '☐' ? 'check' : 'source-radio',
        key: 'source-' + ++markIndex,
        text: { [language]: mark[2] },
      };
      continue;
    }
    if (dropdownPattern.test(line)) {
      flush();
      const values = [];
      while (index < lines.length) {
        const next = lines[index].trim();
        if (!next) {
          index++;
          if (values.length) break;
          continue;
        }
        if (choicePattern.test(next) || dropdownPattern.test(next)) break;
        if (
          values.length &&
          (headingPattern.test(next) ||
            inlineHeadingPattern.test(next) ||
            /^[^:：]{1,100}[:：]$/.test(next) ||
            /^(Please\s|The company\s|Business value chain|External stakeholder|Passive investments$|Externally managed assets$|请|公司|业务价值链|外部利益相关|被动投资|外部管理)/i.test(
              next,
            ))
        )
          break;
        values.push(next);
        index++;
      }
      blocks.push({
        kind: 'source-menu',
        key: 'dropdown-' + ++markIndex,
        text: { [language]: language === 'zh' ? '下拉选项' : 'Dropdown options' },
        options: values.map((value, i) => ({ value: String(i), text: { [language]: value } })),
      });
      continue;
    }
    if (headingPattern.test(line)) {
      flush();
      blocks.push({ kind: 'heading', text: { [language]: line } });
      continue;
    }
    const inlineHeading = line.match(inlineHeadingPattern);
    if (inlineHeading) {
      flush();
      blocks.push({ kind: 'heading', text: { [language]: inlineHeading[1] } });
      current = { kind: 'paragraph', text: { [language]: inlineHeading[2] } };
      continue;
    }
    if (/^[•●]\s*/.test(line)) {
      flush();
      current = { kind: 'bullet', text: { [language]: line.replace(/^[•●]\s*/, '') } };
      continue;
    }
    if (!current)
      current = { kind: blocks.length ? 'paragraph' : 'prompt', text: { [language]: line } };
    else append(line);
  }
  flush();
  return blocks.filter((block) => block.text?.[language] || block.options?.length);
}

// —— 中文方法文本的结构化整理 ——
// 将 Handbook 中文译文按“节标题 / 标签 / 条目 / 选项 / 段落”分层，
// 供页面展示与评估工作台（AI 评级依据）共用；不改写任何原文。
const zhSectionHeadings = new Set([
  '问题专项指南与定义', '问题专属指南与定义', '问题专属指南和定义', '问题特定指南与定义',
  '问题特定指导与定义', '问题特定指南和定义', '特定问题指南与定义', '具体问题指南与定义',
  '问题专项指南', '问题专属指南', '问题特定指南',
  '数据要求', '一般数据要求', '披露要求', '部分公开问题的披露要求',
  '标准与框架', '参考资料', '参考文献', '参考标准',
]);
const zhRadioMark = /^[o○◯](?:\s+|$)/;
const zhCheckMark = /^[□☐](?:\s+|$)/;
const zhBulletMark = /^[•●]\s+/;
const zhStepMark = /^\d{1,2}[.、)]\s*/;
const zhListItemStart = /^[•●□☐○◯]|^\d{1,2}[.、)]\s*/;

export function parseZhStructure(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const bare = line.replace(/\s*[:：]\s*$/, '');
    const next = (lines.slice(i + 1).find((l) => l.trim()) || '').trim();
    let kind = 'para',
      content = line;
    if (zhSectionHeadings.has(bare)) {
      kind = 'heading';
      content = bare;
    } else if (zhRadioMark.test(line)) {
      kind = 'radio';
      content = '○ ' + line.replace(zhRadioMark, '');
    } else if (zhCheckMark.test(line)) {
      kind = 'check';
      content = '□ ' + line.replace(zhCheckMark, '');
    } else if (zhBulletMark.test(line)) {
      kind = 'bullet';
      content = line.replace(zhBulletMark, '');
    } else if (zhStepMark.test(line)) {
      kind = 'step';
    } else if (/[:：]$/.test(line) && line.length <= 26) {
      kind = 'label';
      content = bare + '：';
    } else if (line.length <= 16 && !/[。；.!?！？]$/.test(line) && zhListItemStart.test(next)) {
      kind = 'label';
    }
    rows.push({ kind, text: content });
  }
  return rows;
}

export function structuredMethodHtml(text) {
  const rows = parseZhStructure(text);
  let html = '',
    list = '';
  const flush = () => {
    if (list) {
      html += `<ul class="method-list">${list}</ul>`;
      list = '';
    }
  };
  for (const row of rows) {
    if (['bullet', 'step', 'radio', 'check'].includes(row.kind)) {
      list += `<li class="method-${row.kind}">${esc(row.text)}</li>`;
      continue;
    }
    flush();
    if (row.kind === 'heading') html += `<h5 class="method-heading">${esc(row.text)}</h5>`;
    else if (row.kind === 'label') html += `<p class="method-label">${esc(row.text)}</p>`;
    else html += `<p>${esc(row.text)}</p>`;
  }
  flush();
  return `<div class="method-text">${html}</div>`;
}

export function structuredMethodText(text) {
  return parseZhStructure(text)
    .map((row) => {
      if (row.kind === 'heading') return `【${row.text}】`;
      if (row.kind === 'bullet') return '• ' + row.text;
      return row.text;
    })
    .join('\n');
}

// 取某题三个方法段的中文译文（问题布局 / 证据要求 / 评分依据），供 AI 评级载荷使用。
export function questionMethodZh(question, translations) {
  const t = translations?.translations || {};
  return {
    layout: t.layout?.[question.layout] || '',
    guidance: t.guidance?.[question.guidance] || '',
    rationale: t.rationale?.[question.rationale] || '',
  };
}
