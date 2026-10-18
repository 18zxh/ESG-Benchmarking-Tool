import {element} from './topic-align.js';

export const HK_HIERARCHY_APPLICABILITY = Object.freeze({
  mandatory: '强制披露',
  complyOrExplain: '不遵守就解释',
  repealed: '已废止',
  voluntary: '自愿披露',
  encouraged: '鼓励披露',
  emissionsFromFy2025: 'FY2025起强制披露',
  largecapFromFy2026: 'FY2025不遵守就解释；FY2026起强制披露'
});

const ISSUER_KEYS = ['largecap', 'mainboard', 'gem'];
const PART_ORDER = ['B', 'C', 'D'];
const LONG_TEXT_LIMIT = 320;
const HEADERS = [
  ['part', '部分'],
  ['topic', '议题'],
  ['metric', '指标'],
  ['clause', '条款'],
  ['source', '原文披露要求'],
  ['largecap', '恒生综合大型股指数成分股'],
  ['mainboard', '其他主板发行人'],
  ['gem', 'GEM发行人']
];

const PART_D_PILLARS = Object.freeze({
  hk_d19: ['governance', '管治'],
  hk_d20: ['strategy', '战略'],
  hk_d21: ['strategy', '战略'],
  hk_d22: ['strategy', '战略'],
  hk_d24: ['strategy', '战略'],
  hk_d25: ['strategy', '战略'],
  hk_d26: ['strategy', '战略'],
  hk_d27: ['risk-management', '风险管理'],
  hk_ghg12: ['metrics-targets', '指标与目标'],
  hk_ghg3: ['metrics-targets', '指标与目标'],
  hk_d30: ['metrics-targets', '指标与目标'],
  hk_d31: ['metrics-targets', '指标与目标'],
  hk_d32: ['metrics-targets', '指标与目标'],
  hk_d33: ['metrics-targets', '指标与目标'],
  hk_d34: ['metrics-targets', '指标与目标'],
  hk_d35: ['metrics-targets', '指标与目标'],
  hk_d36: ['metrics-targets', '指标与目标'],
  hk_d37: ['metrics-targets', '指标与目标'],
  hk_d38: ['metrics-targets', '指标与目标'],
  hk_d39: ['metrics-targets', '指标与目标'],
  hk_d40: ['metrics-targets', '指标与目标']
});

const partLabel = part => `${part}部分`;

function topicAndMetric(topic) {
  if (topic.part === 'C') {
    const splitAt = String(topic.name || '').indexOf(' · ');
    if (splitAt >= 0) {
      return {
        topicId: topic.aspect || String(topic.name).slice(0, splitAt),
        topic: String(topic.name).slice(0, splitAt).trim(),
        metric: String(topic.name).slice(splitAt + 3).trim()
      };
    }
    return {topicId: topic.aspect || topic.id, topic: topic.name || '', metric: ''};
  }

  if (topic.part === 'D') {
    const [topicId, topicName] = PART_D_PILLARS[topic.id] || ['other', '其他气候披露'];
    return {topicId, topic: topicName, metric: topic.name || ''};
  }

  return {topicId: topic.id, topic: topic.name || '', metric: '—'};
}

function shortClause(topic) {
  const last = String(topic.clause || '').split('·').at(-1)?.trim() || '';
  if (topic.part === 'B') return last.replace(/^(?:Part\s+B|B部分)\s*/u, '');
  if (topic.part === 'D') return last.replace(/^(?:Part\s+D|D部分)\s*/u, '').replaceAll('、', '/');
  return last;
}

export function hkHierarchyApplicability(topic) {
  const labels = HK_HIERARCHY_APPLICABILITY;
  if (topic.part === 'B') {
    return {largecap: labels.mandatory, mainboard: labels.mandatory, gem: labels.mandatory};
  }
  if (topic.part === 'C') {
    if (topic.boards && !topic.boards.includes('主板')) {
      return {largecap: labels.repealed, mainboard: labels.repealed, gem: labels.complyOrExplain};
    }
    return {largecap: labels.complyOrExplain, mainboard: labels.complyOrExplain, gem: labels.complyOrExplain};
  }
  if (topic.part === 'D') {
    if (topic.id === 'hk_ghg12') {
      return {largecap: labels.emissionsFromFy2025, mainboard: labels.emissionsFromFy2025, gem: labels.emissionsFromFy2025};
    }
    if (topic.id === 'hk_d36') {
      return {largecap: labels.encouraged, mainboard: labels.encouraged, gem: labels.encouraged};
    }
    return {largecap: labels.largecapFromFy2026, mainboard: labels.complyOrExplain, gem: labels.voluntary};
  }
  return {largecap: '', mainboard: '', gem: ''};
}

function sourceParts(topic) {
  const mainboardApplies = !topic.boards || topic.boards.includes('主板');
  const mainboardText = String(topic.sourceText || '');
  const gemText = String(topic.sourceTextGem || '');

  if (!mainboardApplies) return [{board: 'GEM', label: 'GEM原文', text: gemText}];
  const comparable = text => text.replace(/\s+/gu, '').replaceAll('：', ':');
  if (comparable(mainboardText) === comparable(gemText)) return [{board: '主板及GEM', label: '', text: mainboardText}];
  return [
    {board: '主板', label: '主板原文', text: mainboardText},
    {board: 'GEM', label: 'GEM原文', text: gemText}
  ];
}

function displaySource(parts) {
  return parts.map(part => part.label ? `${part.label}\n${part.text}` : part.text).join('\n\n');
}

function addRowSpans(rows) {
  const signatures = {
    part: row => row.part,
    topic: row => `${row.part}\u0000${row.topicId}`,
    largecap: row => `${row.part}\u0000${row.applicability.largecap}`,
    mainboard: row => `${row.part}\u0000${row.applicability.mainboard}`,
    gem: row => `${row.part}\u0000${row.applicability.gem}`
  };
  for (const row of rows) row.rowSpan = Object.fromEntries(Object.keys(signatures).map(key => [key, 0]));

  for (const [key, signatureOf] of Object.entries(signatures)) {
    let start = 0;
    while (start < rows.length) {
      const signature = signatureOf(rows[start]);
      let end = start + 1;
      while (end < rows.length && signatureOf(rows[end]) === signature) end += 1;
      rows[start].rowSpan[key] = end - start;
      start = end;
    }
  }
  let partAnchor = null;
  let topicAnchor = null;
  for (const row of rows) {
    if (row.rowSpan.part) partAnchor = row.id;
    if (row.rowSpan.topic) topicAnchor = row.id;
    row.rowHeaderAnchors = {part: partAnchor, topic: topicAnchor};
  }
  return rows;
}

export function hkHierarchyRows(rules) {
  const topics = Array.isArray(rules?.topics) ? rules.topics : [];
  const ordered = [...topics].sort((a, b) => PART_ORDER.indexOf(a.part) - PART_ORDER.indexOf(b.part));
  const rows = ordered.map(topic => {
    const hierarchy = topicAndMetric(topic);
    const sources = sourceParts(topic);
    return {
      id: topic.id,
      topicId: hierarchy.topicId,
      part: topic.part,
      topic: hierarchy.topic,
      metric: hierarchy.metric,
      clause: shortClause(topic),
      sourceText: topic.sourceText || '',
      sourceTextGem: topic.sourceTextGem || '',
      sourceParts: sources,
      sourceDisplayText: displaySource(sources),
      applicability: hkHierarchyApplicability(topic),
      topicGroupId: `${topic.part}:${hierarchy.topicId}`
    };
  });
  return addRowSpans(rows);
}

function headerIds(id, ...rowHeaders) {
  return [id, ...rowHeaders].filter(Boolean).join(' ');
}

function appendMergedHeader(doc, row, tr, key, columnId, text, headerIdsForCell) {
  const span = row.rowSpan[key];
  if (!span) return null;
  const cell = element(doc, 'th', null, `hk-${key}-cell`);
  cell.scope = 'rowgroup';
  cell.rowSpan = span;
  cell.id = `hk-row-${key}-${row.id}`;
  cell.setAttribute('headers', headerIds(columnId, ...headerIdsForCell));
  cell.dataset.column = key;
  cell.append(element(doc, 'span', text, 'hk-merge-label'));
  tr.append(cell);
  return cell.id;
}

function excerpt(text, maxLength = 180) {
  const compact = String(text).replace(/\s+/gu, ' ').trim();
  const chars = Array.from(compact);
  return chars.length > maxLength ? `${chars.slice(0, maxLength).join('')}…` : compact;
}

function appendSourcePart(doc, cell, source) {
  const block = element(doc, 'div', null, 'hk-source-original');
  if (source.label) block.append(element(doc, 'span', source.label, 'hk-source-label'));
  if (source.text.length <= LONG_TEXT_LIMIT) {
    const full = element(doc, 'div', null, 'hk-source-full-text');
    appendSourceParagraphs(doc, full, source.text);
    block.append(full);
  } else {
    const details = element(doc, 'details', null, 'hk-source-details');
    details.append(element(doc, 'summary', excerpt(source.text, /[\u3400-\u9fff]/u.test(source.text) ? 100 : 180)));
    const full = element(doc, 'div', null, 'hk-source-full-text');
    appendSourceParagraphs(doc, full, source.text);
    details.append(full);
    block.append(details);
  }
  cell.append(block);
}

function appendSourceParagraphs(doc, target, text) {
  const lines = String(text).split('\n');
  lines.forEach((line, index) => {
    if (line) {
      const p = element(doc, 'p', line, 'hk-source-paragraph');
      if (/^[（(][ivx]+[)）]/iu.test(line)) p.classList.add('hk-source-indent-2');
      else if (/^[（(]\d+[)）]/u.test(line)) p.classList.add('hk-source-indent-3');
      else if (/^[（(][a-z][)）]/iu.test(line)) p.classList.add('hk-source-indent-1');
      if (/^(附注|注[:：]|注释)/u.test(line)) p.classList.add('hk-source-note');
      target.append(p);
    }
    if (index < lines.length - 1) target.append(doc.createTextNode('\n'));
  });
}

function sourceHeaderIds(row) {
  return [
    `hk-row-part-${row.rowHeaderAnchors.part}`,
    `hk-row-topic-${row.rowHeaderAnchors.topic}`,
    `hk-row-metric-${row.id}`,
    `hk-row-clause-${row.id}`
  ];
}

export function renderHkHierarchy(doc, rules) {
  const rows = hkHierarchyRows(rules);
  const section = element(doc, 'section', null, 'hk-requirements-section');
  section.setAttribute('aria-label', '港交所附录C2披露要求与主体对照');

  const scroll = element(doc, 'div', null, 'table-scroll hk-requirements-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('aria-label', '披露要求与发行人适用属性表，可横向及纵向滚动');

  const table = element(doc, 'table', null, 'hk-requirements-table');
  table.id = 'hk-requirements-table';
  const caption = element(doc, 'caption', '附录 C2 · 披露要求与适用主体');
  table.append(caption);

  const colgroup = doc.createElement('colgroup');
  for (const [key] of HEADERS) {
    const col = doc.createElement('col');
    col.className = `hk-requirements-col hk-requirements-col-${key}`;
    col.dataset.column = key;
    colgroup.append(col);
  }
  table.append(colgroup);

  const thead = doc.createElement('thead');
  const headerRow = doc.createElement('tr');
  for (const [key, label] of HEADERS) {
    const th = element(doc, 'th', label);
    th.scope = 'col';
    th.id = `hk-column-${key}`;
    th.dataset.column = key;
    headerRow.append(th);
  }
  thead.append(headerRow);
  table.append(thead);

  const tbody = doc.createElement('tbody');
  for (const row of rows) {
    const tr = doc.createElement('tr');
    tr.dataset.topicId = row.id;
    tr.dataset.part = row.part;

    appendMergedHeader(doc, row, tr, 'part', 'hk-column-part', partLabel(row.part), []);
    appendMergedHeader(doc, row, tr, 'topic', 'hk-column-topic', row.topic, [`hk-row-part-${row.rowHeaderAnchors.part}`]);

    const metric = element(doc, 'th', row.metric, 'hk-metric-cell');
    metric.scope = 'row';
    metric.id = `hk-row-metric-${row.id}`;
    metric.dataset.column = 'metric';
    metric.setAttribute('headers', headerIds('hk-column-metric', `hk-row-part-${row.rowHeaderAnchors.part}`, `hk-row-topic-${row.rowHeaderAnchors.topic}`));
    tr.append(metric);

    const clause = element(doc, 'th', row.clause, 'hk-clause-cell');
    clause.scope = 'row';
    clause.id = `hk-row-clause-${row.id}`;
    clause.dataset.column = 'clause';
    clause.setAttribute('headers', headerIds('hk-column-clause', `hk-row-part-${row.rowHeaderAnchors.part}`, `hk-row-topic-${row.rowHeaderAnchors.topic}`, metric.id));
    tr.append(clause);

    const sourceCell = element(doc, 'td', null, 'hk-source-cell');
    sourceCell.dataset.column = 'source';
    sourceCell.setAttribute('headers', headerIds('hk-column-source', ...sourceHeaderIds(row)));
    for (const source of row.sourceParts) appendSourcePart(doc, sourceCell, source);
    tr.append(sourceCell);

    for (const issuer of ISSUER_KEYS) {
      const span = row.rowSpan[issuer];
      if (!span) continue;
      const cell = element(doc, 'td', null, `hk-applicability-cell hk-applicability-${issuer}`);
      cell.rowSpan = span;
      cell.dataset.column = issuer;
      cell.dataset.issuerCategory = issuer;
      cell.setAttribute('headers', headerIds(`hk-column-${issuer}`, ...sourceHeaderIds(row)));
      cell.append(element(doc, 'span', row.applicability[issuer], 'hk-merge-label'));
      tr.append(cell);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  scroll.append(table);
  section.append(scroll);

  return section;
}
