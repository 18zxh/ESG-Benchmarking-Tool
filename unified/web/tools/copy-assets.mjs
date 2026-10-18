import { cp, mkdir } from "node:fs/promises";
for (const name of ["cmaps", "standard_fonts", "wasm"]) {
  await mkdir("../app-dist/" + name, { recursive: true });
  await cp("node_modules/pdfjs-dist/" + name, "../app-dist/" + name, {
    recursive: true,
  });
}
await cp("node_modules/pdfjs-dist/LICENSE", "../app-dist/PDFJS-LICENSE.txt");
for (const name of ['THIRD_PARTY_NOTICES.md','THIRD_PARTY_LICENSES.txt']) {
  await cp(name,'../app-dist/'+name);
}
