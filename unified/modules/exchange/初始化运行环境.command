#!/bin/zsh
set -eu

trap 'print -u2 "初始化未完成，请检查上方原因后重新运行本文件。"' ZERR

task_project_dir="${0:A:h}"
task_env_dir="$task_project_dir/.venv"
task_requirements="$task_project_dir/requirements-pdf.txt"
task_env_python="$task_env_dir/bin/python"

cd "$task_project_dir"

if [[ ! -f "$task_requirements" ]]; then
    print -u2 "缺少 requirements-pdf.txt，请将初始化脚本与依赖文件放在同一目录。"
    exit 1
fi

if [[ -L "$task_env_dir" ]]; then
    print -u2 ".venv 是符号链接，初始化已停止。请使用项目内独立的运行环境目录。"
    exit 1
fi

if [[ -e "$task_env_dir" ]]; then
    if [[ ! -x "$task_env_python" ]]; then
        print -u2 "现有 .venv 不是可用的 Python 环境。请保留或移走该目录后重试。"
        exit 1
    fi
    print "检查现有运行环境……"
else
    task_python=""
    for task_candidate in \
        python3.12 \
        /opt/homebrew/bin/python3.12 \
        /usr/local/bin/python3.12 \
        /Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12 \
        python3; do
        if command -v "$task_candidate" >/dev/null 2>&1 && \
            "$task_candidate" -c 'import sys; raise SystemExit(sys.version_info[:2] != (3, 12))' 2>/dev/null; then
            task_python="$(command -v "$task_candidate")"
            break
        fi
    done

    if [[ -z "$task_python" ]]; then
        print -u2 "未找到 Python 3.12。请先安装 Python 3.12，再双击本文件。"
        exit 1
    fi

    print "创建项目运行环境……"
    "$task_python" -m venv "$task_env_dir"
fi

"$task_env_python" - "$task_env_dir" <<'PY'
from pathlib import Path
import sys

if sys.version_info[:2] != (3, 12):
    raise SystemExit("现有 .venv 未使用 Python 3.12，请保留或移走该目录后重新初始化。")
if Path(sys.prefix).resolve() != Path(sys.argv[1]).resolve() or sys.prefix == sys.base_prefix:
    raise SystemExit(".venv 路径校验失败，初始化已停止。")
PY

print "安装依赖……"
"$task_env_python" -m pip --isolated --disable-pip-version-check --no-input install \
    --index-url https://pypi.org/simple --timeout 30 --retries 2 --progress-bar off \
    -r "$task_requirements"

print "核对依赖版本……"
"$task_env_python" - "$task_requirements" <<'PY'
from importlib.metadata import version
from pathlib import Path
import sys

import pdfplumber
import PyPDF2

print(f"Python {sys.version.split()[0]}")
for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    name, expected = line.split("==", 1)
    actual = version(name)
    if actual != expected:
        raise SystemExit(f"{name} 版本不一致：应为 {expected}，实际为 {actual}。")
    print(f"{name}=={actual}")
PY

"$task_env_python" -m pip --disable-pip-version-check check
print "初始化完成。运行环境已保存在项目的 .venv 目录中。"
