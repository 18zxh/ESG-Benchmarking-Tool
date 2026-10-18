import { reportTypeNames } from './reports.js';
import { selectedEvidenceForResult } from './evidence.js';

export const resultStatus = {
  candidate: '找到候选证据',
  internal: '需补内部或公开佐证',
  not_found: '未找到候选证据',
  model: '模型初评待复核',
  error: '模型失败，保留检索结果',
};
export const reviewStatus = {
  pending: '待复核',
  noted: '已加备注',
  full: '已核实：证据较充分',
  partial: '已核实：部分覆盖',
  not_found: '仍需补充材料',
  conflicting: '发现矛盾',
  not_applicable: '提出不适用：待官方确认',
};
export const isFullProject = (project) => project?.version === 'Full';
export function requireFullProject(project) {
  if (!isFullProject(project))
    throw new Error('本站已不再支持此历史版本的初评。请下载备份，再新建 Full 项目开展初评；原项目仍可查阅、复核和导出。');
}
export function blankProject() {
  return {
    schema: 1,
    id: 'current',
    name: '',
    industry: 'CON',
    industryBasis: '',
    methodYear: 2026,
    scoreYear: 2026,
    reportPeriod: '',
    targetPeriod: '',
    version: 'Full',
    listed: 'listed',
    reports: [],
    results: [],
    selected: [],
    savedAt: null,
  };
}
export function validateProject(p) {
  // Legacy support is for historical projects and backups, not new assessments.
  if (
    !p ||
    p.schema !== 1 ||
    p.id !== 'current' ||
    !Array.isArray(p.reports) ||
    !Array.isArray(p.results) ||
    !Array.isArray(p.selected) ||
    p.methodYear !== 2026 ||
    Number(p.scoreYear) !== 2026 ||
    !['Full', 'Fundamental'].includes(p.version) ||
    !/^[A-Z]{3}$/.test(p.industry) ||
    !['listed', 'nonlisted', 'unknown'].includes(p.listed)
  )
    throw new Error('项目文件格式或方法年度不支持。');
  if (p.reports.length > 6 || p.results.length > 300) throw new Error('项目文件超过本版容量限制。');
  if (p.retrievalMode !== undefined && !['keyword', 'hybrid'].includes(p.retrievalMode))
    throw new Error('项目检索设置无效。');
  for (const key of ['name', 'industryBasis', 'reportPeriod', 'targetPeriod'])
    if (typeof p[key] !== 'string') throw new Error('项目背景字段格式错误。');
  for (const r of p.reports) {
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(r.id) ||
      typeof r.name !== 'string' ||
      !['main', 'support'].includes(r.role) ||
      !Array.isArray(r.meta?.pages) ||
      r.meta.pages.length < 1 ||
      r.meta.pages.length > 500 ||
      !Number.isInteger(r.meta.pageCount) ||
      r.meta.pageCount !== r.meta.pages.length ||
      !/^[a-f0-9]{64}$/.test(r.meta.originalSha256)
    )
      throw new Error('项目缺少可识别的报告页数据，或页数与支持范围不一致。');
    if (
      r.meta.pages.some(
        (x) =>
          !Number.isInteger(x.page) ||
          x.page < 1 ||
          !Array.isArray(x.blocks) ||
          x.blocks.some((b) => typeof b.text !== 'string'),
      )
    )
      throw new Error('项目中的 PDF 页或原文数据无效。');
    if (r.documentType !== undefined && !Object.hasOwn(reportTypeNames, r.documentType))
      throw new Error('资料类型不在本版支持范围内。');
    if (
      r.documentPeriod !== undefined &&
      (typeof r.documentPeriod !== 'string' || r.documentPeriod.length > 80)
    )
      throw new Error('资料覆盖期间格式无效。');
  }
  const qid = (id) => typeof id === 'string' && new RegExp('^' + p.industry + '-\\d{3}$').test(id);
  if (p.selected.some((id) => !qid(id))) throw new Error('项目选题与行业不匹配。');
  for (const r of p.results) {
    if (
      !qid(r.questionId) ||
      !Array.isArray(r.evidence) ||
      r.evidence.length > 24 ||
      !r.review ||
      !Object.hasOwn(reviewStatus, r.review.status) ||
      typeof r.review.opinion !== 'string'
    )
      throw new Error('初评或人工意见格式无效。');
    if (
      r.evidence.some(
        (e) =>
          typeof e.id !== 'string' ||
          typeof e.text !== 'string' ||
          typeof e.source !== 'string' ||
          !Number.isInteger(e.page) ||
          e.page < 1 ||
          !p.reports.some((doc) => doc.id === e.reportId && e.page <= doc.meta.pages.length),
      )
    )
      throw new Error('初评中的原文定位不属于本项目报告。');
    const evidenceIds = new Set(r.evidence.map((e) => e.id));
    if (
      r.selectedEvidenceIds !== undefined &&
      (!Array.isArray(r.selectedEvidenceIds) ||
        r.selectedEvidenceIds.some((id) => !evidenceIds.has(id)))
    )
      throw new Error('已选原文片段不属于本题候选。');
    r.selectedEvidenceIds = selectedEvidenceForResult(r);
    if (r.reviewHistory !== undefined && (!Array.isArray(r.reviewHistory) || r.reviewHistory.some((h) =>
      !h || !Object.hasOwn(reviewStatus, h.status) || typeof h.opinion !== 'string'
    ))) throw new Error('既往人工意见格式无效，当前项目已保留。');
    for (const key of ['gaps', 'requests', 'uncertainties'])
      if (!Array.isArray(r[key]) || r[key].some((x) => typeof x !== 'string'))
        throw new Error('初评待核实字段无效。');
  }
  return p;
}
export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('csa-local-workbench', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('projects', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error('浏览器未允许保存项目；可使用项目备份。'));
  });
}
export async function saveProject(p) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('projects', 'readwrite');
    tx.objectStore('projects').put(p);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(new Error('保存失败，浏览器空间不足或存储未获允许。请下载项目备份。'));
    };
  });
}
export async function loadProject() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('projects', 'readonly');
    const r = tx.objectStore('projects').get('current');
    r.onsuccess = () => {
      db.close();
      try {
        resolve(r.result ? validateProject(r.result) : blankProject());
      } catch (error) {
        reject(error);
      }
    };
    r.onerror = () => {
      db.close();
      reject(new Error('读取已存项目失败。'));
    };
  });
}
