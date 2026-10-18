#!/bin/zsh
set -e
CSA_ROOT="${0:A:h}"
cd "$CSA_ROOT"
CSA_PORT=8781
CSA_SERVICE_STATE=$(python3 - "$CSA_PORT" <<'PY'
import json,sys,urllib.request
try:
 with urllib.request.urlopen('http://127.0.0.1:'+sys.argv[1]+'/api/status',timeout=2) as r:
  status=json.load(r)
  if status.get('appId')!='csa-pdf-workbench':
   print('other')
  else:
   print('ready' if int(status.get('version',0))>=6 else 'outdated')
except Exception: print('absent')
PY
)
if [[ "$CSA_SERVICE_STATE" == 'ready' ]]; then
 open "http://127.0.0.1:$CSA_PORT/#/home"
 print "CSA 工作台已打开。"
 exit 0
fi
if [[ "$CSA_SERVICE_STATE" == 'outdated' ]]; then
 print "检测到旧版 CSA 服务。请先保存项目，在原启动窗口按 Control+C 退出旧服务，再双击本文件。"
 read -r "?按回车关闭此窗口。"
 exit 1
fi
if [[ "$CSA_SERVICE_STATE" == 'other' ]]; then
 print "本机工作台地址已被其他程序使用，请关闭占用程序后重新启动。"
 read -r "?按回车关闭此窗口。"
 exit 1
fi
CSA_PY=python3
if [[ -x "$CSA_ROOT/.runtime/bin/python3" ]]; then
 CSA_PY="$CSA_ROOT/.runtime/bin/python3"
fi
if ! "$CSA_PY" -c 'import pdfplumber' >/dev/null 2>&1; then
 print "正在准备本网站的独立 PDF 识别环境…"
 python3 -m venv "$CSA_ROOT/.runtime"
 "$CSA_ROOT/.runtime/bin/python3" -m pip install -r "$CSA_ROOT/pipeline/requirements.txt"
 CSA_PY="$CSA_ROOT/.runtime/bin/python3"
fi
chmod +x "$CSA_ROOT/pipeline/bin/pdf-converter-macos-arm64"
"$CSA_PY" "$CSA_ROOT/pipeline/workbench_server.py" --port "$CSA_PORT" --open-browser
