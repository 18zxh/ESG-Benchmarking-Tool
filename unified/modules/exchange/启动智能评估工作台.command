#!/bin/zsh
set -eu
task_project_dir="${0:A:h}"
task_python="$task_project_dir/.venv/bin/python"
cd "$task_project_dir"
if [[ ! -x "$task_python" ]]; then
    print -u2 "请先双击“初始化运行环境.command”，再启动工作台。"
    exit 1
fi
task_args=()
if [[ "${1:-}" != "--no-browser" ]]; then
    task_args+=(--open-browser)
fi
exec "$task_python" "$task_project_dir/pipeline/workbench_server.py" --allow-port-fallback "${task_args[@]}"
