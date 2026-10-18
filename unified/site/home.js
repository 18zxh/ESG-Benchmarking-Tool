(() => {
  const $ = id => document.getElementById(id);
  const api = async (path, data) => {const r = await fetch(path, data ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)} : {}); const v = await r.json(); if(!r.ok) throw new Error(v.error); return v;};
  function links() {const id = $('project').value; sessionStorage.setItem('unified-project', id); for(const link of document.querySelectorAll('[data-module]')) {const url = new URL(link.href); url.searchParams.set('project', id); link.href = url.href;}}
  async function refresh() {
    const status = await api('/api/status'); $('connection').textContent = status.providers.length ? '已连接共享 ' + status.providers[0].model + '；密钥仅在服务内存。' : '尚未连接模型。';
    const saved = await api('/api/v1/projects/exchange?bucket=unified-groups');
    for(const item of saved.projects) {const option = document.createElement('option'); option.value = item.key; option.textContent = item.value.name; $('project').append(option);}
    const current = sessionStorage.getItem('unified-project'); if([...$('project').options].some(o => o.value === current)) $('project').value = current; links();
  }
  $('project').onchange = links;
  $('new-project').onsubmit = async event => {event.preventDefault(); try {const id = crypto.randomUUID(); await api('/api/v1/projects/exchange', {bucket: 'unified-groups', key: id, groupId: id, value: {name: $('company').value.trim()}}); const option = document.createElement('option'); option.value = id; option.textContent = $('company').value.trim(); $('project').append(option); $('project').value = id; links(); $('company').value = ''; } catch(e) {$('status').textContent = e.message;}};
  $('provider').onsubmit = async event => {event.preventDefault(); try {const result = await api('/api/v1/providers', {baseUrl: $('base-url').value, model: $('model').value, apiKey: $('api-key').value}); $('api-key').value = ''; $('connection').textContent = '三个工作台已登记共享 ' + result.providers[0].model + '，实际可用性在首次调用时验证。';} catch(e) {$('connection').textContent = e.message;}};
  refresh().catch(e => {$('status').textContent = e.message;});
})();
