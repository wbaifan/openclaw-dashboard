const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const { execSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = process.env.PORT || 3210;
const GW_PORT = process.env.GW_PORT || process.env.OPENCLAW_GATEWAY_PORT || 18789;
const IDENTITY_FILE = path.join(__dirname, '.device-identity.json');
const SESSIONS_DIR = path.join(process.env.HOME, '.openclaw/agents/main/sessions');

// --- Gateway token ---
function resolveGatewayToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  if (process.env.GW_TOKEN) return process.env.GW_TOKEN;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.openclaw/openclaw.json'), 'utf-8'));
    const token = config?.gateway?.auth?.token;
    if (typeof token === 'string' && token && !token.startsWith('__OPENCLAW')) return token;
  } catch {}
  return '';
}
const GW_TOKEN = resolveGatewayToken();

app.use(express.static(path.join(__dirname, 'public')));

// --- Crypto (matching OpenClaw gateway device auth) ---
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
function base64UrlEncode(buf) { return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, ''); }
function derivePublicKeyRaw(pem) {
  const spki = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return (spki.length === ED25519_SPKI_PREFIX.length + 32 && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX))
    ? spki.subarray(ED25519_SPKI_PREFIX.length) : spki;
}
function fingerprintPublicKey(pem) { return crypto.createHash('sha256').update(derivePublicKeyRaw(pem)).digest('hex'); }
function signPayload(privPem, payload) { return base64UrlEncode(crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(privPem))); }
function normalizeMetadata(v) { return (typeof v === 'string' && v.trim()) ? v.trim().toLowerCase() : ''; }

function loadOrCreateIdentity() {
  if (fs.existsSync(IDENTITY_FILE)) {
    const d = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
    d.deviceId = fingerprintPublicKey(d.publicKeyPem);
    return d;
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const identity = {
    deviceId: '',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
  identity.deviceId = fingerprintPublicKey(identity.publicKeyPem);
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 });
  return identity;
}
const deviceIdentity = loadOrCreateIdentity();

// --- Gateway WS Client ---
class GatewayClient {
  constructor() { this.ws = null; this.connected = false; this.pending = new Map(); this.reqId = 0; this._rt = null; }

  connect() {
    if (this._rt) { clearTimeout(this._rt); this._rt = null; }
    const url = `ws://127.0.0.1:${GW_PORT}`;
    this.ws = new WebSocket(url);
    this.ws.on('message', d => { try { this._handle(JSON.parse(d.toString())); } catch {} });
    this.ws.on('open', () => console.log('[gw] Connected, awaiting challenge...'));
    this.ws.on('close', () => { this.connected = false; this._rt = setTimeout(() => this.connect(), 5000); });
    this.ws.on('error', e => console.error('[gw] Error:', e.message));
  }

  _handle(msg) {
    if (msg.type === 'event' && msg.event === 'connect.challenge') { this._auth(msg.payload); return; }
    if (msg.type === 'res') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.ok) {
        if (msg.payload?.type === 'hello-ok') { this.connected = true; console.log('[gw] ✅ Ready'); }
        p.resolve(msg.payload);
      } else { p.reject(new Error(msg.error?.message || 'RPC error')); }
    }
  }

  _auth(challenge) {
    const nonce = challenge?.nonce || '';
    const signedAtMs = Date.now();
    const scopes = ['operator.read', 'operator.write', 'operator.admin'];
    const payload = ['v3', deviceIdentity.deviceId, 'gateway-client', 'backend', 'operator',
      scopes.join(','), String(signedAtMs), GW_TOKEN || '', nonce,
      normalizeMetadata('linux'), normalizeMetadata('Linux')].join('|');
    const sig = signPayload(deviceIdentity.privateKeyPem, payload);
    const id = this._nextId();
    this.pending.set(id, {
      resolve: () => {}, reject: e => console.error('[gw] Auth failed:', e.message),
      timer: setTimeout(() => this.pending.delete(id), 10000),
    });
    this.ws.send(JSON.stringify({ type: 'req', id, method: 'connect', params: {
      minProtocol: 3, maxProtocol: 3,
      client: { id: 'gateway-client', version: '0.1.0', platform: 'linux', deviceFamily: 'Linux', mode: 'backend' },
      role: 'operator', scopes, caps: [], commands: [], permissions: {},
      locale: 'zh-CN', userAgent: 'openclaw-dashboard/0.1.0',
      ...(GW_TOKEN ? { auth: { token: GW_TOKEN } } : {}),
      device: { id: deviceIdentity.deviceId, publicKey: base64UrlEncode(derivePublicKeyRaw(deviceIdentity.publicKeyPem)), signature: sig, signedAt: signedAtMs, nonce },
    }}));
  }

  _nextId() { return 'd-' + (++this.reqId); }

  async call(method, params = {}, timeout = 10000) {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) throw new Error('Not connected');
    const id = this._nextId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }
}
const gw = new GatewayClient();

// --- Activity tracker: tail session logs for live events ---
class ActivityTracker {
  constructor() {
    this.watchers = new Map(); // sessionFile -> { watcher, offset }
    this.recentActivity = []; // last N activities
    this.maxActivity = 100;
    this.stats = { messages: 0, toolCalls: 0, errors: 0, lastActivityAt: null };
    this.hourlyActivity = new Array(24).fill(0); // activity per hour today
  }

  start() {
    this._scan();
    this._loadHistory();
    this._scanInterval = setInterval(() => this._scan(), 30000);
  }

  // Load recent history from session files on startup
  _loadHistory() {
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'));
      const fileStats = files.map(f => {
        const fp = path.join(SESSIONS_DIR, f);
        try { return { fp, mtime: fs.statSync(fp).mtimeMs }; } catch { return null; }
      }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);

      // Only scan recently active files (modified in last 24h)
      const cutoff = Date.now() - 24 * 3600 * 1000;
      const recent = fileStats.filter(f => f.mtime > cutoff);

      for (const { fp } of recent.slice(0, 5)) {
        this._loadRecentFromFile(fp);
      }

      // Sort by timestamp
      this.recentActivity.sort((a, b) => new Date(b.ts) - new Date(a.ts));
      this.recentActivity = this.recentActivity.slice(0, this.maxActivity);
      console.log(`[activity] Loaded ${this.recentActivity.length} historical events`);
    } catch (e) {
      console.error('[activity] History load error:', e.message);
    }
  }

  _loadRecentFromFile(fp) {
    try {
      // Read last 128KB of file
      const stat = fs.statSync(fp);
      const readSize = Math.min(stat.size, 128 * 1024);
      const fd = fs.openSync(fp, 'r');
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      fs.closeSync(fd);

      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      // Process last 50 entries
      for (const line of lines.slice(-50)) {
        try {
          const entry = JSON.parse(line);
          this._processEntry(entry, fp);
        } catch {}
      }
    } catch {}
  }

  _scan() {
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const fp = path.join(SESSIONS_DIR, file);
        if (!this.watchers.has(fp)) {
          const stat = fs.statSync(fp);
          // Start from end of file (only track new activity)
          this.watchers.set(fp, { offset: stat.size });
          this._watch(fp);
        }
      }
    } catch {}
  }

  _watch(fp) {
    try {
      const watcher = fs.watch(fp, () => this._readNew(fp));
      // Store watcher ref for cleanup if needed
    } catch {}
  }

  _readNew(fp) {
    const state = this.watchers.get(fp);
    if (!state) return;
    try {
      const stat = fs.statSync(fp);
      if (stat.size <= state.offset) { state.offset = stat.size; return; }
      const fd = fs.openSync(fp, 'r');
      const buf = Buffer.alloc(Math.min(stat.size - state.offset, 64 * 1024));
      fs.readSync(fd, buf, 0, buf.length, state.offset);
      fs.closeSync(fd);
      state.offset = stat.size;
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          this._processEntry(entry, fp);
        } catch {}
      }
    } catch {}
  }

  _processEntry(entry, fp) {
    if (entry.type !== 'message') return;
    const msg = entry.message;
    if (!msg) return;

    const ts = entry.timestamp || new Date().toISOString();
    const hour = new Date(ts).getHours();
    this.hourlyActivity[hour] = (this.hourlyActivity[hour] || 0) + 1;
    this.stats.lastActivityAt = ts;

    // Extract session ID from filepath
    const sessionId = path.basename(fp, '.jsonl').slice(0, 8);

    if (msg.role === 'assistant') {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const toolCalls = content.filter(c => c.type === 'toolCall');
      const textParts = content.filter(c => c.type === 'text');

      for (const tc of toolCalls) {
        this.stats.toolCalls++;
        this._addActivity({
          type: 'tool_call',
          tool: tc.name,
          ts,
          session: sessionId,
          icon: '🔧',
        });
      }
      if (textParts.length > 0) {
        this.stats.messages++;
        const fullText = textParts.map(p => p.text || '').join('');
        // Extract first meaningful line as summary
        const text = fullText.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('```') && !l.startsWith('|') && l.length > 5)[0]?.slice(0, 100) || fullText.slice(0, 80);
        this._addActivity({
          type: 'message',
          text,
          ts,
          session: sessionId,
          icon: toolCalls.length > 0 ? '🤖' : '💬',
        });
      }
    } else if (msg.role === 'user') {
      this.stats.messages++;
      let text = typeof msg.content === 'string' ? msg.content
        : Array.isArray(msg.content) ? msg.content.filter(c => c.type === 'text').map(c => c.text).join('')
        : '';
      // Strip system metadata noise
      text = text.replace(/^System:.*$/gm, '').replace(/^Conversation info.*$/gm, '').replace(/^Sender.*$/gm, '')
        .replace(/```json[\s\S]*?```/g, '').replace(/\[media attached:.*?\]/g, '[📎 media]')
        .split('\n').map(l => l.trim()).filter(l => l && l.length > 3 && !l.startsWith('{') && !l.startsWith('"'))[0]?.slice(0, 100) || '';
      if (!text || text.startsWith('Read HEARTBEAT')) return; // Skip heartbeat polls
      this._addActivity({
        type: 'user_message',
        text,
        ts,
        session: sessionId,
        icon: '👤',
      });
    } else if (msg.role === 'toolResult') {
      // Don't add to activity list (too noisy) but count it
    }
  }

  _addActivity(activity) {
    this.recentActivity.unshift(activity);
    if (this.recentActivity.length > this.maxActivity) this.recentActivity.pop();
  }

  getSnapshot() {
    return {
      recent: this.recentActivity.slice(0, 30),
      stats: { ...this.stats },
      hourlyActivity: [...this.hourlyActivity],
      tasks: this._extractTasks(),
    };
  }

  // Extract task summaries from session logs
  _extractTasks() {
    const tasks = [];
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'));
      const fileStats = files.map(f => {
        const fp = path.join(SESSIONS_DIR, f);
        try { return { fp, mtime: fs.statSync(fp).mtimeMs, name: f }; } catch { return null; }
      }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);

      // Scan recent files (last 48h)
      const cutoff = Date.now() - 48 * 3600 * 1000;
      for (const { fp, mtime } of fileStats.filter(f => f.mtime > cutoff).slice(0, 8)) {
        this._extractTasksFromFile(fp, mtime, tasks);
      }

      // Sort by start time descending
      tasks.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
      return tasks.slice(0, 15);
    } catch { return []; }
  }

  _extractTasksFromFile(fp, fileMtime, tasks) {
    try {
      const stat = fs.statSync(fp);
      // Read beginning (for first user message) and end (for last activity)
      const headSize = Math.min(stat.size, 128 * 1024);
      const tailSize = Math.min(stat.size, 64 * 1024);
      const fd = fs.openSync(fp, 'r');

      const headBuf = Buffer.alloc(headSize);
      fs.readSync(fd, headBuf, 0, headSize, 0);

      const tailBuf = Buffer.alloc(tailSize);
      fs.readSync(fd, tailBuf, 0, tailSize, Math.max(0, stat.size - tailSize));
      fs.closeSync(fd);

      // Merge lines, dedup by using a set isn't needed - just process head for first msg, tail for last ts
      const headLines = headBuf.toString('utf8').split('\n').filter(Boolean);
      const tailLines = tailBuf.toString('utf8').split('\n').filter(Boolean);

      let firstUserMsg = null;
      let lastTs = null;
      let totalToolCalls = 0;
      let lastAssistantText = '';

      // Scan head for first user message and tool counts
      for (const line of headLines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type !== 'message') continue;
          const msg = entry.message;
          const ts = entry.timestamp;
          lastTs = ts;

          if (msg.role === 'user' && !firstUserMsg) {
            let text = typeof msg.content === 'string' ? msg.content
              : Array.isArray(msg.content) ? msg.content.filter(c => c.type === 'text').map(c => c.text).join('') : '';

            // Clean system noise
            text = text.replace(/^System:.*$/gm, '').replace(/^Conversation info.*$/gm, '')
              .replace(/^Sender.*$/gm, '').replace(/```json[\s\S]*?```/g, '')
              .replace(/\[media attached:.*?\]/g, '').replace(/\[image data.*?\]/g, '')
              .split('\n').map(l => l.trim())
              .filter(l => l && l.length > 3 && !l.startsWith('{') && !l.startsWith('"') && !l.startsWith('Read HEARTBEAT'))[0] || '';

            if (text && !text.startsWith('A new session was started')) {
              firstUserMsg = { text, ts };
            }
          }

          if (msg.role === 'assistant') {
            const content = Array.isArray(msg.content) ? msg.content : [];
            totalToolCalls += content.filter(c => c.type === 'toolCall').length;
            const texts = content.filter(c => c.type === 'text');
            if (texts.length > 0) {
              const full = texts.map(p => p.text || '').join('');
              const summary = full.split('\n').map(l => l.trim())
                .filter(l => l && !l.startsWith('#') && !l.startsWith('```') && !l.startsWith('|') && !l.startsWith('-') && l.length > 8)[0]?.slice(0, 80) || '';
              if (summary) lastAssistantText = summary;
            }
          }
        } catch {}
      }

      // Scan tail for latest timestamps, tool counts, and last assistant text
      for (const line of tailLines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type !== 'message') continue;
          const msg = entry.message;
          if (entry.timestamp) lastTs = entry.timestamp;

          if (msg.role === 'assistant') {
            const content = Array.isArray(msg.content) ? msg.content : [];
            totalToolCalls += content.filter(c => c.type === 'toolCall').length;
            const texts = content.filter(c => c.type === 'text');
            if (texts.length > 0) {
              const full = texts.map(p => p.text || '').join('');
              const summary = full.split('\n').map(l => l.trim())
                .filter(l => l && !l.startsWith('#') && !l.startsWith('```') && !l.startsWith('|') && !l.startsWith('-') && l.length > 8)[0]?.slice(0, 80) || '';
              if (summary) lastAssistantText = summary;
            }
          }
        } catch {}
      }

      if (firstUserMsg) {
        tasks.push({
          task: firstUserMsg.text.slice(0, 120),
          startedAt: firstUserMsg.ts,
          lastActivityAt: lastTs || firstUserMsg.ts,
          toolCount: totalToolCalls,
          result: lastAssistantText || null,
          sessionFile: path.basename(fp, '.jsonl').slice(0, 8),
        });
      }
    } catch {}
  }
}

const tracker = new ActivityTracker();

// --- Metrics ---
async function collectMetrics() {
  const result = { timestamp: Date.now(), gwConnected: gw.connected };

  if (gw.connected) {
    const [health, status, presence] = await Promise.all([
      gw.call('health').catch(() => null),
      gw.call('status').catch(() => null),
      gw.call('system-presence').catch(() => null),
    ]);
    result.health = health;
    result.status = status;
    result.presence = presence;
  }

  // usage-cost via CLI
  try {
    const raw = execSync('openclaw gateway usage-cost --json 2>/dev/null', {
      encoding: 'utf-8', timeout: 15000, env: { ...process.env, NO_COLOR: '1' },
    }).trim();
    const idx = raw.indexOf('{');
    if (idx >= 0) result.usageCost = JSON.parse(raw.slice(idx));
  } catch {}

  // Activity data
  result.activity = tracker.getSnapshot();

  return result;
}

// REST
app.get('/api/metrics', async (req, res) => {
  try { res.json(await collectMetrics()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// WS push
let latestMetrics = null;
let clientCount = 0;
wss.on('connection', ws => {
  clientCount++;
  if (latestMetrics) ws.send(JSON.stringify({ type: 'metrics', data: latestMetrics }));
  ws.on('close', () => clientCount--);
});
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

async function updateLoop() {
  try {
    latestMetrics = await collectMetrics();
    broadcast({ type: 'metrics', data: latestMetrics });
  } catch (e) { console.error('[update]', e.message); }
  setTimeout(updateLoop, 10000);
}

process.on('uncaughtException', e => console.error('[fatal]', e.message));
process.on('unhandledRejection', e => console.error('[rejection]', e?.message || e));

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dashboard] 🦐 http://127.0.0.1:${PORT}`);
  gw.connect();
  tracker.start();
  setTimeout(updateLoop, 3000);
});
