import { invalidateReview } from './model-evaluation.js';

const encodedFiles = new WeakMap();
function fileData(blob) {
  if (!encodedFiles.has(blob)) encodedFiles.set(blob, new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve('data:application/pdf;base64,' + String(reader.result).split(',')[1]);
    reader.onerror = () => { encodedFiles.delete(blob); reject(new Error('原 PDF 读取失败，请重新关联原文件。')); };
    reader.readAsDataURL(blob);
  }));
  return encodedFiles.get(blob);
}

export async function nativeDocuments(project, onProgress) {
  const documents = [];
  for (const r of project.reports) {
    if (!r.blob) throw new Error('请先重新关联原 PDF；项目备份不包含原文件。');
    if (r.blob.size > 50 * 1024 * 1024) throw new Error('原生 PDF 模型单份支持 50 MB 以内的文件，请先压缩或拆分报告。');
    onProgress?.('正在准备原 PDF · ' + r.name);
    documents.push({ id: r.id, name: r.name, fileData: await fileData(r.blob), sha256: r.meta.originalSha256,
      pageCount: r.meta.pageCount, public: r.public === true, sourceUrl: r.sourceUrl || '',
      documentType: r.documentType || '', documentPeriod: r.documentPeriod || '' });
  }
  return documents;
}

export async function analyzePdfBatch(questionIds, project, provider, documents, onProgress, options = {}) {
  const response = await fetch('/api/evaluate-pdf', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: provider.id, documents, questionIds, cacheMode: options.cacheMode || 'normal',
      project: Object.fromEntries(['name', 'industry', 'industryBasis', 'methodYear', 'version',
        'listed', 'reportPeriod', 'targetPeriod'].map(k => [k, project[k]])) }),
  });
  const job = await response.json();
  if (!response.ok) throw new Error(job.error || 'GLM PDF 初评启动失败。');
  await options.onJob?.(job.jobId);
  const deadline = Date.now() + 60 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const statusResponse = await fetch('/api/native-pdf-jobs/' + encodeURIComponent(job.jobId));
    const status = await statusResponse.json();
    if (!statusResponse.ok) throw new Error(status.error || 'GLM PDF 任务状态已失效。');
    options.onState?.(status);
    onProgress?.(`${status.phase || 'GLM 正在读取 PDF'}${status.detail ? ' · ' + status.detail : ''}`);
    if (status.status === 'completed') return { ...status.result, completedAt: new Date().toISOString() };
    if (['failed', 'interrupted', 'stopped'].includes(status.status)) throw new Error(status.error || 'GLM PDF 初评失败。');
  }
  throw new Error('GLM PDF 处理超过 60 分钟；未保存不完整结果，请稍后重试。已完成题目与页段已保存在本机，继续生成初评可复用。');
}

export function applyPdfRemark(result, item, answer, provider, project) {
  if (result.review?.status !== 'noted')
    invalidateReview(result, '原 PDF 重新分析，已有复核结论保留在历史记录中');
  const evidence = item.evidence.map((e, index) => {
    const report = project.reports.find(r => r.id === e.reportId);
    return { ...e, id: `pdf-${e.reportId}-${e.page}-${result.questionId}-${index + 1}`,
      heading: `${e.source} · PDF 第 ${e.page} 页`, matchType: '原 PDF 读取', autoSelect: true,
      documentType: report.documentType, documentPeriod: report.documentPeriod, role: report.role,
      contextComplete: true, requiresReview: e.requiresReview === true,
      quality_note: [e.pageCorrected ? 'PDF 物理页码已按唯一原文匹配定位。' : '',
        e.requiresReview ? '图片识别文字，请对照原 PDF 核对。' : ''].filter(Boolean).join(' ') };
  });
  result.evidence = evidence;
  result.selectedEvidenceIds = evidence.map(e => e.id);
  result.nativeRemark = item.remark;
  result.uncheckedEvidence = item.uncheckedEvidence || [];
  result.current = item.issues.length ? '模型备注的引用或数值需要核对，尚未作为已验证结论。' : item.remark;
  result.status = item.issues.length ? 'error' : 'model';
  result.mode = 'native-pdf';
  result.modelIssues = item.issues;
  result.gaps = []; result.requests = []; result.recommendation = '';
  result.uncertainties = item.warnings;
  result.modelLabel = provider.name + ' / ' + answer.model;
  result.modelAt = answer.completedAt;
  result.retrieval = { mode: 'native-pdf', model: answer.model, at: answer.completedAt };
  result.nativeDraftStatus = item.draftStatus;
  return result;
}


export async function controlPdfJob(jobId, action) {
  const response = await fetch('/api/native-pdf-jobs/' + encodeURIComponent(jobId) + '/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '任务控制失败。');
}
