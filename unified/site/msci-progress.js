/** Pure progress copy plus a small DOM update; waiting must not redraw 141 rows. */
export function readingStatus(data, now = Date.now()) {
  if (!data) return '';
  const parts = [`全文读取 ${data.processedPages || 0} / ${data.totalPages || 0} 页`];
  if (data.cachedPages) parts.push(`复用 ${data.cachedPages} 页`);
  if (data.readingComplete) {
    parts.push('已完成');
    const request = data.activity?.requests?.find(r => r.phase === 'assessment');
    if (request) parts.push(`当前评估批次 · 已等待${Math.max(0, Math.floor(now / 1000 - request.startedAt))}秒`);
  }
  else if (data.phase === 'paused') parts.push('已暂停');
  else if (data.phase === 'stopped') parts.push('已停止');
  else if (data.phase === 'failed') parts.push('读取未完成');
  else {
    const requests = data.activity?.requests || [];
    if (requests.length) parts.push(requests.map(r => {
      const seconds = Math.max(0, Math.floor(now / 1000 - r.startedAt));
      const elapsed = seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
      return `${r.label || '当前批次'} · 已等待${elapsed}`;
    }).join('；'));
    else parts.push('正在准备下一批');
  }
  return parts.join(' · ');
}

export function updateReadingProgress(data) {
  if (!data) return;
  const label = document.querySelector('#wbReadingStatus');
  if (label) {
    label.setAttribute('aria-live', 'off');
    label.textContent = readingStatus(data);
  }
  if (!data.readingComplete) {
    const progress = document.querySelector('#wbProgress');
    if (progress) {
      progress.max = data.totalPages || 1;
      progress.value = data.processedPages || 0;
      progress.setAttribute('aria-label', '全文读取进度');
    }
    const status = document.querySelector('#wbProgressText');
    if (status) status.textContent = data.phase === 'failed'
      ? `全文读取未完成：${data.error || '请重试未完成部分。'}`
      : data.phase === 'stopped' ? '已停止，完成的页面可在下次运行时复用。'
      : data.phase === 'paused' ? '已暂停，点击继续后读取剩余页面。'
      : `正在阅读全文，完成后评估 ${data.total || 0} 项指标。已收到 ${data.calls || 0} 次模型响应。`;
  } else {
    document.querySelector('#wbProgress')?.setAttribute('aria-label', '指标处理进度');
  }
}
