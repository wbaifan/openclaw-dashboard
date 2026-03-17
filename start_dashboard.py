#!/usr/bin/env python3
"""
OpenClaw Dashboard 启动脚本
使用 subprocess 启动服务，避免 shell 超时问题
"""

import subprocess
import sys
import os
import signal
import logging
from datetime import datetime
from pathlib import Path

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

# Dashboard 目录
DASHBOARD_DIR = Path(__file__).parent.resolve()
SERVER_JS = DASHBOARD_DIR / "dist" / "server.js"
PID_FILE = DASHBOARD_DIR / ".dashboard.pid"
LOG_FILE = DASHBOARD_DIR / "dashboard.log"

def get_running_process():
    """检查是否有正在运行的进程"""
    try:
        if PID_FILE.exists():
            pid = int(PID_FILE.read_text().strip())
            # 检查进程是否存在
            os.kill(pid, 0)
            return pid
    except (ValueError, ProcessLookupError, PermissionError):
        pass
    except Exception as e:
        logger.warning(f"检查进程时出错: {e}")
    return None

def stop_service():
    """停止服务"""
    pid = get_running_process()
    if pid:
        logger.info(f"正在停止 Dashboard 服务 (PID: {pid})...")
        try:
            os.kill(pid, signal.SIGTERM)
            # 等待进程结束
            import time
            for _ in range(10):
                try:
                    os.kill(pid, 0)
                    time.sleep(0.5)
                except ProcessLookupError:
                    break
            else:
                # 强制终止
                os.kill(pid, signal.SIGKILL)
            logger.info("Dashboard 服务已停止")
        except ProcessLookupError:
            logger.info("Dashboard 服务已经不在运行")
        except Exception as e:
            logger.error(f"停止服务时出错: {e}")
        
        if PID_FILE.exists():
            PID_FILE.unlink()
    else:
        logger.info("没有找到运行中的 Dashboard 服务")

def start_service(foreground=False):
    """启动服务"""
    # 检查是否已在运行
    pid = get_running_process()
    if pid:
        logger.warning(f"Dashboard 服务已在运行 (PID: {pid})")
        return False
    
    # 检查文件是否存在
    if not SERVER_JS.exists():
        logger.error(f"找不到服务器文件: {SERVER_JS}")
        return False
    
    logger.info(f"Dashboard 目录: {DASHBOARD_DIR}")
    logger.info(f"服务器文件: {SERVER_JS}")
    
    # 设置环境变量
    env = os.environ.copy()
    env["NODE_NO_WARNINGS"] = "1"  # 抑制 Node.js 警告
    
    if foreground:
        # 前台运行（用于调试）
        logger.info("以前台模式启动 Dashboard 服务...")
        try:
            process = subprocess.Popen(
                ["node", str(SERVER_JS)],
                cwd=str(DASHBOARD_DIR),
                env=env,
                # 不设置超时，让进程持续运行
            )
            # 写入 PID 文件
            PID_FILE.write_text(str(process.pid))
            logger.info(f"Dashboard 服务已启动 (PID: {process.pid})")
            
            # 等待进程结束
            process.wait()
        except KeyboardInterrupt:
            logger.info("收到中断信号，正在停止...")
            stop_service()
        except Exception as e:
            logger.error(f"启动服务时出错: {e}")
            return False
    else:
        # 后台运行
        logger.info("启动 Dashboard 服务（后台模式）...")
        
        # 打开日志文件
        log_handle = open(LOG_FILE, 'a')
        log_handle.write(f"\n{'='*50}\n")
        log_handle.write(f"Dashboard 启动于: {datetime.now()}\n")
        log_handle.write(f"{'='*50}\n")
        log_handle.flush()
        
        try:
            process = subprocess.Popen(
                ["node", str(SERVER_JS)],
                cwd=str(DASHBOARD_DIR),
                env=env,
                stdout=log_handle,
                stderr=log_handle,
                # 关键：使用 start_new_session 让进程独立于父进程
                start_new_session=True,
            )
            
            # 写入 PID 文件
            PID_FILE.write_text(str(process.pid))
            logger.info(f"Dashboard 服务已启动 (PID: {process.pid})")
            logger.info(f"日志文件: {LOG_FILE}")
            return True
            
        except Exception as e:
            logger.error(f"启动服务时出错: {e}")
            log_handle.close()
            return False

def restart_service():
    """重启服务"""
    stop_service()
    return start_service()

def status():
    """查看服务状态"""
    pid = get_running_process()
    if pid:
        logger.info(f"Dashboard 服务正在运行 (PID: {pid})")
        return True
    else:
        logger.info("Dashboard 服务未运行")
        return False

def main():
    import argparse
    parser = argparse.ArgumentParser(description='OpenClaw Dashboard 启动脚本')
    parser.add_argument('action', choices=['start', 'stop', 'restart', 'status'],
                        help='操作: start, stop, restart, status')
    parser.add_argument('-f', '--foreground', action='store_true',
                        help='前台运行（用于调试）')
    
    args = parser.parse_args()
    
    if args.action == 'start':
        start_service(foreground=args.foreground)
    elif args.action == 'stop':
        stop_service()
    elif args.action == 'restart':
        restart_service()
    elif args.action == 'status':
        status()

if __name__ == '__main__':
    main()