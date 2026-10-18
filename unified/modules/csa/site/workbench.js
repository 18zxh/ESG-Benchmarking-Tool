import { renderWorkbench } from './workbench-view.js';
import { isLibraryQuestion } from './question-policy.js';
import { canInitialAssess, esc, qName, dimNames } from './core.js';
import { reportMetadata, prepareUploadPlan, createChunks, CHUNK_VERSION } from './reports.js';
import { searchEvidence, initialResult, selectedEvidenceForResult } from './evidence.js';
import {
  blankProject, saveProject, loadProject, validateProject, isFullProject, requireFullProject,
} from './project.js';
import { exportRows, remarkRows } from './project-export.js';
import { buildXlsx, downloadXlsx } from './xlsx.js';
import { TaskQueue } from './task-queue.js';
import { analyzeQuestion, invalidateReview } from './model-evaluation.js';
import { nativeDocuments, analyzePdfBatch, applyPdfRemark, controlPdfJob } from './native-pdf.js';
import { assessmentMethodSheet } from './assessment-method.js';

const download = async (name, content, type = 'application/json') => {
  const response = await fetch('/api/export-file', {
    method: 'POST',
    headers: { 'Content-Type': type, 'X-File-Name': encodeURIComponent(name) },
    body: new TextEncoder().encode(content),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '项目备份生成失败。');
  const a = document.createElement('a');
  a.href = result.url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  return result;
};
export class Workbench {
  constructor(main, data, getData, toast) {
    Object.assign(this, { main, data, getData, toast });
    this.step = 1;
    this.page = 0;
    this.focusId = '';
    this.busy = false;
    this.providers = [];
    this.error = '';
    this.progress = '';
    this.abort = false;
    this.urls = new Set();
    main.addEventListener('click', (e) => {
      const b = e.target.closest('[data-wb]');
      if (!b || !location.hash.includes('/workbench')) return;
      this.click(b).catch((err) => this.fail(err));
    });
    main.addEventListener('input', (e) => {
      if (this.busy) return;
      const el = e.target;
      if (el.dataset.reviewNote) {
        const result = this.project.results.find(r => r.questionId === el.dataset.reviewNote);
        if (result) { result.reviewDraft = { ...result.review, ...result.reviewDraft, opinion: el.value }; this.dirty = true; }
      }
      if (el.closest('[data-wb-form=review]') && el.name) {
        const r = this.currentResult();
        r.reviewDraft = { ...r.reviewDraft, [el.name]: el.value };
        this.dirty = true;
      }
      if (el.dataset.project && isFullProject(this.project)) {
        this.project[el.dataset.project] = el.value;
        this.dirty = true;
      }
      if (el.dataset.reportUrl && isFullProject(this.project)) {
        this.project.reports.find((r) => r.id === el.dataset.reportUrl).sourceUrl = el.value.trim();
        this.markNativeInputsChanged();
        this.dirty = true;
      }
      if (el.dataset.reportField && isFullProject(this.project)) {
        const report = this.project.reports.find((r) => r.id === el.dataset.reportId);
        if (report) {
          report[el.dataset.reportField] = el.value;
          this.markNativeInputsChanged();
          this.dirty = true;
        }
      }
    });
    main.addEventListener('change', (e) => {
      if (!location.hash.includes('/workbench')) return;
      this.change(e.target).catch((err) => this.fail(err));
    });
    main.addEventListener('submit', (e) => {
      if (e.target.dataset.wbForm) {
        e.preventDefault();
        this.submit(e.target).catch((err) => this.fail(err));
      }
    });
  }
  async init() {
    try {
      this.project = await loadProject();
    } catch (e) {
      this.project = blankProject();
      this.error = e.message;
    }
    await this.refreshProviders();
  }
  async refreshProviders() {
    try {
      const r = await fetch('/api/status');
      const s = await r.json();
      this.serverReady = s.ok && s.appId === 'csa-pdf-workbench';
      this.providers = s.providers || [];
      if (!this.providerId || !this.providers.some((x) => x.id === this.providerId))
        this.providerId = this.providers[0]?.id || '';
    } catch {
      this.serverReady = false;
      this.providers = [];
    }
  }
  fail(error) {
    this.error = error.message || String(error);
    this.busy = false;
    this.redraw();
    this.toast(this.error);
  }
  currentQuestion() {
    return this.questions.find((q) => q.id === this.focusId);
  }
  currentResult() {
    return this.project.results.find((r) => r.questionId === this.focusId);
  }
  isQuestionAssessable(question) {
    return canInitialAssess(question) && isLibraryQuestion(question, this.questionLibrary);
  }
  async render(params = new URLSearchParams()) {
    const q = params.get('question');
    if (
      q &&
      isFullProject(this.project) &&
      !this.project.reports.length &&
      !this.project.results.length &&
      this.data.industries.some((i) => i.code === q.slice(0, 3))
    ) {
      this.project.industry = q.slice(0, 3);
      this.project.selected = [];
    }
    [this.questions, this.questionLibrary] = await Promise.all([
      this.getData('questions-' + this.project.industry),
      this.getData('question-primary'),
    ]);
    this.project.selected = this.project.selected.filter((id) =>
      this.questions.some((question) => question.id === id && this.isQuestionAssessable(question)),
    );
    if (this.project.results.some((r) => !this.questions.some((q) => q.id === r.questionId)))
      throw new Error('项目包含本版未收录的问题编号。');
    if (q) {
      const found = this.questions.find((x) => x.id === q);
      if (found) {
        this.focusId = q;
        if (isFullProject(this.project) && !this.project.results.length && this.isQuestionAssessable(found) && !this.project.selected.includes(q))
          this.project.selected.push(q);
      } else
        this.error = `所选问题 ${q} 与当前项目行业 ${this.project.industry} 不同。请建立对应行业项目后查询。`;
    }
    if (!this.project.selected.length && isFullProject(this.project))
      this.project.selected = this.questions.filter((q) => this.isQuestionAssessable(q)).map((q) => q.id);
    this.redraw();
    document.title = '评估工作台 · CSA 评级知识库';
  }
  redraw() {
    if (location.hash.includes('/workbench')) this.main.innerHTML = renderWorkbench(this);
  }
  async findEvidence(question, chunks, custom = '') {
    return { evidence: searchEvidence(question, chunks, custom),
      retrieval: { mode: 'keyword', chunkVersion: CHUNK_VERSION, at: new Date().toISOString() } };
  }

  async save() {
    this.project.savedAt = new Date().toISOString();
    try {
      await saveProject(this.project);
    } catch (e) {
      this.project.savedAt = null;
      throw e;
    }
    this.dirty = false;
    this.redraw();
    this.toast('项目、原 PDF 和人工意见已保存到当前浏览器。');
  }
  async backup() {
    const p = {
      ...this.project,
      reports: this.project.reports.map(({ blob, ...r }) => r),
      backupNotice: '不含原 PDF；恢复后需要使用相同 SHA-256 的原文件重新关联。',
      backupAt: new Date().toISOString(),
    };
    await download(`CSA-${this.project.name || '项目'}-备份.json`, JSON.stringify(p));
    this.toast('已生成项目备份；原 PDF 请另行保留。');
  }
  async click(b) {
    const act = b.dataset.wb;
    if (
      this.busy &&
      !['cancel', 'pause', 'resume', 'pdf', 'backup', 'dismiss', 'close-detail', 'focus', 'step'].includes(act)
    )
      return;
    if (act === 'step') {
      this.step = Number(b.dataset.step);
      this.redraw();
    }
    if (act === 'dismiss') {
      this.error = '';
      this.redraw();
    }
    if (act === 'save') await this.save();
    if (act === 'clear-pdf-cache') {
      const response = await fetch('/api/native-pdf-cache/clear', { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '缓存清理失败。');
      this.toast('读取与初评缓存已清除，已保存项目和人工备注保留。');
    }
    if (act === 'save-note') await this.saveNote(b.dataset.id);
    if (act === 'backup') await this.backup();
    if (act === 'new') {
      if (this.project.reports.length || this.project.results.length || !isFullProject(this.project)) await this.backup();
      this.project = blankProject();
      this.focusId = '';
      this.step = 1;
      await this.render();
      await this.save();
    }
    if (act === 'reset-results') {
      requireFullProject(this.project);
      await this.backup();
      this.project.results = [];
      this.focusId = '';
      this.step = 1;
      this.redraw();
      await this.save();
    }
    if (act === 'select-all') {
      requireFullProject(this.project);
      this.project.selected = this.questions.filter((q) => this.isQuestionAssessable(q)).map((q) => q.id);
      this.redraw();
    }
    if (act === 'select-none') {
      requireFullProject(this.project);
      this.project.selected = [];
      this.redraw();
    }
    if (act === 'remove-report') {
      requireFullProject(this.project);
      this.project.reports = this.project.reports.filter((r) => r.id !== b.dataset.report);
      this.markNativeInputsChanged();
      this.redraw();
    }
    if (act === 'run') await this.run();
    if (act === 'page') {
      this.page = Number(b.dataset.page);
      this.redraw();
    }
    if (act === 'focus') {
      this.focusId = b.dataset.id;
      this.redraw();
      this.main
        .querySelector('#question-detail')
        ?.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
    if (act === 'close-detail') {
      this.focusId = '';
      this.redraw();
    }
    if (act === 'to-review') {
      this.step = 3;
      this.redraw();
      this.main.querySelector('#question-detail')?.scrollIntoView();
    }
    if (this.nativeActive && ['pause', 'resume', 'cancel'].includes(act)) {
      if (act === 'cancel') this.abort = true;
      if (this.nativeJobId) await controlPdfJob(this.nativeJobId, act === 'cancel' ? 'stop' : act);
      this.nativePaused = act === 'pause';
      this.redraw();
      this.toast(act === 'cancel' ? '当前请求完成后停止，已完成部分会保留。' : this.nativePaused ? '当前请求完成后暂停后续调用。' : '继续处理。');
      return;
    }
    if (act === 'cancel') {
      this.abort = true;
      this.queue?.stop();
      this.toast('正在完成当前请求，之后停止。');
    }
    if (act === 'pause') { this.queue?.pause(); this.redraw(); }
    if (act === 'resume') { this.queue?.resume(); this.redraw(); }
    if (act === 'model-one') await this.models([this.currentResult()]);
    if (act === 'model-all') await this.models(this.project.results);
    if (act === 'model-retry') await this.models(this.project.results.filter((r) => r.status === 'error'));
    if (act === 'pdf') this.pdf(b.dataset.report, Number(b.dataset.pdfPage) || 1);
    if (act === 'export') await this.excel();
    if (act === 'methodology-export') await this.exportAssessmentMethod();
  }
  async exportAssessmentMethod() {
    const selected = new Set(this.project.selected);
    const [translations, library, methodSchema] = await Promise.all([
      this.getData('question-translations'),
      this.getData('question-primary'),
      this.getData('assessment-method-schema'),
    ]);
    const industry = this.data.industries.find((item) => item.code === this.project.industry);
    const questions = this.questions.filter((question) => selected.has(question.id) && this.isQuestionAssessable(question));
    if (!questions.length) throw new Error('请先选择可评估的问题，再导出本次 AI 方法依据。');
    const sheet = assessmentMethodSheet(industry, questions, translations, library, methodSchema, 'AI方法依据');
    await downloadXlsx(
      `CSA-${this.project.name || '项目'}-${industry.code}-2026Full-AI方法依据.xlsx`,
      buildXlsx([sheet]),
    );
    this.toast(`已导出本次选定的 ${questions.length} 项方法依据；字段与发送给 GLM 的方法内容一致。`);
  }
  async change(el) {
    if (this.busy) { this.toast('请等待当前任务完成，或停止后续任务。'); return; }
    if (el.closest('[data-wb-form=review]') && el.name) {
      const r = this.currentResult();
      r.reviewDraft = { ...r.reviewDraft, [el.name]: el.value };
      this.dirty = true;
    }
    if (el.dataset.nativeCacheMode !== undefined) { this.nativeCacheMode = el.value; return; }
    if (el.dataset.project) {
      requireFullProject(this.project);
      const key = el.dataset.project;
      if (this.busy) return;
      this.project[key] = el.value;
      if (['industry', 'listed'].includes(key)) {
        this.project.selected = [];
        this.focusId = '';
        this.questions = await this.getData('questions-' + this.project.industry);
        if (isFullProject(this.project))
          this.project.selected = this.questions.filter((q) => this.isQuestionAssessable(q)).map((q) => q.id);
        this.redraw();
      }
    }
    if (el.dataset.questionCheck) {
      requireFullProject(this.project);
      const id = el.dataset.questionCheck;
      if (el.checked && !this.project.selected.includes(id)) this.project.selected.push(id);
      else if (!el.checked) this.project.selected = this.project.selected.filter((x) => x !== id);
    }
    if (el.dataset.reportPublic) {
      requireFullProject(this.project);
      const r = this.project.reports.find((x) => x.id === el.dataset.reportPublic);
      r.public = el.checked;
      this.markNativeInputsChanged();
    }
    if (el.dataset.reportUrl) {
      requireFullProject(this.project);
      this.project.reports.find((x) => x.id === el.dataset.reportUrl).sourceUrl = el.value.trim();
      this.markNativeInputsChanged();
    }
    if (el.dataset.reportField) {
      requireFullProject(this.project);
      const report = this.project.reports.find((r) => r.id === el.dataset.reportId);
      if (report) {
        report[el.dataset.reportField] = el.value;
          this.markNativeInputsChanged();
        this.dirty = true;
      }
    }
    if (el.dataset.provider !== undefined) this.providerId = el.value;
    if (el.dataset.evidenceCheck) {
      const r = this.currentResult();
      r.selectedEvidenceIds = selectedEvidenceForResult(r);
      const id = el.dataset.evidenceCheck;
      r.selectedEvidenceIds = el.checked
        ? [...new Set([...r.selectedEvidenceIds, id])]
        : r.selectedEvidenceIds.filter((x) => x !== id);
      invalidateReview(r, '选用证据发生变化，请重新确认人工结论');
      this.dirty = true;
      this.redraw();
    }
    if (el.dataset.wbFile === 'backup') {
      const file = el.files[0];
      if (!file) return;
      if (file.size > 80 * 1024 * 1024) throw new Error('项目备份超过 80 MB。');
      const p = validateProject(JSON.parse(await file.text()));
      if (!this.data.industries.some((x) => x.code === p.industry))
        throw new Error('备份的行业代码不在本版 62 行业中。');
      const [qs, library] = await Promise.all([
        this.getData('questions-' + p.industry),
        this.getData('question-primary'),
      ]);
      if (
        p.selected.some((id) => !qs.some((q) => q.id === id && canInitialAssess(q) && isLibraryQuestion(q, library))) ||
        p.results.some(
          (r) => !p.selected.includes(r.questionId) || !qs.some((q) => q.id === r.questionId),
        )
      )
        throw new Error('备份包含本版未启用的问题编号，当前项目已保留。');
      if (this.project.results.length) await this.backup();
      this.project = p;
      this.focusId = '';
      await this.render();
      await this.save();
      this.toast('备份已恢复，需重新上传相同原 PDF 才能对照。');
    }
    if (el.dataset.wbFile === 'main' || el.dataset.wbFile === 'support') {
      const files = [...el.files];
      if (!files.length) return;
      await this.upload(files, el.dataset.wbFile);
    }
  }
  markNativeInputsChanged() {
    const p = this.project;
    if (!p.results.length) return;
    const reports = new Map(p.reports.map(r => [r.id, r]));
    for (const result of p.results) {
      if (!result.nativePdfStale) result.nativeHistory = [...(result.nativeHistory || []), {
        current: result.current, nativeRemark: result.nativeRemark,
        evidence: result.evidence, modelAt: result.modelAt, at: new Date().toISOString(),
      }];
      result.nativePdfStale = true;
      result.evidence = result.evidence.filter(e => reports.has(e.reportId)).map(e => {
        const report = reports.get(e.reportId);
        return { ...e, public: report.public === true, sourceUrl: report.sourceUrl || '',
          documentType: report.documentType || '', documentPeriod: report.documentPeriod || '' };
      });
      const available = new Set(result.evidence.map(e => e.id));
      result.selectedEvidenceIds = (result.selectedEvidenceIds || []).filter(id => available.has(id));
      result.current = '材料已更新，请重新生成初评；原有人工备注已保留。';
      result.nativeRemark = '';
      result.modelIssues = [];
      result.nativeDraftStatus = 'needs_review';
      result.status = 'candidate';
    }
    p.nativePdfNeedsRefresh = true;
    this.dirty = true;
  }
  async upload(files, role) {
    if (this.busy) throw new Error('请等待当前处理完成。');
    if (!this.serverReady)
      throw new Error('PDF 识别服务未启动，请通过“启动 CSA 工作台.command”打开。');
    for (const file of files)
      if (!/\.pdf$/i.test(file.name) || file.size === 0 || file.size > 80 * 1024 * 1024)
        throw new Error('请上传非空 PDF，单个文件最多 80 MB、1–500 页。');
    const hashes = [];
    for (const file of files) {
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      hashes.push(
        Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join(''),
      );
    }
    const prepared = prepareUploadPlan(
      this.project.reports,
      files,
      hashes,
      !isFullProject(this.project),
    );
    this.busy = true;
    this.error = '';
    try {
      for (const { file, sha } of prepared) {
        const matching = this.project.reports.find((r) => r.meta.originalSha256 === sha);
        if (matching) {
          matching.blob = file;
          this.toast('已根据文件指纹重新关联原 PDF。');
          continue;
        }
        if (this.project.reports.length >= 6) throw new Error('主要报告与佐证合计最多 6 份。');
        this.progress = `正在识别 ${file.name}`;
        this.progressTotal = 0;
        this.redraw();
        const resp = await fetch('/api/parse-pdf', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/pdf',
            'X-File-Name': encodeURIComponent(file.name),
          },
          body: file,
        });
        const job = await resp.json();
        if (!resp.ok) throw new Error(job.error || 'PDF 上传失败。');
        let result;
        for (let i = 0; i < 1500; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          const rr = await fetch('/api/pdf-jobs/' + encodeURIComponent(job.jobId));
          const status = await rr.json();
          if (!rr.ok || status.status === 'failed')
            throw new Error(status.error || 'PDF 识别失败。');
          if (status.status === 'completed') {
            result = status.result;
            break;
          }
          this.progress = `${file.name} · ${status.phase}`;
          this.progressDone = status.completed;
          this.progressTotal = status.total;
          this.redraw();
        }
        if (!result) throw new Error('识别等待超时，请稍后重试。');
        const old = this.project.reports.find(
          (r) => r.meta.originalSha256 === result.meta.originalSha256,
        );
        if (old) {
          old.blob = file;
          this.toast('已根据文件指纹重新关联原 PDF。');
          continue;
        }
        if (this.project.reports.length >= 6)
          throw new Error('主要报告与佐证合计最多 6 份，请先移除不需要的资料。');
        this.project.reports.push({
          id: crypto.randomUUID(),
          name: file.name,
          role,
          documentType: 'unspecified',
          documentPeriod: '',
          public: false,
          sourceUrl: '',
          blob: file,
          meta: result.meta,
          warnings: result.warnings || [],
        });
        this.markNativeInputsChanged();
      }
    } finally {
      this.busy = false;
      this.progress = '';
      this.progressTotal = 0;
      this.redraw();
      await this.save();
    }
  }
  validateScope() {
    const p = this.project;
    requireFullProject(p);
    if (!p.name.trim()) throw new Error('请填写企业名称。');
    if (!p.industryBasis.trim())
      throw new Error('请填写官方 CSA 行业确认依据；不能由企业名称推断。');
    if (!p.reportPeriod.trim()) throw new Error('请填写本次评估的报告期间。');
    if (!p.reports.some((r) => r.role === 'main'))
      throw new Error('请先上传至少一份主要报告 PDF。');
    if (p.reports.some((r) => r.public && !/^https?:\/\//i.test(r.sourceUrl || '')))
      throw new Error('已勾选公开的材料需填写可追溯的 HTTP／HTTPS 原网址。');
    if (!p.selected.length) throw new Error('请至少选择一个有依据的问题。');
    if (p.listed === 'unknown')
      throw new Error('请先确认上市身份，以决定 Flexible 问题的证据要求。');
  }
  async run() {
    this.validateScope();
    const provider = this.providers.find(p => p.id === this.providerId);
    if (provider?.nativePdf) return this.runNative(this.questions.filter(q =>
      this.isQuestionAssessable(q) && this.project.selected.includes(q.id)), provider);
    this.busy = true;
    this.retrievalBusy = true;
    this.error = '';
    this.abort = false;
    const chunks = createChunks(this.project.reports);
    const questions = this.questions.filter((q) => this.isQuestionAssessable(q) && this.project.selected.includes(q.id));
    const updated = new Map(this.project.results.map((r) => [r.questionId, r]));
    this.progressTotal = questions.length;
    this.progressDone = 0;
    this.queue = new TaskQueue(() => this.redraw());
    this.redraw();
    try {
      await this.queue.run(questions, async (q, i) => {
        this.progress = `检索 ${i + 1}/${questions.length} · ${qName(q)}`;
        this.redraw();
        const found = await this.findEvidence(q, chunks);
        if (this.queue.stopped) return;
        const result = initialResult(q, chunks, this.project, found.evidence);
        result.retrieval = found.retrieval;
        const methodHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
          this.project.industry, this.project.methodYear, this.project.version, this.project.listed,
          this.project.reportPeriod, q.sourceFile, q.page, q.endPage, q.weight, q.layout, q.guidance, q.disclosure,
        ])));
        result.methodContext = [...new Uint8Array(methodHash)].map((n) => n.toString(16).padStart(2, '0')).join('');
        const previous = updated.get(q.id);
        if (previous) {
          result.reviewHistory = previous.reviewHistory || [];
          const sourceState = (e) => [e.id, e.text, e.documentType, e.documentPeriod, e.role, e.public, e.requiresReview, e.contextComplete];
          const same = previous.methodContext === result.methodContext && JSON.stringify(previous.evidence.map(sourceState)) === JSON.stringify(result.evidence.map(sourceState));
          result.review = previous.review;
          if (same) {
            result.selectedEvidenceIds = selectedEvidenceForResult(previous);
            if (previous.reviewDraft) result.reviewDraft = previous.reviewDraft;
          } else {
            invalidateReview(result, '问题依据或候选原文发生变化，请对照本次材料重新确认');
            if (previous.reviewDraft?.opinion) result.reviewHistory = [...result.reviewHistory, {
              ...previous.reviewDraft, status: 'pending', draft: true,
              reason: '重新检索前的未提交草稿，仅供找回，不属于已确认意见', archivedAt: new Date().toISOString(),
            }];
          }
        }
        return result;
      }, async (result, q, done) => {
        updated.set(q.id, result);
        this.project.results = questions.map((item) => updated.get(item.id)).filter(Boolean);
        this.progressDone = done;
        this.project.savedAt = new Date().toISOString();
        await saveProject(this.project);
        this.redraw();
      });
      this.step = 2;
      this.focusId = this.project.results[0]?.questionId || '';
      this.page = 0;
    } finally {
      this.busy = false;
      this.retrievalBusy = false;
      this.progressTotal = 0;
      this.redraw();
    }
    await this.save();
    this.toast(this.abort ? '已停止检索，已完成的项目与原有意见保留。' : '候选原文已保存；请核对来源和检索方式，再进行人工复核。');
  }
  async runNative(questions, provider) {
    this.validateScope();
    if (!questions.length) throw new Error('请至少选择一个有依据的问题。');
    this.busy = true;
    this.modelBusy = true;
    this.error = '';
    this.abort = false;
    this.progressTotal = questions.length;
    this.progressDone = 0;
    this.nativeActive = true;
    this.nativeJobId = '';
    this.nativePaused = false;
    this.progress = '正在准备 GLM PDF 逐页读取…';
    this.redraw();
    const updated = new Map(this.project.results.map(r => [r.questionId, r]));
    try {
      const documents = await nativeDocuments(this.project, progress => { this.progress = progress; this.redraw(); });
      if (this.abort) { this.toast('已停止准备，未发送新的 GLM 请求。'); return; }
      const answer = await analyzePdfBatch(questions.map(q => q.id), this.project, provider, documents,
        progress => { this.progress = progress; this.redraw(); }, { cacheMode: this.nativeCacheMode || 'normal',
          onJob: async id => { this.nativeJobId = id; if (this.abort) await controlPdfJob(id, 'stop'); else if (this.nativePaused) await controlPdfJob(id, 'pause'); },
          onState: state => { this.nativePaused = state.paused === true; } });
      this.project.nativePdfRun = { usage: answer.usage, pipeline: answer.pipeline, completedAt: answer.completedAt };
      for (const question of questions) {
        const item = answer.results.find(r => r.questionId === question.id);
        const result = updated.get(question.id) || initialResult(question, [], this.project, []);
        applyPdfRemark(result, item, answer, provider, this.project);
        result.nativePdfStale = false;
        updated.set(question.id, result);
      }
      this.project.results = this.questions.map(q => updated.get(q.id)).filter(Boolean);
      this.project.nativePdfNeedsRefresh = this.project.results.some(r => r.nativePdfStale);
      this.progressDone = questions.length;
      this.project.savedAt = new Date().toISOString();
      await saveProject(this.project);
      this.redraw();
      this.step = 2;
      this.focusId = '';
      this.page = 0;
    } catch (error) {
      if (!this.abort) throw error;
    } finally {
      this.nativeActive = false;
      this.nativePaused = false;
      this.nativeJobId = '';
      this.nativeCacheMode = 'normal';
      this.busy = false;
      this.modelBusy = false;
      this.progressTotal = 0;
      this.redraw();
    }
    await this.save();
    this.toast(this.abort ? '已停止后续调用，已完成部分保存在本机断点；继续初评可恢复。' : '原 PDF 初评完成。可直接添加备注，或打开原文核对。');
  }
  async saveNote(id) {
    const result = this.project.results.find(r => r.questionId === id);
    if (!result) throw new Error('此问题尚无初评结果。');
    const opinion = String(result.reviewDraft?.opinion ?? result.review?.opinion ?? '').trim();
    result.review = { status: opinion ? 'noted' : 'pending', opinion,
      reviewer: result.review?.reviewer || '', updated: new Date().toISOString() };
    delete result.reviewDraft;
    await this.save();
    this.toast(opinion ? '备注已保存。' : '备注已清空。');
  }
  async submit(form) {
    const kind = form.dataset.wbForm,
      f = new FormData(form);
    if (kind === 'provider') {
      const value = Object.fromEntries(f.entries());
      const r = await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      const j = await r.json();
      form.querySelector('[name=apiKey]').value = '';
      if (!r.ok) throw new Error(j.error || '连接配置失败。');
      await this.refreshProviders();
      this.providerId = j.provider.id;
      this.redraw();
      this.toast('模型连接已记录到服务内存，首次分析时验证响应。');
    }
    if (kind === 'search') {
      requireFullProject(this.project);
      const r = this.currentResult(),
        q = this.currentQuestion();
      r.query = String(f.get('query') || '');
      this.busy = true;
      this.progress = '正在补充检索原文…';
      this.redraw();
      try {
        const selected = selectedEvidenceForResult(r);
        const found = await this.findEvidence(q, createChunks(this.project.reports), r.query);
        const existing = new Set(r.evidence.map((x) => x.id));
        const extra = found.evidence.filter((x) => !existing.has(x.id));
        r.evidence.push(...extra);
        r.evidence = r.evidence.slice(0, 24);
        r.selectedEvidenceIds = selected;
        if (extra.length) invalidateReview(r, '补充检索发现新候选，请确认其与已复核证据的关系');
        r.retrieval = found.retrieval;
      } finally { this.busy = false; this.redraw(); }
      await this.save();
      this.toast('已补充检索，勾选与本题直接相关的原文。');
    }
    if (kind === 'review') {
      const r = this.currentResult();
      if (f.get('status') !== 'pending' && !String(f.get('opinion') || '').trim())
        throw new Error('完成复核需填写意见及依据；不适用需说明理由。');
      r.review = {
        status: String(f.get('status')),
        opinion: String(f.get('opinion') || ''),
        reviewer: String(f.get('reviewer') || ''),
        updated: new Date().toISOString(),
      };
      delete r.reviewDraft;
      await this.save();
      this.toast('本题人工意见已保存。');
    }
  }
  async models(results) {
    requireFullProject(this.project);
    const provider = this.providers.find((p) => p.id === this.providerId);
    if (!provider) throw new Error('请先配置并选择模型。');
    const list = results.filter(Boolean);
    if (!list.length) { this.toast('没有需要重试的失败项。'); return; }
    if (list.some((r) => !this.questions.some((q) => q.id === r.questionId && this.isQuestionAssessable(q))))
      throw new Error('选题缺少完整方法依据，不可运行模型初评。');
    if (provider.nativePdf) return this.runNative(list.map(r => this.questions.find(q => q.id === r.questionId)), provider);
    this.busy = true;
    this.modelBusy = true;
    this.abort = false;
    this.error = '';
    this.progressTotal = list.length;
    this.progressDone = 0;
    this.queue = new TaskQueue(() => this.redraw());
    const chunkCount = createChunks(this.project.reports).length;
    const translations = await this.getData('question-translations');
    try {
      await this.queue.run(list, async (result, i) => {
        const question = this.questions.find((q) => q.id === result.questionId);
        this.progress = `模型分析 ${i + 1}/${list.length} · ${qName(question)}`;
        this.redraw();
        return analyzeQuestion(question, result, this.project, provider, chunkCount, translations);
      }, async (result, item, done) => {
        this.progressDone = done;
        this.project.savedAt = new Date().toISOString();
        await saveProject(this.project);
        this.redraw();
      });
    } finally {
      this.busy = false;
      this.modelBusy = false;
      this.progressTotal = 0;
      this.redraw();
    }
    await this.save();
    this.toast(this.abort ? '已停止后续项目，已完成结果保存。' : '模型初评结束，请核对校验提示并人工复核。');
  }
  pdf(id, page = 1) {
    const r = this.project.reports.find((x) => x.id === id);
    if (!r?.blob) {
      this.toast('项目备份不含原 PDF，请在第一步重新上传相同原文件。');
      return;
    }
    const originalUrl = URL.createObjectURL(r.blob),
      dialog = document.createElement('dialog'),
      total = r.meta.pages.length;
    let imageUrl = '',
      generation = 0,
      current = Math.min(total, Math.max(1, page));
    dialog.innerHTML = `<header><h2>${esc(r.name)} · 原 PDF 对照</h2><button class="btn small-btn" data-preview-close autofocus>关闭</button></header><div class="pdf-controls"><button class="btn small-btn" data-preview-prev>上一页原 PDF</button><form><label>PDF 物理页<input type="number" min="1" max="${total}" value="${current}" aria-label="PDF 物理页码"></label><button class="btn small-btn">跳转</button><span class="small">共 ${total} 页</span></form><button class="btn small-btn" data-preview-next>下一页原 PDF</button><button class="text-button" data-preview-zoom aria-pressed="false">放大查看</button></div><p class="small">直接显示上传原文件的页面图像；本机生成预览，不是文字识别结果。<a data-preview-original target="_blank" rel="noopener">打开完整原 PDF</a></p><p role="status" data-preview-status>正在生成原页预览…</p><div class="pdf-image-wrap"></div>`;
    const img = document.createElement('img'),
      status = dialog.querySelector('[data-preview-status]'),
      input = dialog.querySelector('input'),
      prev = dialog.querySelector('[data-preview-prev]'),
      next = dialog.querySelector('[data-preview-next]'),
      form = dialog.querySelector('form');
    const show = async (value) => {
      if (!Number.isInteger(value) || value < 1 || value > total) {
        status.textContent = '页码超出范围，请输入 1–' + total + '。';
        return;
      }
      current = value;
      const token = ++generation;
      input.value = value;
      prev.disabled = true;
      next.disabled = true;
      form.querySelector('button').disabled = true;
      img.hidden = true;
      status.textContent = '正在生成 PDF 第 ' + value + ' 页原页预览…';
      dialog.querySelector('[data-preview-original]').href = originalUrl + '#page=' + value;
      try {
        const resp = await fetch('/api/render-pdf-page', {
          method: 'POST',
          headers: { 'Content-Type': 'application/pdf', 'X-PDF-Page': String(value) },
          body: r.blob,
        });
        if (!resp.ok) {
          const error = await resp.json();
          throw new Error(error.error || '原页预览失败。');
        }
        const blob = await resp.blob();
        if (token !== generation || !dialog.open) return;
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        imageUrl = URL.createObjectURL(blob);
        img.src = imageUrl;
        img.alt = r.name + '，PDF 物理第 ' + value + ' 页原文图像';
        img.hidden = false;
        dialog.querySelector('.pdf-image-wrap').replaceChildren(img);
        status.textContent = 'PDF 第 ' + value + ' / ' + total + ' 页 · 原文件页面';
      } catch (error) {
        if (token === generation)
          status.textContent = error.message + ' 可使用上方完整原 PDF 入口。';
      } finally {
        if (token === generation) {
          prev.disabled = current === 1;
          next.disabled = current === total;
          form.querySelector('button').disabled = false;
        }
      }
    };
    dialog.querySelector('[data-preview-close]').onclick = () => dialog.close();
    prev.onclick = () => show(current - 1);
    next.onclick = () => show(current + 1);
    form.onsubmit = (e) => {
      e.preventDefault();
      show(Number(input.value));
    };
    dialog.querySelector('[data-preview-zoom]').onclick = (e) => {
      const zoom = dialog.querySelector('.pdf-image-wrap').classList.toggle('is-zoom');
      e.currentTarget.setAttribute('aria-pressed', String(zoom));
      e.currentTarget.textContent = zoom ? '适应宽度' : '放大查看';
    };
    dialog.addEventListener(
      'close',
      () => {
        generation++;
        URL.revokeObjectURL(originalUrl);
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        dialog.remove();
      },
      { once: true },
    );
    document.body.append(dialog);
    dialog.showModal();
    show(current);
  }
  async excel() {
    const p = this.project;
    if (p.results.some(r => r.mode === 'native-pdf')) {
      const result = await downloadXlsx(`CSA-${p.name || '项目'}-${p.methodYear}-评估备注.xlsx`, buildXlsx([
        { name: '评估备注', rows: remarkRows(p, this.questions), freezeRows: 1, autoFilter: true, wrap: true,
          columnWidths: [16, 26, 40, 68, 68, 68, 24], fitRowHeight: true, maxRowHeight: 409 },
        { name: '项目资料', rows: [['项目', '内容'], ['企业', p.name], ['CSA 行业', p.industry],
          ['行业依据', p.industryBasis], ['方法', `${p.methodYear} ${p.version}`], ['报告期间', p.reportPeriod],
          ['初评完整性', `已选 ${p.selected.length} 项，已生成 ${p.results.filter(r => p.selected.includes(r.questionId)).length} 项草稿；${p.selected.some(id => !p.results.some(r => r.questionId === id)) ? '尚未完成全量初评' : '选题均有草稿，仍待人工确认'}`],
          ['声明', '披露初评备注，不是标普官方评分。未提交的备注草稿不进入本表。'],
          ...p.reports.map(r => [r.name, `${r.documentPeriod || '期间待确认'} · SHA-256 ${r.meta.originalSha256}`])],
          wrap: true, columnWidths: [26, 100], fitRowHeight: true, maxRowHeight: 409 },
      ]));
      this.toast('评估备注 Excel 已生成。');
      const link = document.createElement('a');
      link.href = result.url; link.download = result.filename; link.className = 'text-button';
      link.textContent = '再次下载备注 Excel'; this.main.querySelector('.section-box')?.append(link);
      return;
    }
    const metadata = [
      ['字段', '内容'],
      ['企业', p.name],
      ['官方CSA行业', p.industry],
      ['行业确认依据', p.industryBasis],
      ['方法年度', p.methodYear],
      ['项目评估年度（不是已发布官方分数年度）', p.scoreYear],
      ['本次评估报告期间', p.reportPeriod],
      ['目标披露期间', p.targetPeriod],
      ['问卷版本', p.version],
      ['声明', '披露初评，不是标普官方得分。方法来自2026行业Handbook，实际适用性以在线问卷为准。'],
      ['说明', '未找到候选证据不代表企业未披露；人工不适用仍待官方确认。'],
      ['条目编号', '本站条目 ID 是本地索引，非已核实的门户题号；门户题号未取得。'],
      [
        '权重与粒度',
        '逐项证据与复核每行是一条证据片段；同一标准权重会重复，不能按证据行相加，也不是题目权重。维度标准汇总按唯一标准列出 Full 权重。',
      ],
      ['计分边界', '完整官方题目层权重及不适用后的权重分配规则未纳入计算；不输出官方 CSA Score。'],
      ['生成时间', new Date().toISOString()],
    ];
    const sourceRows = [
      [
        '资料',
        '角色',
        '资料类型（用户填写）',
        '该资料覆盖期间／信息时点（用户填写）',
        '公开状态',
        '原网址',
        'PDF页数',
        '已处理页',
        '可识别内容页',
        '表格数量',
        'SHA-256',
        '识别提醒',
      ],
      ...p.reports.map((r) => [
        r.name,
        reportMetadata(r).role,
        reportMetadata(r).documentType,
        reportMetadata(r).documentPeriod,
        r.public ? '用户确认公开' : '内部／未确认公开',
        r.sourceUrl,
        r.meta.pageCount,
        r.meta.processedPages,
        r.meta.readablePages,
        r.meta.tableCount,
        r.meta.originalSha256,
        (r.warnings || []).join('\n'),
      ]),
    ];
    const ind = this.data.industries.find((i) => i.code === p.industry);
    const summaryRow = (c) => {
      const qs = this.questions.filter((q) => q.criterion === c.name),
        ids = new Set(qs.map((q) => q.id)),
        rs = p.results.filter((r) => ids.has(r.questionId));
      return [
        dimNames[c.dimension] || c.dimension,
        c.zh,
        c.name,
        c.weight,
        rs.length,
        rs.filter((r) => r.review.status !== 'pending').length,
        p.methodYear,
        'Full（权重来源版本）',
        p.version,
        ind.sourceFile,
        ind.sourcePage,
      ];
    };
    const summaries = [
      [
        '维度',
        '标准',
        '标准英文名',
        '唯一标准权重（占总分%；每个标准仅一行）',
        '本项目初评问题数',
        '人工已复核数',
        '方法年度',
        '权重来源版本',
        '项目问卷版本',
        '权重来源 PDF',
        '权重来源 PDF 页',
      ],
      ...ind.criteria.map(summaryRow),
    ];
    const result = await downloadXlsx(
      `CSA-${p.name || '项目'}-${p.methodYear}-披露初评与复核.xlsx`,
      buildXlsx([
        { name: '项目范围', rows: metadata, freezeRows: 1, wrap: true },
        { name: '维度标准汇总', rows: summaries, freezeRows: 1, autoFilter: true, wrap: true },
        {
          name: '逐项证据与复核',
          rows: exportRows(p, this.questions),
          freezeRows: 1,
          autoFilter: true,
          wrap: true,
          columnWidths: Array(40).fill(24),
        },
        { name: '报告来源与解析', rows: sourceRows, freezeRows: 1, wrap: true },
      ]),
    );
    this.toast('CSA 层级 Excel 已生成，含原文、页码、证据选用状态和本题级人工意见。');
    const a = document.createElement('a');
    a.href = result.url;
    a.download = result.filename;
    a.textContent = '再次下载刚生成的 Excel';
    a.className = 'text-button';
    this.main.querySelector('.section-box')?.append(a);
  }
}
