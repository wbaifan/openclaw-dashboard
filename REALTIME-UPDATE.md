# Dashboard 实时更新功能说明

## ✅ 功能已实现

Dashboard 现在支持**实时更新**，无需等待 10 秒轮询。

---

## 🎯 实现方案

采用 **事件驱动 + WebSocket 推送** 架构：

### 后端改动

**1. ActivityTracker 增加事件回调**

```typescript
// activity-tracker.ts
export class ActivityTracker {
  private _onActivity?: () => void;
  private _isLoadingHistory = false; // 防止历史加载触发回调
  
  // 设置回调
  onActivity(callback: () => void): void {
    this._onActivity = callback;
  }
  
  // 检测到新活动时触发回调
  private _processEntry(entry, filePath) {
    // ... 处理消息 ...
    
    // 历史加载时不触发，只有新活动才触发
    if (!this._isLoadingHistory && this._onActivity) {
      this._onActivity();
    }
  }
}
```

**2. Server 立即推送更新**

```typescript
// server.ts
const DEBOUNCE_MS = 500; // 防抖，避免频繁推送

// 设置实时推送
tracker.onActivity(() => {
  pushUpdate(); // 检测到活动立即推送
});

// 防抖推送函数
async function pushUpdate(): Promise<void> {
  // 500ms 内的多次触发会被合并
  if (now - lastUpdateTime < DEBOUNCE_MS && updatePending) {
    return;
  }
  
  latestMetrics = await collectMetrics(gw, tracker);
  broadcast({ type: 'metrics', data: latestMetrics });
}

// 保留 10 秒轮询作为保底
setTimeout(updateLoop, UPDATE_INTERVAL_MS);
```

---

## 🚀 性能优化

### 1. 防抖机制
- 短时间内的多次文件变化合并为一次推送
- 避免频繁更新导致客户端闪烁

### 2. 历史加载不触发
- 启动时加载历史数据不触发推送
- 只有**新活动**才会实时推送

### 3. 保底轮询
- 保留 10 秒轮询作为备份
- 确保 WebSocket 断开时仍有更新

---

## 📊 测试验证

**测试脚本**：`/tmp/test-realtime-v2.sh`

**测试结果**：
```log
[activity] Processing entry from test-rea role: user  # 检测到新消息
[pushUpdate] ✓ Broadcasted update                     # 立即推送
```

**预期行为**：
- ✅ 检测到文件变化后立即推送（<1 秒）
- ✅ WebSocket 连接保持 `🟢 live` 状态
- ✅ Live Activity 卡片实时更新
- ✅ 不需要等待 10 秒轮询

---

## 🔧 技术细节

### 文件监听
- 使用 `chokidar` 监听会话文件变化
- `awaitWriteFinish: { stabilityThreshold: 300 }` 确保文件写入完成

### WebSocket 协议
```json
{
  "type": "metrics",
  "data": { /* DashboardMetrics */ }
}
```

### 前端无需改动
- 前端已实现 WebSocket 监听
- 自动重连机制已就绪
- 无需修改即可支持实时更新

---

## 📝 文件清单

修改的文件：
- `packages/server/src/activity-tracker.ts` - 添加事件回调
- `packages/server/src/server.ts` - 实时推送逻辑

新增的测试工具：
- `/tmp/test-realtime-v2.sh` - 实时更新测试脚本
- `~/openclaw-dashboard/test-realtime.sh` - 测试说明

---

## 🎉 完成

Dashboard 现在能够在检测到会话文件变化时，**立即**通过 WebSocket 推送更新到前端，实现真正的实时监控！
