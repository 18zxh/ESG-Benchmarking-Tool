export const reportTypeNames = {
  unspecified: '待确认资料类型',
  esg: 'ESG／可持续发展报告',
  annual: '年度报告',
  financial: '财务报告',
  interim: '中期／季度报告',
  csr: '社会责任报告',
  policy: '制度／政策',
  assurance: '鉴证／审计报告',
  internal: '内部台账／底稿',
  other: '其他资料',
};
export function prepareUploadPlan(reports, files, hashes, hasResults = false) {
  if (!Array.isArray(files) || !Array.isArray(hashes) || files.length !== hashes.length)
    throw new Error('文件指纹校验未完成，请重试。');
  const unique = new Set(reports.map((r) => r.meta.originalSha256)),
    prepared = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i],
      sha = hashes[i];
    if (!/\.pdf$/i.test(file.name) || file.size === 0 || file.size > 80 * 1024 * 1024)
      throw new Error('请上传非空 PDF，单个文件最多 80 MB、1–500 页。');
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('文件指纹无效，请重新选择 PDF。');
    if (hasResults && !unique.has(sha))
      throw new Error('已有初评时仅能重新关联相同指纹的原 PDF；新材料请先备份并清除初评。');
    unique.add(sha);
    prepared.push({ file, sha });
  }
  if (unique.size > 6)
    throw new Error('主要报告与佐证合计最多 6 份。请移除多余文件后再上传，尚未开始解析。');
  return prepared;
}
export function reportMetadata(report) {
  return {
    documentType: reportTypeNames[report?.documentType] || reportTypeNames.unspecified,
    documentPeriod: report?.documentPeriod || '未填写／待核实',
    role: report?.role === 'main' ? '主要报告' : '佐证材料',
  };
}
export function reportPeriodIssues(project) {
  const issues = [],
    years = String(project.reportPeriod || '').match(/\b(?:19|20)\d{2}\b/g) || [],
    baseline = new Set(years);
  if (
    project.reports.some(
      (r) => !r.documentPeriod || !r.documentType || r.documentType === 'unspecified',
    )
  )
    issues.push('部分资料的类型或覆盖期间尚待填写；不能将本次评估期间自动套用到这些文件。');
  if (
    baseline.size === 1 &&
    project.reports.some((r) => {
      const ys = String(r.documentPeriod || '').match(/\b(?:19|20)\d{2}\b/g) || [];
      return ys.length && !ys.some((y) => baseline.has(y));
    })
  )
    issues.push(
      '存在不同年度的资料。年报中的比较数据、历史政策和当期表现需分别核对，不合并为同一期间的绩效。',
    );
  return issues;
}
export const CHUNK_VERSION = 'csa-context-v3';
const chunkCache = new Map();
const MAX_CHARS = 3200;

// Metadata changes also invalidate the collection. Parsed page blocks are immutable.
export function reportCollectionKey(reports) {
  return JSON.stringify([CHUNK_VERSION, ...reports.map((r) => [
    r.id, r.name, r.meta?.originalSha256, r.meta?.parserSourceSha256,
    r.meta?.converterVersion, r.meta?.pageCount, r.documentType,
    r.documentPeriod, r.role, r.public === true, r.sourceUrl,
  ])]);
}

function splitLines(text, budget) {
  const parts = [];
  let body = '';
  const flush = () => { if (body.trim()) parts.push(body.trim()); body = ''; };
  for (const line of text.split('\n')) {
    if (line.length > budget) {
      flush();
      for (let at = 0; at < line.length; at += budget) parts.push(line.slice(at, at + budget));
    } else {
      if (body.length + line.length + 1 > budget) flush();
      body += (body ? '\n' : '') + line;
    }
  }
  flush();
  return parts;
}

export function createChunks(reports) {
  const key = reportCollectionKey(reports);
  if (chunkCache.has(key)) return chunkCache.get(key);
  const chunks = [];
  for (const report of reports) {
    for (const page of report.meta?.pages || []) {
      for (const block of page.blocks || []) {
        const text = String(block.text || '').trim();
        if (!text) continue;
        const context = block.type === 'table'
          ? [block.headerText, block.contextText && '表格附近的标题、单位和脚注：\n' + block.contextText].filter(Boolean).join('\n')
          : '';
        // Very long context remains searchable in separate source pieces.
        const contextComplete = context.length <= 2000;
        const prefix = contextComplete ? context : context.slice(0, 2000);
        const budget = MAX_CHARS - prefix.length - 1;
        const splitLongRow = block.type === 'table' && text.split('\n').some((line) => line.length > budget);
        const pieces = splitLines(text, budget);
        const bodyPartCount = pieces.length;
        if (!contextComplete) pieces.push(...splitLines(context, MAX_CHARS));
        for (let part = 0; part < pieces.length; part++) {
          const contextOnly = part >= bodyPartCount;
          const excerpt = contextOnly ? pieces[part] : [prefix, pieces[part]].filter(Boolean).join('\n');
          const uncertain = block.uncertainTexts?.filter((value) => excerpt.includes(value));
          const requiresReview = (uncertain ? uncertain.length > 0 : Boolean(block.requiresReview)) || splitLongRow;
          chunks.push({
            id: `${report.id}-${page.page}-${block.id}-v3-${part + 1}`,
            reportId: report.id,
            source: report.name,
            page: page.page,
            type: block.type,
            blockId: block.id,
            part: part + 1,
            partCount: pieces.length,
            heading: `${report.name} · PDF 第 ${page.page} 页 · ${block.type === 'table' ? '表格' : '原文'}`,
            bbox: block.bbox || [],
            extractionMethod: block.method || block.structureSource || '',
            chunkVersion: CHUNK_VERSION,
            contextComplete,
            requiresReview,
            ...reportMetadata(report),
            text: excerpt,
            public: report.public === true,
            quality_note: [
              uncertain?.length ? '此片段有识别不确定文字：' + uncertain.join('；') : requiresReview ? block.warning || '识别结果需要核对' : '',
              !contextComplete ? '表格上下文较长，完整表头与脚注另存为同页来源片段，需对照原 PDF。' : '',
              splitLongRow ? '原表单行较长，按来源片段拆分，需对照同页完整行。' : '',
            ].filter(Boolean).join('；'),
          });
        }
      }
    }
  }
  chunkCache.set(key, chunks);
  if (chunkCache.size > 3) chunkCache.delete(chunkCache.keys().next().value);
  return chunks;
}
