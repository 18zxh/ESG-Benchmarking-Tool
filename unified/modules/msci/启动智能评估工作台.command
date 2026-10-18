#!/bin/sh
set -eu
PACKAGE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
RUNTIME_PYTHON="python3"
if [ -x "$PACKAGE_DIR/.runtime/bin/python3" ]; then RUNTIME_PYTHON="$PACKAGE_DIR/.runtime/bin/python3"; fi
exec "$RUNTIME_PYTHON" - "$PACKAGE_DIR" <<'PY'
import json,os,sys,webbrowser
from pathlib import Path
from urllib.request import urlopen
try:
    import pdfplumber, PyPDF2
except ImportError:
    raise SystemExit('缺少表格识别组件，请先双击「初始化运行环境」。')
url='http://127.0.0.1:8770/'
try:
    with urlopen(url+'api/status',timeout=2) as response: status=json.load(response)
    if status.get('ok') and status.get('appId')=='msci-esg-pdf-workbench' and status.get('version',0)>=6:
        print('新版工作台已在运行，正在打开。')
        webbrowser.open(url+'#/workbench');raise SystemExit(0)
    if status.get('appId')=='msci-esg-pdf-workbench':raise SystemExit('工作台代码已更新，请停止旧服务后重新双击启动。')
    raise SystemExit('8770 端口由其他服务使用，请先核对端口占用。')
except (OSError,ValueError):
    pass
server=Path(sys.argv[1])/'pipeline/workbench_server.py'
os.execv(sys.executable,[sys.executable,str(server),'--port','8770','--open-browser'])
PY
