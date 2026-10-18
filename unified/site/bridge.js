/* Compatibility transport only; the three original interfaces keep their layout. */
(() => {
  'use strict';
  const module = document.currentScript.dataset.module;
  const rawFetch = globalThis.fetch.bind(globalThis);
  const params = new URLSearchParams(location.search);
  let group = params.get('project');
  if (!group || !/^[A-Za-z0-9_-]{1,100}$/.test(group)) {
    group = crypto.randomUUID().replaceAll('-', '');
    params.set('project', group);
    history.replaceState(null, '', location.pathname + '?' + params + location.hash);
  }
  let contextPromise, edits = 0, savedEdit = 0;
  const mounted = new Set();
  const moduleId = () => module !== 'exchange' ? module : location.hash.startsWith('#/hk/') ? 'hkex' : location.hash.startsWith('#/benchmark') ? 'benchmark' : 'mainland';
  const inWorkbench = () => location.hash.split('?')[0].includes('workbench') || moduleId() === 'benchmark';
  function dirty() { return edits !== savedEdit; }
  document.addEventListener('input', event => {
    if (inWorkbench() && event.isTrusted && event.target.closest('main') && !event.target.closest('form[data-wb-form="provider"],#provider-form,#wbProviderForm,[role="search"],.filters,.filter-bar')) edits++;
  }, true);
  document.addEventListener('change', event => {
    if (inWorkbench() && event.isTrusted && event.target.closest('main') && !event.target.closest('form[data-wb-form="provider"],#provider-form,#wbProviderForm,[role="search"],.filters,.filter-bar')) edits++;
  }, true);
  addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-wb="new"],#new-project,#benchmark-new');
    if (button) {
      event.preventDefault(); event.stopImmediatePropagation();
      location.assign('/?new=' + moduleId() + '#/projects');
      return;
    }
    const link = event.target.closest?.('a[href]');
    if (link && dirty()) {
      const target = new URL(link.href, location.href);
      if (target.origin === location.origin && target.pathname === location.pathname && target.search === location.search && target.hash !== location.hash) {
        if (!confirm('有未保存的修改。离开后可能丢失，是否继续？')) { event.preventDefault(); event.stopImmediatePropagation(); }
        else savedEdit = edits;
      }
    }
  }, true);
  function rewrite(value) {
    const url = new URL(value, location.href);
    if (url.origin === location.origin && ['/api/', '/sources/', '/data/'].some(prefix => url.pathname.startsWith(prefix))) url.pathname = '/' + module + url.pathname;
    return url;
  }
  globalThis.fetch = (input, options = {}) => {
    const request = input instanceof Request ? input : null;
    const url = rewrite(request ? request.url : input);
    const headers = new Headers(options.headers || request?.headers);
    if (url.origin === location.origin) headers.set('X-Workbench-Project', group);
    return rawFetch(request ? new Request(url, request) : url, {...options, headers});
  };
  const rawOpen = globalThis.open.bind(globalThis);
  globalThis.open = (url, ...rest) => rawOpen(url ? rewrite(url).href : url, ...rest);
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href]');
    if (link && /^\/(api|sources)\//.test(link.getAttribute('href') || '')) link.href = rewrite(link.href).href;
  }, true);

  async function api(path, options = {}) {
    const response = await rawFetch(path, options);
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : '统一本机存储未完成操作。');
    return body;
  }
  function context() {
    return contextPromise ||= api('/api/workspace/project-context/' + encodeURIComponent(group));
  }
  async function seed(kind, value) {
    const project = (await context()).project;
    if (!project) return value;
    if (project.module !== moduleId()) throw new Error('当前界面与项目模块不一致，请从项目中心重新打开。');
    if (kind === 'csa') Object.assign(value, {
      name: project.company || '', reportPeriod: project.reportPeriod || '', targetPeriod: project.targetPeriod || '',
      ...Object.fromEntries(['industry','industryBasis','listed'].filter(key => project.options?.[key]).map(key => [key, project.options[key]])),
    });
    else if (kind === 'msci') Object.assign(value.project, {client_name: project.company || '', report_period: project.reportPeriod || '', target_period: project.targetPeriod || ''});
    else if (kind === 'benchmark') Object.assign(value, {name: project.name, industry: project.options?.industry || ''});
    else Object.assign(value, {customerName: project.company || '', reportYear: project.reportPeriod || '', targetYear: project.targetPeriod || '',
      ...Object.fromEntries(['exchange','board','industry','issuerCategory','fiscalYearStart'].filter(key => project.options?.[key]).map(key => [key, project.options[key]]))});
    return value;
  }
  const bucketName = bucket => bucket + '::' + group;
  const scopeName = (bucket, key) => bucketName(bucket) + '::' + key;
  async function upload(blob, bucket, key, format) {
    const mime = blob.type || (format === 'dataUrl' ? 'application/pdf' : 'application/octet-stream');
    const result = await api('/api/v1/documents/' + module + '?scope=' + encodeURIComponent(scopeName(bucket, key)), {
      method: 'POST', headers: {'Content-Type': mime, 'X-File-Name': encodeURIComponent(blob.name || 'original')}, body: blob
    });
    return {__unifiedOriginal: result.id, scope: scopeName(bucket, key), mime:result.mime, name: blob.name || '',
      lastModified: blob.lastModified || 0, format, sha256: result.sha256};
  }
  async function pack(value, bucket, key) {
    if (value instanceof Blob) return upload(value, bucket, key, value instanceof File ? 'file' : 'blob');
    if (value instanceof ArrayBuffer) return upload(new Blob([value]), bucket, key, 'arrayBuffer');
    if (typeof value === 'string' && value.startsWith('data:') && value.includes(';base64,') && value.length > 1024) {
      const response = await rawFetch(value);
      return upload(await response.blob(), bucket, key, 'dataUrl');
    }
    if (Array.isArray(value)) return Promise.all(value.map(v => pack(v, bucket, key)));
    if (value && typeof value === 'object') {
      const pairs = [];
      for (const [name, v] of Object.entries(value)) {
        if (/^(api.?key|authorization|password|secret)$/i.test(name)) continue;
        pairs.push([name, await pack(v, bucket, key)]);
      }
      return Object.fromEntries(pairs);
    }
    return value;
  }
  async function unpack(value) {
    if (value?.__unifiedOriginal) {
      const response = await rawFetch('/api/v1/documents/' + module + '/' + value.__unifiedOriginal + '?scope=' + encodeURIComponent(value.scope));
      if (!response.ok) throw new Error('已存原件读取失败，项目记录仍保留。');
      const raw = await response.arrayBuffer();
      const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map(v => v.toString(16).padStart(2, '0')).join('');
      if (sha !== value.sha256) throw new Error('已存原件指纹不符，已停止恢复。');
      if (value.format === 'arrayBuffer') return raw;
      const blob = new Blob([raw], {type: value.mime});
      if (value.format === 'file') return new File([blob], value.name, {type: value.mime, lastModified: value.lastModified});
      if (value.format === 'dataUrl') return new Promise((resolve, reject) => {const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);});
      return blob;
    }
    if (Array.isArray(value)) return Promise.all(value.map(unpack));
    if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await unpack(v)])));
    return value;
  }
  async function put(bucket, key, value) {
    const snapshot = edits;
    await api('/api/v1/projects/' + module, {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({bucket: bucketName(bucket), key: String(key), groupId: group,
        registerEntry: /^[a-f0-9]{32}$/.test(group), value: await pack(value, bucket, key)})});
    savedEdit = snapshot; contextPromise = null;
    return key;
  }
  async function get(bucket, key) {
    const result = await api('/api/v1/projects/' + module + '?bucket=' + encodeURIComponent(bucketName(bucket)) + '&key=' + encodeURIComponent(key));
    return result.value ? unpack(result.value) : undefined;
  }
  async function all(bucket) {
    const result = await api('/api/v1/projects/' + module + '?bucket=' + encodeURIComponent(bucketName(bucket)));
    return Promise.all(result.projects.map(p => unpack(p.value)));
  }
  async function latest(bucket) {
    const project = (await context()).project;
    if (project?.nativeBucket === bucketName(bucket) && project.nativeKey) return get(bucket, project.nativeKey);
    return undefined;
  }
  async function archive(bucket, key) {
    await api('/api/v1/projects/' + module, {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'archive', bucket:bucketName(bucket), key:String(key)})});
    return undefined;
  }
  async function database(bucket, mode, operation) {
    let action;
    const request = {};
    operation({put(value, key) {action = () => put(bucket, key ?? value.storageKey ?? value.id, value); return request;},
      get(key) {action = () => get(bucket, key); return request;}, getAll() {action = () => all(bucket); return request;},
      delete(key) {action = () => archive(bucket, key); return request;}});
    if (!action) throw new Error('本机存储操作不支持。');
    return action();
  }
  globalThis.__unified = {put, get, all, database, group, module, moduleId, context, seed, latest,
    firstMount(kind) { if (mounted.has(kind)) return false; mounted.add(kind); return true; },
    restored() { savedEdit = edits; }};
})();
