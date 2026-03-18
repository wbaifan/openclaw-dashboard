import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import fs from 'fs';
import { config } from './config.js';
import { GatewayClient } from './gateway-client.js';
import { ActivityTracker } from './activity-tracker.js';
import { collectMetrics, type DashboardMetrics } from './metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPDATE_INTERVAL_MS = 10000;
const STARTUP_DELAY_MS = 3000;
const DEBOUNCE_MS = 100; // Debounce activity updates to avoid spamming
const HOME = process.env.HOME || process.env.USERPROFILE || '/root';
const OPENCLAW_HOME = path.join(HOME, '.openclaw');

// ── Express & WebSocket Setup ──────────────────────────────

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, 'public')));

// ── Services ───────────────────────────────────────────────

const gw = new GatewayClient();
const tracker = new ActivityTracker();

// ── REST API ───────────────────────────────────────────────

app.get('/api/metrics', async (_req, res) => {
  try {
    res.json(await collectMetrics(gw, tracker));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// 获取 agent 名字（从 IDENTITY.md 解析）
app.get('/api/agent-name', async (_req, res) => {
  try {
    const identityPath = path.join(OPENCLAW_HOME, 'workspace', 'IDENTITY.md');
    const content = fs.readFileSync(identityPath, 'utf-8');
    
    // 解析 Name 字段
    const nameMatch = content.match(/-?\s*\*\*Name:\*\*\s*(.+)/m);
    let name = nameMatch ? nameMatch[1].trim() : 'OpenClaw';
    
    // 如果名字包含括号，只取括号前的部分（如 "小云子 (Xiaoyunzi)" → "小云子"）
    const parenIndex = name.indexOf('(');
    if (parenIndex > 0) {
      name = name.substring(0, parenIndex).trim();
    }
    
    // 解析 Emoji 字段
    const emojiMatch = content.match(/-?\s*\*\*Emoji:\*\*\s*(.+)/m);
    const emoji = emojiMatch ? emojiMatch[1].trim() : '🦐';
    
    res.json({ name, emoji });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── WebSocket Push ─────────────────────────────────────────

let latestMetrics: DashboardMetrics | null = null;
let updatePending = false;
let lastUpdateTime = 0;

wss.on('connection', (ws) => {
  if (latestMetrics) {
    ws.send(JSON.stringify({ type: 'metrics', data: latestMetrics }));
  }
});

function broadcast(data: { type: string; data: DashboardMetrics }): void {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// Debounced update: push immediately on activity, but avoid spamming
async function pushUpdate(): Promise<void> {
  const now = Date.now();
  
  // Debounce: if we pushed very recently, skip this update
  if (now - lastUpdateTime < DEBOUNCE_MS && updatePending) {
    return;
  }
  
  updatePending = true;
  
  try {
    latestMetrics = await collectMetrics(gw, tracker);
    broadcast({ type: 'metrics', data: latestMetrics });
    lastUpdateTime = now;
  } catch (err) {
    console.error('[update]', (err as Error).message);
  } finally {
    updatePending = false;
  }
}

// ── Update Loop (fallback) ──────────────────────────────────

async function updateLoop(): Promise<void> {
  await pushUpdate();
  setTimeout(updateLoop, UPDATE_INTERVAL_MS);
}

// ── Error Handling ─────────────────────────────────────────

process.on('uncaughtException', (err) => console.error('[fatal]', err.message));
process.on('unhandledRejection', (err) => console.error('[rejection]', (err as Error)?.message ?? err));

// ── Start ──────────────────────────────────────────────────

server.listen(config.port, config.host, () => {
  console.log(`[dashboard] 🦐 http://${config.host}:${config.port}`);
  gw.connect();
  
  // Set up real-time activity push
  tracker.onActivity(() => {
    // Push update immediately when activity is detected
    pushUpdate().catch(err => console.error('[activity-push]', (err as Error).message));
  });
  
  tracker.start();
  
  // Initial update after startup
  setTimeout(updateLoop, STARTUP_DELAY_MS);
});
