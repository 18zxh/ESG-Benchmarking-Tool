#!/bin/zsh
set -eu
UNIFIED_ROOT="${0:A:h}"
cd "$UNIFIED_ROOT"
UNIFIED_PYTHON="${UNIFIED_PYTHON:-$(command -v python3.12 || true)}"
if [[ -z "$UNIFIED_PYTHON" ]]; then
  print '需要Python 3.12。请先安装后重新运行。'
  exit 1
fi
UNIFIED_ENV="$UNIFIED_ROOT/.runtime/unified-python"
if [[ ! -x "$UNIFIED_ENV/bin/python" ]]; then
  "$UNIFIED_PYTHON" -m venv "$UNIFIED_ENV"
fi
"$UNIFIED_ENV/bin/python" -m pip install -r unified/requirements.txt
"$UNIFIED_ENV/bin/python" -m pip check
print '统一工作台运行环境已就绪；原工作台运行环境保留。'
