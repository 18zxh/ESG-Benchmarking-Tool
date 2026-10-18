import { esc } from './core.js';

let toastTimer;
export function toast(message) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6000);
}
export function head(title, description) {
  return `<header class="page-head"><h1>${esc(title)}</h1><p class="lede">${description}</p></header>`;
}
export function options(items, value, all = '') {
  return (
    (all ? `<option value="">${esc(all)}</option>` : '') +
    items
      .map(
        ([v, t]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(t)}</option>`,
      )
      .join('')
  );
}
export function industryOptions(industries, value, all = '') {
  return options(
    industries.map((x) => [x.code, `${x.code} · ${x.zh}`]),
    value,
    all,
  );
}
export function table(headers, rows, cls = '') {
  return `<p class="table-scroll-hint small">宽表可左右滑动查看。</p><div class="table-wrap" tabindex="0" aria-label="可横向滚动的资料表格"><table class="data ${cls}"><thead><tr>${headers.map((x) => `<th scope="col">${x}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}
export function empty(message) {
  return `<p class="state-empty">${message}</p>`;
}
export function pageControls(page, total, size = 30) {
  const max = Math.max(1, Math.ceil(total / size));
  return `<div class="pager"><span>共 ${total} 条 · 第 ${page + 1} / ${max} 页</span><div class="actions"><button class="btn small-btn" data-page="${page - 1}" ${page <= 0 ? 'disabled' : ''}>上一页</button><button class="btn small-btn" data-page="${page + 1}" ${page + 1 >= max ? 'disabled' : ''}>下一页</button></div></div>`;
}
export function selectedIndustry(industries, code) {
  return industries.find((i) => i.code === code) || industries[0];
}
