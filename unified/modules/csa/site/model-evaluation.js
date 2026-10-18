import { effectiveDisclosure, qName } from './core.js';
import { reportMetadata } from './reports.js';
import { selectedEvidenceForResult } from './evidence.js';
import { structuredMethodText, questionMethodZh } from './question-layout.js';

export function buildEvaluation(question, result, project, chunkCount, translations) {
  const reports = project.reports;
  const selected = new Set(selectedEvidenceForResult(result));
  const evidence = result.evidence.filter((e) => selected.has(e.id)).slice(0, 8);
  const zh = questionMethodZh(question, translations);
  return {
    criterion: {
      issue: question.criterionZh, issue_en: question.criterion,
      pillar: question.dimensionZh, type: effectiveDisclosure(question, project.listed),
      title: qName(question), title_en: question.title,
      definition: `证据要求：${effectiveDisclosure(question, project.listed)}；上市身份：${project.listed}。\n${question.layout}`,
      definition_en: question.layout, parent: question.criterion,
      scoring_rule: question.guidance, numeric_scale_available: false,
      source_pages: [question.page, question.endPage],
      // 中文结构化方法文本，与问题导读页同源同口径。
      definition_zh: structuredMethodText(zh.layout),
      scoring_rule_zh: structuredMethodText(zh.guidance),
      scoring_intent: question.rationale,
      scoring_intent_zh: structuredMethodText(zh.rationale),
    },
    evidence: evidence.map((e) => {
      const doc = reports.find((r) => r.id === e.reportId), meta = reportMetadata(doc);
      return {
        id: e.id, source: e.source, location: `PDF 第 ${e.page} 页`,
        heading: e.heading || question.title, text: e.text,
        document_type: meta.documentType, document_period: meta.documentPeriod, document_role: meta.role,
        quality_note: `${e.public ? '用户确认公开' : '内部／未确认公开'}；${e.quality_note || '无额外识别提醒'}；${doc?.sourceUrl || '原网址未填写'}`,
      };
    }),
    project: {
      client_name: project.name, report_period: project.reportPeriod, target_period: project.targetPeriod,
      assessment_scope: `CSA ${project.industry}，${project.methodYear} ${project.version}；行业依据：${project.industryBasis}。仅分析候选片段，线上问卷适用性需核验。`,
    },
    report: {
      page_count: reports.reduce((s, r) => s + r.meta.pageCount, 0),
      processed_pages: reports.reduce((s, r) => s + r.meta.processedPages, 0),
      readable_pages: reports.reduce((s, r) => s + r.meta.readablePages, 0),
      table_count: reports.reduce((s, r) => s + r.meta.tableCount, 0),
      indexed_chunks: chunkCount, selected_chunks: evidence.length,
      page_coverage_complete: reports.every((r) => r.meta.pageCoverageComplete),
    },
  };
}

// Keep a prior completed opinion inspectable when its evidence or draft changes.
export function invalidateReview(result, reason) {
  if (result.review?.status && result.review.status !== 'pending') {
    result.reviewHistory = [...(result.reviewHistory || []), {
      ...result.review, reason, archivedAt: new Date().toISOString(),
    }];
    result.review = { status: 'pending', opinion: '', reviewer: '', updated: null };
  }
}

export async function analyzeQuestion(question, result, project, provider, chunkCount, translations) {
  const evaluation = buildEvaluation(question, result, project, chunkCount, translations);
  invalidateReview(result, '模型重新分析，需按本次草稿再次确认');
  if (!evaluation.evidence.length) {
    result.modelIssues = ['尚未选用可核实原文，未发送模型请求。请先选择证据。'];
    result.status = 'error';
    return result;
  }
  try {
    const response = await fetch('/api/evaluate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerIds: [provider.id], evaluation }),
      signal: AbortSignal.timeout(400000),
    });
    const answer = await response.json();
    if (!response.ok) throw new Error(answer.error || '模型服务请求失败。');
    const run = answer.results?.[0];
    if (!run) throw new Error('模型服务没有返回结果。');
    result.modelLabel = provider.name + ' / ' + provider.model;
    result.modelAt = answer.completedAt;
    result.modelRaw = run.content || '';
    result.modelIssues = [run.error, ...(run.groundingIssues || [])].filter(Boolean);
    if (result.modelIssues.length) { result.status = 'error'; return result; }
    const draft = JSON.parse(run.content);
    Object.assign(result, {
      status: 'model', mode: 'model', current: draft.current_disclosure || draft.rationale,
      gaps: draft.gaps || [], requests: draft.information_requests || [],
      recommendation: draft.recommendation, uncertainties: draft.uncertainties || [], modelDraft: draft,
    });
  } catch (error) {
    result.status = 'error';
    result.modelIssues = [error.name === 'TimeoutError' ? '模型等待超时，请核对服务后重试。' : error.message];
  }
  return result;
}
