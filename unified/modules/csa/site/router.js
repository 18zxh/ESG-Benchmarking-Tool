export const routes = [
  ['home', '概览'],
  ['methods', '方法文件导读'],
  ['weights', '行业评分权重'],
  ['questions', '问题与证据要求'],
  ['workbench', '报告评估工作台'],
  ['resources', '资料与版本'],
];
export function readRoute() {
  const raw = location.hash.replace(/^#\/?/, '') || 'home';
  const [route, query] = raw.split('?');
  const params = new URLSearchParams(query || '');
  if (route === 'updates') {
    params.set('tab', 'updates');
    return { route: 'resources', params };
  }
  if (route === 'sources') return { route: 'resources', params };
  if (route === 'companies' || route === 'benchmark')
    return { route: 'weights', params: new URLSearchParams() };
  return { route, params };
}
export function updateParam(name, value, reset = true) {
  const { route, params } = readRoute();
  value ? params.set(name, value) : params.delete(name);
  if (name === 'dim') params.delete('criterion');
  if (reset) params.delete('page');
  location.hash = `/${route}?${params}`;
}
export function qsHref(route, params) {
  return `#/${route}?${new URLSearchParams(params)}`;
}
