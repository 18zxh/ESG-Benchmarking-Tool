#!/bin/sh
set -eu
PACKAGE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
python3 -m venv "$PACKAGE_DIR/.runtime"
"$PACKAGE_DIR/.runtime/bin/python3" -m pip install -r "$PACKAGE_DIR/requirements-pdf.txt"
printf '%s\n' '初始化完成，请打开「启动智能评估工作台」。'
