#!/bin/bash
# OpenClaw Dashboard 快捷启动脚本
# 用法: ./dashboard.sh [start|stop|restart|status]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 "$SCRIPT_DIR/start_dashboard.py" "$@"