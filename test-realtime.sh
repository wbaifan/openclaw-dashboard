#!/bin/bash
# 测试实时更新功能

echo "=== Dashboard 实时更新测试 ==="
echo ""

# 检查是否有进程在运行
if pgrep -f "node.*dist/server.js" > /dev/null; then
  echo "✓ Dashboard 服务器已在运行"
  echo ""
  echo "测试步骤："
  echo "1. 打开浏览器访问 http://localhost:3003"
  echo "2. 观察 WebSocket 连接状态（右下角应显示 🟢 live）"
  echo "3. 在另一个终端中，创建一个测试会话文件："
  echo ""
  echo "   echo '{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"测试消息\"},\"timestamp\":\"$(date -Iseconds)\"}' >> ~/.openclaw/workspace-ai_tui/sessions/test.jsonl"
  echo ""
  echo "4. 观察 Dashboard 是否立即更新（不超过 1 秒）"
  echo ""
  echo "期望结果："
  echo "- WebSocket 状态保持 🟢 live"
  echo "- Live Activity 卡片立即显示新的活动"
  echo "- 不需要等待 10 秒轮询"
  echo ""
else
  echo "Dashboard 服务器未运行"
  echo "启动命令: cd ~/openclaw-dashboard && npm start"
fi
