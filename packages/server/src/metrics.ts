import { GatewayClient } from './gateway-client.js';
import { ActivityTracker } from './activity-tracker.js';
import type { ActivitySnapshot } from './activity-tracker.js';
import * as fs from 'fs';
import * as path from 'path';

export interface DashboardMetrics {
  timestamp: number;
  gwConnected: boolean;
  health?: unknown;
  status?: unknown;
  presence?: unknown;
  usageCost?: unknown;
  activity: ActivitySnapshot;
}

/** Get label for a session from the agent's sessions.json file */
async function getSessionLabel(sessionKey: string): Promise<string | undefined> {
  // Parse session key: agent:ai_tui:feishu:group:oc_xxx
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
    // label can be at session.label or session.origin.label
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
      gw.call('usage.cost', { days: 30 }).catch(() => null),
    ]);
    result.health = health;
    result.presence = presence;
    result.usageCost = usageCost;

    // Add label to each session from sessions.json
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
