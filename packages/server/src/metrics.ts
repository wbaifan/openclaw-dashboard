import { GatewayClient } from './gateway-client.js';
import { ActivityTracker } from './activity-tracker.js';
import type { ActivitySnapshot } from './activity-tracker.js';
import { getAgentSessionsDirs } from './config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

export interface DashboardMetrics {
  timestamp: number;
  gwConnected: boolean;
  health?: unknown;
  status?: unknown;
  presence?: unknown;
  usageCost?: unknown;
  activity: ActivitySnapshot;
}

/** Usage cost data types for aggregation */
interface UsageTotals {
  totalTokens?: number;
  totalCost?: number;
  output?: number;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  inputCost?: number;
  outputCost?: number;
  cacheReadCost?: number;
  cacheWriteCost?: number;
}

interface DailyUsage {
  date: string;
  totalTokens?: number;
  totalCost?: number;
  output?: number;
  input?: number;
  cacheRead?: number;
}

interface UsageCostData {
  totals?: UsageTotals;
  daily?: DailyUsage[];
  updatedAt?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Simple Cache with File Modification Time Tracking ────────────────────────────────

interface UsageCache {
  daily: Map<string, DailyUsage>;
  totals: UsageTotals;
  updatedAt: number;
}

// Global cache instance
const usageCache: UsageCache = {
  daily: new Map(),
  totals: {
    totalTokens: 0,
    totalCost: 0,
    output: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
  },
  updatedAt: 0,
};

/** Get the latest modification time of all transcript files */
async function getLatestTranscriptMtime(): Promise<number> {
  const dirs = getAgentSessionsDirs();
  let latestMtime = 0;
  for (const { sessionsDir } of dirs) {
    try {
      const files = await fs.promises.readdir(sessionsDir);
      for (const file of files) {
        // Include .jsonl, .jsonl.deleted.*, .jsonl.reset.* files
        if (!file.endsWith('.jsonl') && !file.includes('.jsonl.deleted.') && !file.includes('.jsonl.reset.')) continue;
        const stat = await fs.promises.stat(path.join(sessionsDir, file));
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
        }
      }
    } catch {
      // Directory not accessible, skip
    }
  }
  return latestMtime;
}

/** Format date to YYYY-MM-DD string using Beijing timezone (Asia/Shanghai) */
function formatDayKey(date: Date): string {
  return date.toLocaleDateString('en-CA', { 
    timeZone: 'Asia/Shanghai'
  });
}

/** Parse transcript entry to extract usage, timestamp, and role */
function parseTranscriptEntry(entry: Record<string, unknown>): { 
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  timestamp?: Date;
  role?: string;
} | null {
  const message = entry.message as Record<string, unknown> | undefined;
  if (!message) return null;

  const role = (message as { role?: string }).role;
  if (!role) return null;

  // Parse timestamp
  let timestamp: Date | undefined;
  const rawTs = entry.timestamp;
  if (typeof rawTs === 'string') {
    timestamp = new Date(rawTs);
  }
  if (!timestamp || Number.isNaN(timestamp.getTime())) {
    const msgTs = (message as Record<string, unknown>).timestamp;
    if (typeof msgTs === 'number') {
      timestamp = new Date(msgTs);
    }
  }

  // For user messages, just return role and timestamp
  if (role === 'user') {
    return { role, timestamp };
  }

  // For assistant messages, extract usage
  if (role === 'assistant') {
    const usageRaw = (message as Record<string, unknown>).usage as Record<string, unknown> | undefined;
    if (!usageRaw) return { role, timestamp };

    const usage = {
      input: (usageRaw.input as number) ?? 0,
      output: (usageRaw.output as number) ?? 0,
      cacheRead: (usageRaw.cacheRead as number) ?? 0,
      cacheWrite: (usageRaw.cacheWrite as number) ?? 0,
    };

    return { usage, timestamp, role };
  }

  return null;
}

/** Scan a single transcript file and aggregate usage */
async function scanTranscriptFile(
  filePath: string,
  startMs: number,
  endMs: number,
  dailyMap: Map<string, DailyUsage>,
  totals: UsageTotals,
  _forceScan: boolean = false
): Promise<void> {
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const parsed = parseTranscriptEntry(entry);
      if (!parsed || !parsed.timestamp) continue;

      const ts = parsed.timestamp.getTime();
      if (ts < startMs || ts > endMs) continue;

      // Accumulate all assistant usage (not just the last one in each prompt)
      if (parsed.role === 'assistant' && parsed.usage) {
        const totalTokens = parsed.usage.input + parsed.usage.output + 
                            parsed.usage.cacheRead + parsed.usage.cacheWrite;
        
        // 直接累加所有 assistant usage
        totals.totalTokens! += totalTokens;
        totals.input! += parsed.usage.input;
        totals.output! += parsed.usage.output;
        totals.cacheRead! += parsed.usage.cacheRead;
        totals.cacheWrite! += parsed.usage.cacheWrite;

        const dayKey = formatDayKey(parsed.timestamp);
        const day = dailyMap.get(dayKey) ?? {
          date: dayKey,
          totalTokens: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
        };
        day.totalTokens! += totalTokens;
        day.input! += parsed.usage.input;
        day.output! += parsed.usage.output;
        day.cacheRead! += parsed.usage.cacheRead;
        dailyMap.set(dayKey, day);
      }
    } catch {
      // Skip malformed entries
    }
  }

  rl.close();
  fileStream.destroy();
}

/** Load usage cost data with smart caching based on file modification time */
async function loadUsageFromAllAgents(days: number = 30): Promise<UsageCostData> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startMs = todayStart - (days - 1) * DAY_MS;
  const endMs = now.getTime();
  const todayKey = formatDayKey(now);

  // Check the latest file modification time
  const latestMtime = await getLatestTranscriptMtime();
  
  // Cache is valid if: data exists AND cache was updated after the latest file modification
  if (usageCache.daily.size > 0 && usageCache.updatedAt > latestMtime) {
    const daily = Array.from(usageCache.daily.values()).sort((a, b) => a.date.localeCompare(b.date));
    return {
      updatedAt: usageCache.updatedAt,
      days,
      daily,
      totals: usageCache.totals,
    };
  }

  // Rescan needed - collect all files
  const agentDirs = getAgentSessionsDirs();
  const allFiles: string[] = [];
  
  for (const { sessionsDir } of agentDirs) {
    try {
      // Include .jsonl, .jsonl.deleted.*, .jsonl.reset.* files
      const files = fs.readdirSync(sessionsDir).filter(f => {
        return f.endsWith('.jsonl') || 
               f.includes('.jsonl.deleted.') || 
               f.includes('.jsonl.reset.');
      });
      for (const file of files) {
        allFiles.push(path.join(sessionsDir, file));
      }
    } catch {
      // Directory not accessible, skip
    }
  }

  // Full rescan
  const dailyMap = new Map<string, DailyUsage>();
  const totals: UsageTotals = {
    totalTokens: 0,
    totalCost: 0,
    output: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
  };

  // Scan all files in parallel
  const scanPromises = allFiles.map(filePath => 
    scanTranscriptFile(filePath, startMs, endMs, dailyMap, totals, false)
  );

  await Promise.all(scanPromises);

  // Update cache
  usageCache.daily = dailyMap;
  usageCache.totals = totals;
  usageCache.updatedAt = Date.now();

  // Sort daily by date
  const daily = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  return {
    updatedAt: usageCache.updatedAt,
    days,
    daily,
    totals,
  };
}

/** Get label for a session from the agent's sessions.json file */
async function getSessionLabel(sessionKey: string): Promise<string | undefined> {
  const match = sessionKey.match(/^agent:([^:]+):/);
  if (!match) return undefined;

  const agentId = match[1];
  const sessionsPath = path.join(
    process.env.HOME || '/home/wbaifan',
    '.openclaw',
    'agents',
    agentId,
    'sessions',
    'sessions.json'
  );

  try {
    const content = await fs.promises.readFile(sessionsPath, 'utf-8');
    const sessions = JSON.parse(content);
    const session = sessions[sessionKey];
    return session?.label || session?.origin?.label;
  } catch {
    return undefined;
  }
}

/** Collect all dashboard metrics from the gateway and local session logs. */
export async function collectMetrics(gw: GatewayClient, tracker: ActivityTracker): Promise<DashboardMetrics> {
  const result: DashboardMetrics = {
    timestamp: Date.now(),
    gwConnected: gw.connected,
    activity: tracker.getSnapshot(),
  };

  if (gw.connected) {
    const [health, status, presence, usageCost] = await Promise.all([
      gw.call('health').catch(() => null),
      gw.call('status').catch(() => null),
      gw.call('system-presence').catch(() => null),
      loadUsageFromAllAgents(30),
    ]);

    result.health = health;
    result.presence = presence;
    result.usageCost = usageCost;

    if (status && typeof status === 'object') {
      const statusObj = status as { sessions?: { recent?: Array<{ key: string; label?: string }> } };
      if (statusObj.sessions?.recent) {
        for (const session of statusObj.sessions.recent) {
          const label = await getSessionLabel(session.key);
          if (label) {
            session.label = label;
          }
        }
      }
      result.status = status;
    }
  }

  return result;
}
