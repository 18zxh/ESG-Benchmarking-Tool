import { esc } from './core.js';
import { getData, loadAppData } from './data-store.js';
import { routes, readRoute, updateParam, qsHref } from './router.js';
import { head, toast } from './ui.js';
import { renderHome } from './pages/home.js';
import { renderWeights, exportWeights } from './pages/weights.js';
import { renderQuestions, exportQuestions } from './pages/questions.js';
import { renderSearch } from './pages/search.js';
import { renderMethods } from './methods.js';

const main = document.querySelector('#main');
let data;
let renderId = 0;
let workbenchPromise;
let resourcesPromise;

// Controllers attach their listeners once, when their page is first opened.
function getWorkbench() {
  if (!workbenchPromise) {
    workbenchPromise = import('./workbench.js').then(async ({ Workbench }) => {
      const workbench = new Workbench(main, data, getData, toast);
      await workbench.init();
      return workbench;
    });
  }
  return workbenchPromise;
}

function getResources() {
  if (!resourcesPromise) {
    resourcesPromise = import('./resources.js').then(async ({ Resources }) => {
      return new Resources(main, data);
    });
  }
  return resourcesPromise;
}

function setNavigationOpen(open) {
  document.querySelector('#sidebar').classList.toggle('open', open);
  document.querySelector('#scrim').hidden = !open;
  document.querySelector('#nav-toggle').setAttribute('aria-expanded', String(open));
}

function renderNavigation(route) {
  document.querySelector('#nav').innerHTML =
    '<span class="nav-label">知识库与查询</span>' +
    routes
      .map(([key, name]) => {
        const group = key === 'workbench' ? '报告评估' : key === 'resources' ? '资料管理' : '';
        return `${group ? `<span class="nav-label">${group}</span>` : ''}
        <a href="#/${key}" class="${route === key ? 'active' : ''}" ${route === key ? 'aria-current="page"' : ''}><span>${name}</span></a>`;
      })
      .join('');
  setNavigationOpen(false);
}

async function render() {
  const id = ++renderId;
  const { route, params } = readRoute();
  renderNavigation(route);
  main.classList.toggle('view-wide', route === 'workbench');
  main.classList.toggle('workbench', route === 'workbench');
  try {
    let html;
    switch (route) {
      case 'home':
        html = renderHome();
        break;
      case 'methods':
        html = renderMethods(data);
        break;
      case 'weights':
        html = renderWeights(params, data);
        break;
      case 'questions':
        html = await renderQuestions(params, data, getData);
        break;
      case 'search':
        html = await renderSearch(params, data, getData);
        break;
      case 'resources': {
        const resources = await getResources();
        if (id !== renderId) return;
        html = resources.render(params);
        break;
      }
      case 'workbench': {
        const workbench = await getWorkbench();
        if (id !== renderId) return;
        await workbench.render(params);
        html = null;
        break;
      }
      default:
        html = head('页面未找到', '请从左侧导航选择页面。');
    }
    if (id !== renderId) return;
    if (html !== null) main.innerHTML = html;
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    const title = routes.find(([key]) => key === route)?.[1] || '搜索';
    document.title = `${title} · CSA 评级知识库`;
  } catch (error) {
    if (id === renderId) {
      main.innerHTML = `<div class="notice error" role="alert">${esc(error.message)}</div><a href="#/home" class="btn">回到概览</a>`;
    }
  }
}

function bindEvents() {
  document.querySelector('#nav-toggle').addEventListener('click', () => {
    setNavigationOpen(!document.querySelector('#sidebar').classList.contains('open'));
  });
  document.querySelector('#scrim').addEventListener('click', () => setNavigationOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setNavigationOpen(false);
  });
  document.querySelector('#global-search').addEventListener('submit', (event) => {
    event.preventDefault();
    location.hash = qsHref('search', { q: document.querySelector('#search-query').value.trim() });
  });
  main.addEventListener('submit', (event) => {
    if (!event.target.matches('[data-filter-search]')) return;
    event.preventDefault();
    updateParam('q', String(new FormData(event.target).get('q') || '').trim());
  });
  main.addEventListener('change', (event) => {
    const { param } = event.target.dataset;
    if (!param) return;
    if (param !== 'industry') {
      updateParam(param, event.target.value);
      return;
    }
    const { route, params } = readRoute();
    for (const key of ['dim', 'criterion', 'disclosure', 'q', 'page', 'id', 'company'])
      params.delete(key);
    params.set('industry', event.target.value);
    location.hash = `/${route}?${params}`;
  });
  main.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-page],[data-action]');
    if (!button) return;
    if (button.dataset.page !== undefined) {
      updateParam('page', button.dataset.page, false);
      return;
    }
    try {
      switch (button.dataset.action) {
        case 'export-weights':
          await exportWeights(readRoute().params, data);
          toast('权重 Excel 已生成。');
          break;
        case 'export-questions':
          await exportQuestions(button, data, getData, readRoute().params.get('industry') || 'CON');
          toast('当前行业的评级方法与 AI 依据 Excel 已导出。');
          break;
      }
    } catch (error) {
      toast(error.message || '导出失败，请重试。');
    }
  });
  window.addEventListener('hashchange', render);
}

async function start() {
  try {
    data = await loadAppData();
    bindEvents();
    await render();
  } catch (error) {
    main.innerHTML = `<h1>无法载入网站</h1><div class="notice error" role="alert">${esc(error.message)}</div><p>请双击网站目录中的“启动 CSA 工作台.command”，通过本机地址使用网站。</p>`;
  }
}

start();
