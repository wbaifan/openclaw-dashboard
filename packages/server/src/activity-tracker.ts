import fs from 'fs';
import path from 'path';
import { watch } from 'chokidar';
import { config, getAgentSessionsDirs } from './config.js';
import {
  extractUserText,
  extractAssistantSummary,
  parseMessageContent,
  readFileRegionLines,
  parseJsonLines,
} from './session-parser.js';

const MAX_RECENT_ACTIVITY = 100;
const HISTORY_LOOKBACK_MS = 24 * 3600 * 1000;
const TASK_LOOKBACK_MS = 48 * 3600 * 1000;
const HISTORY_READ_BYTES = 2 * 1024 * 1024;
const TAIL_READ_BYTES = 64 * 1024;

export interface ActivityItem {
  type: 'tool_call' | 'message' | 'user_message';
  ts: string;
  session: string;
  icon: string;
  text?: string;
  tool?: string;
}

export interface ActivityStats {
  messages: number;
  toolCalls: number;
  errors: number;
  lastActivityAt: string | null;
}

export interface TaskItem {
  task: string;
  startedAt: string;
  lastActivityAt: string;
  toolCount: number;
  result: string | null;
  sessionFile: string;
}

export interface ActivitySnapshot {
  recent: ActivityItem[];
  stats: ActivityStats;
  hourlyActivity: number[];
  tasks: TaskItem[];
}

interface FileState {
  offset: number;
}

interface SessionFileInfo {
  filePath: string;
  mtime: number;
  agentName: string;  // Which agent this session belongs to
}

function getSessionDisplayId(filePath: string): string {
  return path.basename(filePath).replace(/\.jsonl(?:\.(?:reset|deleted)\..+)?$/, '').slice(0, 8);
}

export class ActivityTracker {
  private _fileOffsets = new Map<string, FileState>();
  private _recentActivity: ActivityItem[] = [];
  private _stats: ActivityStats = { messages: 0, toolCalls: 0, errors: 0, lastActivityAt: null };
  private _hourlyActivity = new Array<number>(24).fill(0);
  private _agentDirs: { agentName: string; sessionsDir: string }[] = [];
  private _onActivity?: () => void;
  private _isLoadingHistory = false; // Flag to prevent callbacks during history load

  /** Set callback to be invoked when new activity is detected. */
  onActivity(callback: () => void): void {
    this._onActivity = callback;
  }

  /** Start watching session log files for live activity. */
  start(): void {
    // Get all agent directories
    this._agentDirs = getAgentSessionsDirs();
    
    if (this._agentDirs.length === 0) {
      console.error('[activity] No agent sessions directories found');
      return;
    }

    // Log which agents we're tracking
    const agentNames = this._agentDirs.map(a => a.agentName).join(', ');
    console.log(`[activity] Tracking ${this._agentDirs.length} agent(s): ${agentNames}`);

    this._loadHistory();

    // Watch each agent's sessions directory
    for (const { agentName, sessionsDir } of this._agentDirs) {
      try {
        const watcher = watch(sessionsDir, {
          ignoreInitial: false,
          depth: 0,  // 不递归监听子目录
          awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
        });

        watcher.on('add', (filePath) => {
          if (!filePath.endsWith('.jsonl')) return;
          this._initFile(filePath, agentName);
        });

        watcher.on('change', (filePath) => {
          if (!filePath.endsWith('.jsonl')) return;
          this._readNewEntries(filePath, agentName);
        });

        watcher.on('error', (err) => {
          console.error(`[activity] Watcher error for agent ${agentName}:`, (err as Error).message);
        });
      } catch (err) {
        console.error(`[activity] Failed to start watcher for agent ${agentName}:`, (err as Error).message);
      }
    }
  }

  /** Return a snapshot of current activity data for the dashboard. */
  getSnapshot(): ActivitySnapshot {
    return {
      recent: this._recentActivity.slice(0, 30),
      stats: { ...this._stats },
      hourlyActivity: [...this._hourlyActivity],
      tasks: this._extractTasks(),
    };
  }

  // ── History Loading ──────────────────────────────────────

  private _loadHistory(): void {
    this._isLoadingHistory = true; // Prevent callbacks during history load
    try {
      const recentFiles = this._listSessionFiles(HISTORY_LOOKBACK_MS);
      // Load up to 100 files for complete hourly activity coverage
      for (const { filePath } of recentFiles.slice(0, 100)) {
        this._loadRecentFromFile(filePath);
      }

      this._recentActivity.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
      this._recentActivity = this._recentActivity.slice(0, MAX_RECENT_ACTIVITY);
      console.log(`[activity] Loaded ${this._recentActivity.length} historical events from ${this._agentDirs.length} agent(s)`);
    } catch (err) {
      console.error('[activity] History load error:', (err as Error).message);
    } finally {
      this._isLoadingHistory = false;
    }
  }

  private _loadRecentFromFile(filePath: string): void {
    try {
      const stat = fs.statSync(filePath);
      const offset = Math.max(0, stat.size - HISTORY_READ_BYTES);
      const lines = readFileRegionLines(filePath, offset, HISTORY_READ_BYTES);
      const entries = parseJsonLines(lines);  // 读取所有行，不只是最后50行

      for (const entry of entries) {
        this._processEntry(entry, filePath);
      }
    } catch {
      // File may have been removed or be unreadable.
    }
  }

  // ── File Tracking ────────────────────────────────────────

  private _initFile(filePath: string, _agentName: string): void {
    if (this._fileOffsets.has(filePath)) return;
    try {
      const stat = fs.statSync(filePath);
      // Start tracking from end of file (only new entries from now on).
      this._fileOffsets.set(filePath, { offset: stat.size });
    } catch {
      // File may not be accessible.
    }
  }

  private _readNewEntries(filePath: string, _agentName: string): void {
    let state = this._fileOffsets.get(filePath);
    if (!state) {
      // File wasn't tracked yet; initialize and read from current position.
      this._initFile(filePath, _agentName);
      state = this._fileOffsets.get(filePath);
      if (!state) return;
    }

    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= state.offset) {
        state.offset = stat.size;
        return;
      }

      const lines = readFileRegionLines(filePath, state.offset, TAIL_READ_BYTES);
      state.offset = stat.size;

      for (const entry of parseJsonLines(lines)) {
        this._processEntry(entry, filePath);
      }
    } catch {
      // File may have been truncated or removed.
    }
  }

  // ── Entry Processing ─────────────────────────────────────

  private _processEntry(entry: Record<string, unknown>, filePath: string): void {
    if (entry.type !== 'message' || !entry.message) return;

    const msg = entry.message as { role: string; content: unknown };
    const ts = (entry.timestamp as string) || new Date().toISOString();
    const sessionId = getSessionDisplayId(filePath);

    this._recordTimestamp(ts);

    if (msg.role === 'assistant') {
      this._processAssistantMessage(msg, ts, sessionId);
    } else if (msg.role === 'user') {
      this._processUserMessage(msg, ts, sessionId);
    }
    // toolResult messages are intentionally skipped (too noisy).

    // Notify listener that new activity was detected (skip during history load)
    if (!this._isLoadingHistory && this._onActivity) {
      this._onActivity();
    }
  }

  private _processAssistantMessage(msg: Record<string, unknown>, ts: string, sessionId: string): void {
    const { text, toolCalls } = parseMessageContent(msg as { role: string; content: string });

    for (const tc of toolCalls) {
      this._stats.toolCalls++;
      // 过滤掉 exec、read、edit、process、write 工具（不显示在 Live Activity 中）
      if (!['exec', 'read', 'edit', 'process', 'write'].includes(tc.name)) {
        this._addActivity({ type: 'tool_call', tool: tc.name, ts, session: sessionId, icon: '🔧' });
      }
    }

    if (text) {
      this._stats.messages++;
      const summary = extractAssistantSummary(text, 100, 5);
      this._addActivity({
        type: 'message',
        text: summary || text.slice(0, 80),
        ts,
        session: sessionId,
        icon: toolCalls.length > 0 ? '🤖' : '💬',
      });
    }
  }

  private _processUserMessage(msg: Record<string, unknown>, ts: string, sessionId: string): void {
    const { text: rawText } = parseMessageContent(msg as { role: string; content: string });
    const text = this._extractRealUserMessage(rawText);

    if (!text) return;

    this._stats.messages++;
    this._addActivity({ type: 'user_message', text, ts, session: sessionId, icon: '👤' });
  }

  private _recordTimestamp(ts: string): void {
    // Use local timezone hour for correct display
    const date = new Date(ts);
    const localHour = date.getHours();  // getHours() returns local timezone hour
    this._hourlyActivity[localHour] = (this._hourlyActivity[localHour] || 0) + 1;
    this._stats.lastActivityAt = ts;
  }

  private _addActivity(activity: ActivityItem): void {
    this._recentActivity.unshift(activity);
    if (this._recentActivity.length > MAX_RECENT_ACTIVITY) {
      this._recentActivity.pop();
    }
  }

  // ── Task Extraction ──────────────────────────────────────

  private _extractTasks(): TaskItem[] {
    try {
      const recentFiles = this._listSessionFiles(TASK_LOOKBACK_MS, { includeResetArchives: true });
      const tasks: TaskItem[] = [];

      // Load up to 50 files to include more user conversations
      for (const { filePath } of recentFiles.slice(0, 50)) {
        const task = this._extractTaskFromFile(filePath);
        if (task) tasks.push(task);
      }

      tasks.sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime());
      return tasks.slice(0, 15);
    } catch {
      return [];
    }
  }

  private _extractTaskFromFile(filePath: string): TaskItem | null {
    try {
      const stat = fs.statSync(filePath);

      const headLines = readFileRegionLines(filePath, 0, HISTORY_READ_BYTES);
      const tailOffset = Math.max(0, stat.size - TAIL_READ_BYTES);
      const tailLines = tailOffset > 0 ? readFileRegionLines(filePath, tailOffset, TAIL_READ_BYTES) : [];

      let firstUserMsg: { text: string; ts: string } | null = null;
      let lastUserMsg: { text: string; ts: string } | null = null;
      let lastTs: string | null = null;
      let totalToolCalls = 0;
      let lastAssistantSummary = '';

      for (const entry of parseJsonLines(headLines)) {
        if (entry.type !== 'message') continue;
        const msg = entry.message as Record<string, unknown>;
        const ts = entry.timestamp as string;
        lastTs = ts;

        if ((msg as { role: string }).role === 'user') {
          const { text: rawText } = parseMessageContent(msg as { role: string; content: string });
          const text = this._extractRealUserMessage(rawText);
          if (text && !text.startsWith('A new session was started')) {
            // Record the first user message
            if (!firstUserMsg) {
              firstUserMsg = { text, ts };
            }
            // Always update to the latest user message
            lastUserMsg = { text, ts };
          }
        }

        if ((msg as { role: string }).role === 'assistant') {
          const { text, toolCalls } = parseMessageContent(msg as { role: string; content: string });
          totalToolCalls += toolCalls.length;
          const summary = extractAssistantSummary(text);
          if (summary) lastAssistantSummary = summary;
        }
      }

      for (const entry of parseJsonLines(tailLines)) {
        if (entry.type !== 'message') continue;
        if (entry.timestamp) lastTs = entry.timestamp as string;

        const msg = entry.message as { role: string; content: string };
        if (msg.role === 'user') {
          const { text: rawText } = parseMessageContent(msg);
          const text = this._extractRealUserMessage(rawText);
          if (text && !text.startsWith('A new session was started')) {
            // Update to the latest user message from tail
            lastUserMsg = { text, ts: entry.timestamp as string };
          }
        }
        if (msg.role === 'assistant') {
          const { text, toolCalls } = parseMessageContent(msg);
          totalToolCalls += toolCalls.length;
          const summary = extractAssistantSummary(text);
          if (summary) lastAssistantSummary = summary;
        }
      }

      if (!firstUserMsg) return null;

      // Filter out tasks that started more than 48 hours ago
      const startedAtTime = new Date(firstUserMsg.ts).getTime();
      const cutoffTime = Date.now() - TASK_LOOKBACK_MS;
      if (startedAtTime < cutoffTime) {
        return null;
      }

      // Use the last user message for task display, fall back to first if no last
      const taskText = lastUserMsg || firstUserMsg;

      return {
        task: this._extractTaskSummary(taskText.text),
        startedAt: firstUserMsg.ts,
        lastActivityAt: lastTs || firstUserMsg.ts,
        toolCount: totalToolCalls,
        result: lastAssistantSummary || null,
        sessionFile: getSessionDisplayId(filePath),
      };
    } catch {
      return null;
    }
  }

  /**
   * Extract the real user message from Feishu channel messages.
   * Handles special formats like [message_id=om_xxx] patterns.
   * Filters out system messages (subagent, cron, etc.).
   */
  private _extractRealUserMessage(raw: string): string {
    // First use the standard extractor
    let text = extractUserText(raw, 200);
    
    // If we got nothing, return empty
    if (!text) return '';
    
    // Filter out known system message types
    // Note: Feishu messages start with "System: [2026-03-17..." but contain user content
    // We need to extract the actual user message from Feishu format first
    const feishuMatch = text.match(/\[message_id=[^\]]+\]\s*\n+([\s\S]+)/);
    if (feishuMatch && feishuMatch[1]) {
      // This is a Feishu message, extract the actual content
      return feishuMatch[1].trim();
    }
    
    // Now filter out system messages (after Feishu extraction)
    const systemPatterns = [
      'A new session was started',
      '[Subagent Context]',
      '[cron:',
      'Read HEARTBEAT',
      'OpenClaw runtime context',
      'Internal task completion event',
      'Pre-compaction memory flush',
      'Exec completed',
    ];
    
    for (const pattern of systemPatterns) {
      if (text.includes(pattern)) return '';
    }
    
    return text;
  }

  /**
   * Extract a meaningful summary from user task text.
   * Similar to extractAssistantSummary but optimized for user messages.
   * Preserves list items, removes noise, handles multi-line content.
   */
  private _extractTaskSummary(raw: string, maxLen = 200, maxLines = 10): string {
    // Remove Feishu message_id prefix if present
    let text = raw.replace(/\[message_id=[^\]]+\]\s*\n*/g, '');
    
    // Convert Feishu @ tags
    text = text.replace(/<at user_id="[^"]+">([^<]+)<\/at>/g, '@$1');
    
    // Split into lines and filter
    const lines = text
      .split('\n')
      .map(l => l.trim())
      .filter(l => {
        if (!l) return false;
        // Skip noise patterns
        if (l.startsWith('```')) return false;
        if (l.startsWith('{') || l.startsWith('"')) return false;
        if (l.includes('workspace file') || l.includes('exact path')) return false;
        return true;
      })
      .slice(0, maxLines)
      .map(l => l.slice(0, maxLen));
    
    return lines.join('\n') || text.slice(0, maxLen);
  }

  // ── Utilities ────────────────────────────────────────────

  private _listSessionFiles(lookbackMs: number, options?: { includeResetArchives?: boolean }): SessionFileInfo[] {
    const includeResetArchives = options?.includeResetArchives ?? false;
    const cutoff = Date.now() - lookbackMs;
    const allFiles: SessionFileInfo[] = [];

    // Scan all agent directories
    for (const { agentName, sessionsDir } of this._agentDirs) {
      try {
        const files = fs.readdirSync(sessionsDir).filter((f) => {
          if (f.endsWith('.jsonl')) return true;
          if (includeResetArchives && /\.jsonl\.reset\./.test(f)) return true;
          return false;
        });

        for (const f of files) {
          const filePath = path.join(sessionsDir, f);
          try {
            const mtime = fs.statSync(filePath).mtimeMs;
            if (mtime > cutoff) {
              allFiles.push({ filePath, mtime, agentName });
            }
          } catch {
            // File may have been removed
          }
        }
      } catch {
        // Directory may not be accessible, skip
      }
    }

    // Sort by modification time (most recent first)
    return allFiles.sort((a, b) => b.mtime - a.mtime);
  }
}
