const cache = new Map();
export async function getData(name) {
  if (!cache.has(name))
    cache.set(
      name,
      fetch(`data/${name}.json`)
        .then(async (r) => {
          if (!r.ok) throw new Error('资料载入失败，请通过启动文件打开网站。');
          return r.json();
        })
        .catch((e) => {
          cache.delete(name);
          throw e;
        }),
    );
  return cache.get(name);
}
export async function loadAppData() {
  const entries = [
    ['industries', 'industries'],
    ['coverage', 'coverage'],
    ['sources', 'sources'],
    ['companies', 'companies'],
    ['aliases', 'company-aliases'],
    ['catalog', 'catalog-metadata'],
    ['portal', 'portal-guidance'],
  ];
  const values = await Promise.all(entries.map(([, file]) => getData(file)));
  return Object.fromEntries(entries.map(([key], index) => [key, values[index]]));
}
