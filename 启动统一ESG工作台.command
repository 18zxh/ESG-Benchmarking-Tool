#!/bin/zsh
set -eu
UNIFIED_ROOT="${0:A:h}"
cd "$UNIFIED_ROOT"
UNIFIED_PY="$UNIFIED_ROOT/.runtime/unified-python/bin/python"
if [[ ! -x "$UNIFIED_PY" ]]; then
  "$UNIFIED_ROOT/初始化统一ESG工作台.command"
fi
"$UNIFIED_PY" -c 'import pdfplumber,PyPDF2,pypdf,certifi' || {
  print '融合运行环境缺少组件，请先运行 初始化统一ESG工作台.command。'
  exit 1
}
UNIFIED_REUSE_URL=$("$UNIFIED_PY" - <<'PY_REUSE'
import hashlib,json,pathlib,urllib.request
expected=hashlib.sha256(str(pathlib.Path('unified').resolve()).encode()).hexdigest()[:16]
store=hashlib.sha256(str(pathlib.Path('.runtime/unified-data').resolve()).encode()).hexdigest()[:16]
for port in range(8791,8811):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/status',timeout=.2) as r: status=json.load(r)
        if status.get('appId')=='unified-esg-workbench' and status.get('workspaceId')==expected and status.get('storeId')==store and status.get('version')=='0.4.0':
            print(f'http://127.0.0.1:{port}/');break
    except Exception:pass
PY_REUSE
)
if [[ -n "$UNIFIED_REUSE_URL" ]]; then
  print "统一工作台已运行：$UNIFIED_REUSE_URL"
  if [[ "${1:-}" != '--no-browser' ]]; then open "$UNIFIED_REUSE_URL"; fi
  exit 0
fi
if [[ "${1:-}" == '--no-browser' ]]; then
  exec "$UNIFIED_PY" -m unified.server --port 8791
else
  exec "$UNIFIED_PY" -m unified.server --port 8791 --open-browser
fi
