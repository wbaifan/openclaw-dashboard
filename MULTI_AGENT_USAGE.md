# Dashboard 多 Agent Usage 聚合方案

## 问题背景

Dashboard 目前已实现多 agent 活动聚合（ActivityTracker），但 `usage.cost` 数据仍然只来自 Gateway API，无法聚合多个 agent 的 token 使用量。

## 现状分析

### 已实现
- ✅ `getAgentSessionsDirs()` 扫描所有 agent 目录
- ✅ `ActivityTracker` 监听和聚合多个 agent 的活动数据
- ✅ Live Activity 和 Task Log 显示所有 agent 的活动

### 未实现
- ❌ `usage.cost` 多 agent 聚合
- ❌ 多 agent token 使用量统计

## 数据源分析

### Gateway API
- **接口**：`gw.call('usage.cost', { days: 30 })`
- **限制**：只支持单个 agent
- **问题**：无法聚合多个 agent

### sessions.json
- **位置**：`~/.openclaw/agents/{agentName}/sessions/sessions.json`
- **结构**：
  ```json
  {
    "agent:ai_tui:feishu:group:oc_xxx": {
      "inputTokens": 1000,
      "outputTokens": 500,
      "totalTokens": 1500,
      "cacheRead": 200,
      "cacheWrite": 100,
      "sessionId": "...",
      "updatedAt": "2026-03-16T12:00:00Z"
    }
  }
  ```
- **优势**：每个 agent 独立维护，可聚合

## 解决方案

### 方案：聚合 sessions.json 数据

**实现步骤**：

1. **创建 `collectMultiAgentUsage()` 函数**
   ```typescript
   async function collectMultiAgentUsage(): Promise<UsageData> {
     const agentDirs = getAgentSessionsDirs();
     const result = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
     
     for (const { agentName, sessionsDir } of agentDirs) {
       const sessionsPath = path.join(sessionsDir, 'sessions.json');
       try {
         const content = await fs.promises.readFile(sessionsPath, 'utf-8');
         const sessions = JSON.parse(content);
         for (const sessionKey of Object.keys(sessions)) {
           const session = sessions[sessionKey];
           result.inputTokens += session.inputTokens || 0;
           result.outputTokens += session.outputTokens || 0;
           result.totalTokens += session.totalTokens || 0;
         }
       } catch {
         // File not found or invalid JSON
       }
     }
     
     return result;
   }
   ```

2. **修改 `collectMetrics()` 函数**
   ```typescript
   export async function collectMetrics(gw: GatewayClient, tracker: ActivityTracker): Promise<DashboardMetrics> {
     // ... existing code ...
     
     // Collect multi-agent usage data
     const multiAgentUsage = await collectMultiAgentUsage();
     
     // Merge with Gateway usage.cost if available
     if (result.usageCost) {
       result.usageCost = {
         ...result.usageCost,
         multiAgent: multiAgentUsage
       };
     }
   }
   ```

3. **前端显示调整**
   - 在 Dashboard 中显示多 agent token 总量
   - 区分 Gateway 单 agent 数据和多 agent 聚合数据

## 性能考虑

- **读取频率**：每次 Dashboard 刷新时读取（10 秒轮询 + 实时推送）
- **文件数量**：agent 数量 × 1 个 sessions.json（通常 ≤ 5 个文件）
- **文件大小**：sessions.json 通常 < 1MB
- **优化方案**：可以考虑缓存 + 定期刷新

## 实施优先级

**优先级**：中
- 活动聚合已完成，usage 聚合是增强功能
- 当前单 agent usage 已能满足基本需求
- 多 agent 场景下价值更高

## 相关文件

- `/home/wbaifan/.openclaw/workspace-ai_tui/projects/openclaw-dashboard/packages/server/src/metrics.ts`
- `/home/wbaifan/.openclaw/workspace-ai_tui/projects/openclaw-dashboard/packages/server/src/config.ts`
- `/home/wbaifan/.openclaw/workspace-ai_tui/projects/openclaw-dashboard/packages/server/src/activity-tracker.ts`

## 技术发现

1. **sessions.json 包含完整 token 使用量数据**：inputTokens、outputTokens、totalTokens、cacheRead、cacheWrite
2. **ActivityTracker 已实现多 agent 支持**：可复用 `getAgentSessionsDirs()` 函数
3. **实现路径清晰**：创建新函数聚合 sessions.json 数据，合并到 metrics

---

*创建时间：2026-03-16 19:45*