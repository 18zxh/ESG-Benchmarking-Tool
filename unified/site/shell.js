/* Shared presentation; native domain content and handlers remain in place. */
(() => {
  'use strict';
  const engine = document.currentScript.dataset.module;
  const entries = {
    csa: ['/csa/', 'questions', 'workbench', 'CSA'],
    msci: ['/msci/', 'issues', 'workbench', 'MSCI'],
    mainland: ['/exchange/', 'mainland/knowledge', 'mainland/workbench', '大陆交易所'],
    hkex: ['/exchange/', 'hk/knowledge', 'hk/workbench', '港交所'],
    benchmark: ['/exchange/', 'benchmark', 'benchmark', '横向对标'],
  };
  const chapters = {
    csa: [['questions', '问题与证据'], ['methods', '方法文件'], ['weights', '行业权重'], ['resources', '资料与版本'], ['search', '知识查询'], ['home', '使用说明']],
    msci: [['issues', '关键议题'], ['symbols', '术语与符号'], ['methodology', '评级方法'], ['process', '评级流程'], ['history', '更新记录'], ['search', '知识查询']],
    mainland: [['mainland/knowledge', '指引与披露要求']],
    hkex: [['hk/knowledge', '指引与披露要求']],
  };
  const descriptions = {
    csa: '查阅方法文件、行业权重及问题要求，核对原文与来源。',
    msci: '查阅评级方法、关键议题及指标定义，核对原文与来源。',
    mainland: '对照沪深北可持续发展指引，查阅适用安排、议题与条款。',
    hkex: '查阅附录 C2 的适用安排、ESG 披露与气候要求。',
  };
  const shapes = {
    folder: '<path d="M3 7h6l2-3h9v16H3z"/>',
    files: '<path d="M8 3h10v15H8zM4 7v14h10"/>',
    book: '<path d="M12 5v15M12 5C9 3 5 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-1-9 1Z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3z"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  };
  const icon = kind => '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + shapes[kind] + '</svg>';
  const route = () => location.hash.replace(/^#\/?/, '').split('?')[0] || (engine === 'csa' ? 'home' : 'issues');
  const moduleId = () => engine !== 'exchange' ? engine : route().startsWith('hk/') ? 'hkex' : route() === 'benchmark' ? 'benchmark' : 'mainland';
  function start() {
    const originalSidebar = document.querySelector('.sidebar, .app-sidebar');
    const header = document.querySelector('.topbar, .app-header');
    const main = document.querySelector('main');
    if (!originalSidebar || !header || !main) return;
    document.body.classList.add('u-native'); document.body.dataset.engine = engine;
    // Keep native navigation mounted for its routing code, apart from our drawer.
    originalSidebar.hidden = true;
    const sidebar = document.createElement('aside'); sidebar.className = 'u-sidebar'; sidebar.id = 'unified-sidebar';
    sidebar.setAttribute('aria-label', '应用导航'); originalSidebar.after(sidebar);
    const brand = document.createElement('a'); brand.href = '/#/projects'; brand.className = 'u-brand';
    brand.innerHTML = '<span class="u-mark" aria-hidden="true">E</span><span>ESG 工作台<small>本机评估与证据管理</small></span>';
    sidebar.prepend(brand);
    const nav = document.createElement('nav'); nav.className = 'u-global-nav'; nav.setAttribute('aria-label', '主导航'); sidebar.append(nav);
    const settings = document.createElement('a'); settings.href = '/#/settings'; settings.className = 'u-settings';
    settings.innerHTML = icon('settings') + '<span>设置</span>'; sidebar.append(settings);
    header.querySelector('.brand')?.setAttribute('hidden', '');
    header.querySelector('.nav-toggle')?.setAttribute('hidden', '');
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'u-menu'; toggle.innerHTML = icon('menu');
    toggle.setAttribute('aria-label', '展开导航'); toggle.setAttribute('aria-controls', sidebar.id); toggle.setAttribute('aria-expanded', 'false'); header.prepend(toggle);
    const crumb = document.createElement('span'); crumb.className = 'u-location'; toggle.after(crumb);
    const model = document.createElement('a'); model.href = '/#/settings'; model.className = 'u-model'; model.textContent = '模型设置'; header.append(model);
    const scrim = document.createElement('button'); scrim.type = 'button'; scrim.className = 'u-scrim'; scrim.setAttribute('aria-label', '关闭导航'); scrim.hidden = true; sidebar.after(scrim);
    const narrow = matchMedia('(max-width: 960px)');
    let opened = false;
    function setOpen(value, restore = true) {
      opened = value && narrow.matches;
      sidebar.classList.toggle('u-open', opened); sidebar.inert = narrow.matches && !opened;
      scrim.hidden = !opened; toggle.setAttribute('aria-expanded', String(opened)); toggle.setAttribute('aria-label', opened ? '收起导航' : '展开导航');
      main.inert = opened;
      header.querySelectorAll('form, .u-model').forEach(el => { el.inert = opened; });
      if (opened) sidebar.querySelector('a').focus();
      else if (restore && narrow.matches) toggle.focus();
    }
    toggle.addEventListener('click', () => setOpen(!opened)); scrim.addEventListener('click', () => setOpen(false));
    narrow.addEventListener('change', () => setOpen(false, false));
    document.addEventListener('keydown', event => {
      if (!opened) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setOpen(false); }
      if (event.key !== 'Tab') return;
      const items = [...sidebar.querySelectorAll('a[href],button:not(:disabled)')].filter(el => el.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }, true);
    sidebar.addEventListener('click', event => { if (event.target.closest('a[href]')) setOpen(false, false); });
    setOpen(false, false);
    const link = (href, label, kind, active = false) => '<a href="' + href + '"' + (active ? ' class="u-active" aria-current="page"' : '') + '>' + icon(kind) + '<span>' + label + '</span></a>';
    let current = '';
    const placements = new WeakMap();
    function restoreLayout() {
      main.querySelectorAll('[data-grid-placement]').forEach(el => {
        const source = el.dataset.gridPlacement;
        if (placements.get(el) === source) return;
        for (const declaration of source.split(';')) {
          const [property, value] = declaration.split(':').map(part => part.trim());
          if (['grid-column', 'grid-row'].includes(property) && /^-?\d+(?:\s*\/\s*(?:span\s+)?-?\d+)?$/.test(value)) el.style.setProperty(property, value);
        }
        placements.set(el, source);
      });
      main.querySelectorAll('.weight-bar > [data-weight]').forEach(el => {
        const value = Number(el.dataset.weight);
        if (Number.isFinite(value) && value >= 0 && value <= 100 && el.style.width !== value + '%') el.style.width = value + '%';
      });
    }
    function navigation() {
      const id = moduleId(), workbench = route().includes('workbench'), key = id + ':' + workbench;
      document.body.dataset.surface = workbench ? 'workbench' : id === 'benchmark' ? 'benchmark' : 'knowledge';
      crumb.textContent = id === 'benchmark' ? '横向对标' : entries[id][3] + ' / ' + (workbench ? '报告评估工作台' : id === 'benchmark' ? '横向对标' : '知识库');
      if (current === key) return;
      current = key;
      nav.innerHTML = link('/#/projects', '项目中心', 'folder') + link('/#/library', '资料库', 'files') +
        [['各标准', ['csa', 'msci']], ['各交易所', ['mainland', 'hkex']], ['对标分析', ['benchmark']]].map(([label, ids]) =>
          '<p class="u-nav-label">' + label + '</p>' + ids.map(item => {
            const p = entries[item];
            return link(p[0] + '#/' + p[1], p[3], 'book', id === item) + (id === item && item !== 'benchmark' ?
              '<div class="u-subnav"><a href="#/' + p[1] + '"' + (!workbench ? ' aria-current="page"' : '') + '>知识库</a><a href="#/' + p[2] + '"' + (workbench ? ' aria-current="page"' : '') + '>报告评估工作台</a></div>' : '');
          }).join('')).join('');
    }
    function decorate() {
      restoreLayout();
      navigation();
      const id = moduleId(), active = route(), workbench = active.includes('workbench');
      if (workbench) main.querySelector('#wbClearSaved')?.setAttribute('hidden', '');
      main.querySelectorAll('[data-wb="new"],#new-project,#benchmark-new').forEach(button => {
          if (button.textContent !== '新建项目') button.textContent = '新建项目';
        });
      if (workbench) {
        // Expose existing save/restore controls; keep their IDs and delegated handlers.
        const tools = main.querySelector('.wb-tools');
        if (tools && !tools.classList.contains('u-model-tools')) {
          tools.classList.add('u-model-tools');
          const actions = tools.querySelector('.wb-export-actions');
          const title = main.querySelector('.wb-heading');
          title.after(tools);
          if (actions) { actions.classList.add('u-project-toolbar'); tools.before(actions); }
        }
        main.querySelectorAll('nav[aria-label="评估步骤"] button, .wb-steps button, .step-nav button').forEach((button, index) => {
          const label = ["1 上传与选择", "2 自动初评", "3 人工复核"][index];
          if (label && button.textContent !== label) button.textContent = label;
        });
      }
      const host = engine === 'exchange' ? document.querySelector(id === 'hkex' ? '#hk-knowledge-view' : '#knowledge-view') : main;
      if (workbench || id === 'benchmark' || !host || host.hidden) { main.querySelectorAll('.u-knowledge-heading').forEach(el => el.remove()); return; }
      let heading = host.querySelector(':scope > .u-knowledge-heading');
      if (!heading) {
        heading = document.createElement('header'); heading.className = 'u-knowledge-heading';
        heading.innerHTML = '<h1></h1><p></p><nav class="u-chapters" aria-label="知识库栏目"></nav>'; host.prepend(heading);
      }
      if (heading.dataset.route !== active) {
        heading.dataset.route = active;
        heading.querySelector('h1').textContent = entries[id][3] + (engine === 'exchange' ? '' : ' ') + '知识库'; heading.querySelector('p').textContent = descriptions[id];
        heading.querySelector('nav').innerHTML = chapters[id].map(([path, label]) => '<a href="#/' + path + '"' +
          (active === path || (path === 'issues' && active.startsWith('issues/')) ? ' aria-current="page"' : '') + '>' + label + '</a>').join('');
      }
      host.querySelectorAll('h1').forEach(el => {
        if (!heading.contains(el) && !el.classList.contains('u-domain-title')) {
          el.classList.add('u-domain-title'); el.setAttribute('role', 'heading'); el.setAttribute('aria-level', '2');
        }
      });
    }
    let scheduled = false;
    new MutationObserver(() => {
      if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; decorate(); }); }
    }).observe(main, {childList:true, subtree:true});
    addEventListener('hashchange', () => { setOpen(false, false); decorate(); });
    decorate();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true}); else start();
})();
