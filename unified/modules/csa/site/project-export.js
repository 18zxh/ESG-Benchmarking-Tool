import { disclosureNames, effectiveDisclosure, qName } from './core.js';
import { reportMetadata } from './reports.js';
import { selectedEvidenceForResult } from './evidence.js';
import { resultStatus, reviewStatus } from './project.js';

export function remarkRows(project, questions) {
  const byId = new Map(questions.map(q => [q.id, q]));
  return [['维度', '标准', '问题', '初评备注', '人工备注', '原文与 PDF 页码', '备注状态'],
    ...project.results.map(r => {
      const q = byId.get(r.questionId);
      return [q.dimensionZh, q.criterionZh, qName(q) === q.title ? q.title : qName(q) + '\n' + q.title,
        r.current || '', r.review?.opinion || '',
        r.evidence.map(e => `${e.source} · PDF 第 ${e.page} 页${e.requiresReview ? '〔图片文字待核对〕' : ''}\n${e.text}`).join('\n\n'),
        r.modelIssues?.length ? '初评引用需核对' : reviewStatus[r.review?.status] || '待复核'];
    })];
}

export function exportRows(project, questions) {
  const qm = new Map(questions.map((x) => [x.id, x]));
  const rows = [
    [
      '方法年度',
      '项目评估年度（非已发布官方分数年度）',
      '本次评估报告期间',
      '目标披露期间',
      '企业',
      'CSA 行业',
      '行业确认依据',
      '问卷版本',
      '上市身份',
      '维度',
      '标准',
      '本站条目 ID（非已核实门户题号）',
      '问题原文名称',
      '证据要求',
      '标准权重参考（占总分%；证据重复行不得求和）',
      '方法原 PDF',
      '方法起始页',
      '方法结束页',
      '初评方式',
      '初评状态',
      '已有披露',
      '披露待核实项',
      '需要补充材料',
      '改进建议',
      '模型服务/型号',
      '模型校验问题',
      '原文所在 PDF',
      '资料类型（用户填写）',
      '该资料覆盖期间／信息时点（用户填写）',
      '资料角色',
      '原文 PDF 页',
      '原文片段 ID',
      '原文内容',
      '资料是否公开',
      '识别提醒',
      '是否选用该片段供模型分析',
      '人工状态（本题级）',
      '人工意见（本题级）',
      '复核人（本题级）',
      '复核时间（本题级）',
      '检索方式（不代表证据满足程度）',
      '片段切分版本',
      '语义模型',
      '语义模型版本',
      '候选命中方式',
      '既往人工意见（已归档，非本次确认）',
    ],
  ];
  for (const r of project.results) {
    const q = qm.get(r.questionId);
    if (!q) continue;
    const selected = new Set(selectedEvidenceForResult(r));
    for (const e of r.evidence.length ? r.evidence : [{}]) {
      const meta = e.id ? reportMetadata(project.reports.find((doc) => doc.id === e.reportId)) : {};
      rows.push([
        project.methodYear,
        project.scoreYear,
        project.reportPeriod,
        project.targetPeriod,
        project.name,
        project.industry,
        project.industryBasis,
        project.version,
        project.listed,
        q.dimensionZh,
        q.criterionZh,
        q.id,
        q.title,
        disclosureNames[effectiveDisclosure(q, project.listed)] || q.disclosure,
        q.weight,
        q.sourceFile,
        q.page,
        q.endPage,
        r.mode,
        resultStatus[r.status] || r.status,
        r.current,
        (r.gaps || []).join('\n'),
        (r.requests || []).join('\n'),
        r.recommendation,
        r.modelLabel || '',
        (r.modelIssues || []).join('\n'),
        e.source || '',
        meta.documentType || '',
        meta.documentPeriod || '',
        meta.role || '',
        e.page || '',
        e.id || '',
        e.text || '',
        e.id ? (e.public ? '用户确认公开' : '内部／未确认公开') : '',
        e.quality_note || '',
        e.id ? (selected.has(e.id) ? '是' : '否') : '',
        reviewStatus[r.review?.status] || '待复核',
        r.review?.opinion || '',
        r.review?.reviewer || '',
        r.review?.updated || '',
        r.retrieval?.mode === 'native-pdf' ? '原 PDF 读取' : r.retrieval?.mode === 'hybrid' ? '历史语义检索' : '关键词检索',
        r.retrieval?.chunkVersion || '',
        r.retrieval?.model || '',
        r.retrieval?.revision || '',
        e.matchType || '',
        (r.reviewHistory || []).map((h) => `${h.updated || ''} · ${reviewStatus[h.status] || h.status} · ${h.opinion || ''} · 归档原因：${h.reason || ''}`).join('\n'),
      ]);
    }
  }
  return rows;
}
