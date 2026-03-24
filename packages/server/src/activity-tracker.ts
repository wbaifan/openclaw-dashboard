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
  Message,
  ContentPart,
} from './session-parser.js';

const MAX_RECENT_ACTIVITY = 100; // Number of recent activities to keep in memory
const HISTORY_LOOKBACK_MS = 24 * 3600 * 1000;
const TASK_LOOKBACK_MS = 7 * 24 * 3600 * 1000; // 7 days to show more historical tasks
const HISTORY_READ_BYTES = 5 * 1024 * 1024; // Increased to 5MB to handle large session files
const TAIL_READ_BYTES = 64 * 1024;

/**
 * Get local date string in YYYY-MM-DD format.
 * Uses local timezone instead of UTC.
 */
function getLocalDateString(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Cache file for incremental scanning
const CACHE_FILE = path.join(process.env.HOME || '/root', '.openclaw', 'dashboard-cache.json');
const CACHE_VERSION = 3; // Increment when cache structure changes (v3: added hourlyBuckets)

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
  date: string | null;  // 记录统计日期 (YYYY-MM-DD)
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
  mtime?: number;  // File modification time when last scanned
}

interface SessionFileInfo {
  filePath: string;
  mtime: number;
  agentName: string;  // Which agent this session belongs to
}

interface ScanCache {
  version: number;
  lastScanTime: number;
  fileOffsets: Map<string, FileState>;
  activities?: ActivityItem[];
  hourlyBuckets?: Map<string, number>;
  stats?: ActivityStats | null;
}

function getSessionDisplayId(filePath: string): string {
  return path.basename(filePath).replace(/\.jsonl(?:\.(?:reset|deleted)\..+)?$/, '').slice(0, 8);
}

export class ActivityTracker {
  private _fileOffsets = new Map<string, FileState>();
  private _recentActivity: ActivityItem[] = [];
  private _stats: ActivityStats = { messages: 0, toolCalls: 0, errors: 0, lastActivityAt: null, date: null };
  private _hourlyBuckets: Map<string, number> = new Map();
  private _lastSnapshotTime = 0;
  private _cachedHourlyActivity: number[] | null = null;
  private _agentDirs: { agentName: string; sessionsDir: string }[] = [];
  private _onActivity?: () => void;
  private _isLoadingHistory = false; // Flag to prevent callbacks during history load
  private _lastCacheSaveTime = 0; // For cache save throttling
  private _cacheSavePending = false; // Flag to track pending saves

  /** Set callback to be invoked when new activity is detected. */
  onActivity(callback: () => void): void {
    this._onActivity = callback;
  }

  /** Start watching session log files for live activity. */
  async start(): Promise<void> {
    // Get all agent directories
    this._agentDirs = getAgentSessionsDirs();
    
    if (this._agentDirs.length === 0) {
      console.error('[activity] No agent sessions directories found');
      return;
    }

    // Log which agents we're tracking
    const agentNames = this._agentDirs.map(a => a.agentName).join(', ');
    console.log(`[activity] Tracking ${this._agentDirs.length} agent(s): ${agentNames}`);

    await this._loadHistory();

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
    const hourlyActivity = this._computeHourlyActivity();
    
    // 确保返回前按时间戳排序（最新的在前）
    const sortedRecent = [...this._recentActivity]
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
      .slice(0, 30);
    
    return {
      recent: sortedRecent,
      stats: { ...this._stats },
      hourlyActivity,
      tasks: this._extractTasks(),
    };
  }

  /** Compute hourly activity for last 24 hours (with 1-minute cache). */
  private _computeHourlyActivity(): number[] {
    const now = Date.now();
    
    // Use cache if computed within the last minute
    if (this._cachedHourlyActivity && now - this._lastSnapshotTime < 60000) {
      return this._cachedHourlyActivity;
    }
    
    const hourlyActivity = new Array<number>(24).fill(0);
    
    this._hourlyBuckets.forEach((count, hourKey) => {
      const [datePart, hourPart] = hourKey.split('T');
      const [year, month, day] = datePart.split('-').map(Number);
      const hour = parseInt(hourPart);
      
      // Calculate the timestamp for this hour bucket
      const hourTimestamp = new Date(year, month, day, hour).getTime();
      const hoursAgo = (now - hourTimestamp) / (1000 * 60 * 60);
      
      // Only count data from last 24 hours
      if (hoursAgo >= 0 && hoursAgo < 24) {
        hourlyActivity[hour] = count;
      }
    });
    
    this._cachedHourlyActivity = hourlyActivity;
    this._lastSnapshotTime = now;
    
    return hourlyActivity;
  }

  // ── History Loading ──────────────────────────────────────

  private async _loadHistory(): Promise<void> {
    this._isLoadingHistory = true; // Prevent callbacks during history load
    try {
      // Load cached scanning state
      const cache = this._loadCache();
      
      // Check if we have valid cached stats from today
      const hasCachedStats = cache.stats && cache.stats.date === getLocalDateString();
      
      // Clean up stale cache entries (files not seen in recent list)
      const recentFiles = this._listSessionFiles(HISTORY_LOOKBACK_MS, { 
        includeDeletedArchives: true,
        includeResetArchives: true 
      });
      const recentFilePaths = new Set(recentFiles.map(f => f.filePath));
      let staleEntriesRemoved = 0;
      
      for (const [filePath] of cache.fileOffsets) {
        if (!recentFilePaths.has(filePath)) {
          cache.fileOffsets.delete(filePath);
          staleEntriesRemoved++;
        }
      }
      
      if (staleEntriesRemoved > 0) {
        console.log('[activity] Removed', staleEntriesRemoved, 'stale cache entries');
      }
      
      let filesScanned = 0;
      let filesSkipped = 0;
      let bytesSkipped = 0;
      
      // Load up to 100 files for complete hourly activity coverage
      for (const { filePath, mtime } of recentFiles) {
        const cachedState = cache.fileOffsets.get(filePath);
        
        // Check if we can skip this file (unchanged since last scan)
        if (cachedState && cachedState.mtime === mtime) {
          // File hasn't been modified, skip reading
          this._fileOffsets.set(filePath, { offset: cachedState.offset, mtime });
          filesSkipped++;
          bytesSkipped += cachedState.offset; // Approximate
          continue;
        }
        
        // File is new or modified, scan it
        this._loadRecentFromFile(filePath, mtime, cachedState);
        filesScanned++;
      }

      this._recentActivity.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
      this._recentActivity = this._recentActivity.slice(0, MAX_RECENT_ACTIVITY);
      
      // Recompute stats from complete history if not cached
      if (!hasCachedStats) {
        await this._computeStatsFromHistory();
      }
      
      // Save updated cache
      this._saveCache();
      
      console.log(`[activity] Loaded ${this._recentActivity.length} historical events (scanned ${filesScanned}, skipped ${filesSkipped} files, ~${(bytesSkipped / 1024 / 1024).toFixed(1)}MB saved)`);
      console.log(`[activity] Stats: ${this._stats.messages} messages, ${this._stats.toolCalls} tool calls${hasCachedStats ? ' (from cache)' : ' (recomputed from complete files)'}`);
    } catch (err) {
      console.error('[activity] History load error:', (err as Error).message);
    } finally {
      this._isLoadingHistory = false;
    }
  }

  /**
   * Compute stats from complete history by reading entire files.
   * This ensures accurate statistics even for large files that exceed HISTORY_READ_BYTES.
   */
  private async _computeStatsFromHistory(): Promise<void> {
    const todayStr = getLocalDateString();
    const recentFiles = this._listSessionFiles(HISTORY_LOOKBACK_MS, { 
      includeDeletedArchives: true,
      includeResetArchives: true 
    });
    
    let messages = 0;
    let toolCalls = 0;
    let filesProcessed = 0;
    
    const filePromises = recentFiles.map(async ({ filePath }) => {
      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        let fileMessages = 0;
        let fileToolCalls = 0;
        
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type !== 'message') continue;
            
            const ts = entry.timestamp as string;
            const msgDate = new Date(ts);
            const msgDateStr = getLocalDateString(msgDate);
            
            if (msgDateStr !== todayStr) continue;
            
            const msg = entry.message as { role: string; content: string | ContentPart[] };
            if (msg.role === 'user') {
              fileMessages++;
            } else if (msg.role === 'assistant') {
              const { text, toolCalls: tc } = parseMessageContent(msg as Message);
              if (text) fileMessages++;
              fileToolCalls += tc.length;
            }
          } catch {
            // Skip malformed lines
          }
        }
        return { messages: fileMessages, toolCalls: fileToolCalls, processed: 1 };
      } catch {
        return { messages: 0, toolCalls: 0, processed: 0 };
      }
    });
    
    const results = await Promise.all(filePromises);
    
    for (const result of results) {
      messages += result.messages;
      toolCalls += result.toolCalls;
      filesProcessed += result.processed;
    }
    
    this._stats = { messages, toolCalls, errors: 0, lastActivityAt: null, date: todayStr };
    console.log(`[activity] Computed stats from ${filesProcessed} complete files: ${messages} messages, ${toolCalls} tool calls`);
  }

  private _loadRecentFromFile(filePath: string, mtime: number, cachedState?: FileState): void {
    try {
      const stat = fs.statSync(filePath);
      
      // If we have a cached state and file hasn't shrunk, read only the new part
      if (cachedState && stat.size > cachedState.offset) {
        // Incremental read: only read new data
        const newBytes = stat.size - cachedState.offset;
        const lines = readFileRegionLines(filePath, cachedState.offset, newBytes);
        const entries = parseJsonLines(lines);

        for (const entry of entries) {
          this._processEntry(entry, filePath);
        }

        this._fileOffsets.set(filePath, { offset: stat.size, mtime });
        return;
      }
      
      // Full read: file is new or shrunk (e.g., reset)
      const offset = Math.max(0, stat.size - HISTORY_READ_BYTES);
      const lines = readFileRegionLines(filePath, offset, HISTORY_READ_BYTES);
      const entries = parseJsonLines(lines);

      for (const entry of entries) {
        this._processEntry(entry, filePath);
      }

      this._fileOffsets.set(filePath, { offset: stat.size, mtime });
    } catch {
      // File may have been removed or be unreadable.
    }
  }

  // ── Cache Management ────────────────────────────────────

  private _loadCache(): ScanCache {
    try {
      const data = fs.readFileSync(CACHE_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      
      // Validate version
      if (parsed.version !== CACHE_VERSION) {
        console.log('[activity] Cache version mismatch, starting fresh');
        return this._createEmptyCache();
      }
      
      // Convert plain object back to Map
      const fileOffsets = new Map<string, FileState>();
      if (parsed.fileOffsets && typeof parsed.fileOffsets === 'object') {
        for (const [key, value] of Object.entries(parsed.fileOffsets)) {
          fileOffsets.set(key, value as FileState);
        }
      }
      
      // Restore activity history if available (v2 cache)
      if (parsed.activities && Array.isArray(parsed.activities)) {
        this._recentActivity = parsed.activities;
        console.log('[activity] Restored', this._recentActivity.length, 'cached activities');
      }
      
      // Restore hourly buckets if available (v3 cache)
      if (parsed.hourlyBuckets && typeof parsed.hourlyBuckets === 'object') {
        const buckets = new Map<string, number>();
        for (const [key, value] of Object.entries(parsed.hourlyBuckets)) {
          if (typeof value === 'number') {
            buckets.set(key, value);
          } else if (Array.isArray(value)) {
            buckets.set(key, value.length);
          }
        }
        this._hourlyBuckets = buckets;
        console.log('[activity] Restored', this._hourlyBuckets.size, 'hourly buckets');
      }
      
      // Restore stats if available and from today (v3 cache)
      if (parsed.stats && parsed.stats.date === getLocalDateString()) {
        this._stats = parsed.stats;
        console.log('[activity] Restored stats from cache:', this._stats.messages, 'messages,', this._stats.toolCalls, 'tool calls');
      }
      
      console.log('[activity] Loaded cache with', fileOffsets.size, 'file states');
      return { ...parsed, fileOffsets };
    } catch (err) {
      // Cache doesn't exist or is invalid, start fresh
      return this._createEmptyCache();
    }
  }

  private _saveCache(): void {
    const now = Date.now();
    const MIN_SAVE_INTERVAL = 5000; // 5 seconds
    
    // Throttle cache saves to avoid excessive disk writes
    if (now - this._lastCacheSaveTime < MIN_SAVE_INTERVAL) {
      if (!this._cacheSavePending) {
        this._cacheSavePending = true;
        setTimeout(() => {
          this._saveCache();
        }, MIN_SAVE_INTERVAL - (now - this._lastCacheSaveTime));
      }
      return;
    }
    
    try {
      const cache: ScanCache = {
        version: CACHE_VERSION,
        lastScanTime: Date.now(),
        fileOffsets: this._fileOffsets,
        activities: this._recentActivity,  // Save activity history
        hourlyBuckets: this._hourlyBuckets,  // Save hourly buckets (v3)
        stats: this._stats,  // Save stats (v3)
      };
      
      // Convert Map to plain object for JSON serialization
      const serializable = {
        version: cache.version,
        lastScanTime: cache.lastScanTime,
        fileOffsets: Object.fromEntries(cache.fileOffsets),
        activities: cache.activities,  // Include activities in saved cache
        hourlyBuckets: Object.fromEntries(cache.hourlyBuckets || new Map()),  // Include hourly buckets
        stats: cache.stats,  // Include stats in saved cache
      };
      
      // Ensure directory exists
      const dir = path.dirname(CACHE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(CACHE_FILE, JSON.stringify(serializable, null, 2));
      this._lastCacheSaveTime = now;
      this._cacheSavePending = false;
      console.log('[activity] Saved cache with', cache.fileOffsets.size, 'file states');
    } catch (err) {
      console.error('[activity] Failed to save cache:', (err as Error).message);
      this._cacheSavePending = false;
    }
  }

  private _createEmptyCache(): ScanCache {
    return {
      version: CACHE_VERSION,
      lastScanTime: 0,
      fileOffsets: new Map<string, FileState>(),
    };
  }

  // ── File Tracking ────────────────────────────────────────

  private _initFile(filePath: string, _agentName: string): void {
    if (this._fileOffsets.has(filePath)) return;
    try {
      const stat = fs.statSync(filePath);
      // Start tracking from end of file (only new entries from now on).
      this._fileOffsets.set(filePath, { offset: stat.size, mtime: stat.mtimeMs });
      
      // Save cache periodically (on new files)
      this._saveCache();
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
        state.mtime = stat.mtimeMs;
        return;
      }

      const lines = readFileRegionLines(filePath, state.offset, TAIL_READ_BYTES);
      state.offset = stat.size;
      state.mtime = stat.mtimeMs;

      for (const entry of parseJsonLines(lines)) {
        this._processEntry(entry, filePath);
      }
      
      // Save cache periodically (on file changes)
      this._saveCache();
    } catch {
      // File may have been truncated or removed.
    }
  }

  // ── Entry Processing ─────────────────────────────────────

  /** Check if stats need to be reset (new day). */
  private _checkAndResetStats(): void {
    const todayStr = getLocalDateString();
    if (this._stats.date !== todayStr) {
      this._stats = { messages: 0, toolCalls: 0, errors: 0, lastActivityAt: null, date: todayStr };
    }
  }

  private _processEntry(entry: Record<string, unknown>, filePath: string): void {
    if (entry.type !== 'message' || !entry.message) return;

    const msg = entry.message as { role: string; content: unknown };
    const ts = (entry.timestamp as string) || new Date().toISOString();
    const sessionId = getSessionDisplayId(filePath);

    // Check if message is from today (for stats recovery from history)
    // Use local date comparison instead of UTC
    const todayStr = getLocalDateString();
    const msgDate = new Date(ts);
    const msgDateStr = getLocalDateString(msgDate);
    const isToday = msgDateStr === todayStr;

    this._recordTimestamp(ts);

    if (msg.role === 'assistant') {
      this._processAssistantMessage(msg, ts, sessionId, isToday);
    } else if (msg.role === 'user') {
      this._processUserMessage(msg, ts, sessionId, isToday);
    }
    // toolResult messages are intentionally skipped (too noisy).

    // Notify listener that new activity was detected (skip during history load)
    if (!this._isLoadingHistory && this._onActivity) {
      this._onActivity();
    }
  }

  private _processAssistantMessage(msg: Record<string, unknown>, ts: string, sessionId: string, isToday: boolean = true): void {
    this._checkAndResetStats();
    const { text, toolCalls } = parseMessageContent(msg as { role: string; content: string });

    for (const tc of toolCalls) {
      // Only count tool calls during real-time monitoring (not during history load)
      // _computeStatsFromHistory() already calculated stats from complete history
      if (isToday && !this._isLoadingHistory) {
        this._stats.toolCalls++;
      }
      // 过滤掉 exec、read、edit、process、write 工具（不显示在 Live Activity 中）
      // 显示所有 tool_call（不再过滤）
      if (true) {
        this._addActivity({ type: 'tool_call', tool: tc.name, ts, session: sessionId, icon: '🔧' });
      }
    }

    if (text) {
      // Only count messages during real-time monitoring (not during history load)
      // _computeStatsFromHistory() already calculated stats from complete history
      if (isToday && !this._isLoadingHistory) {
        this._stats.messages++;
      }
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

  private _processUserMessage(msg: Record<string, unknown>, ts: string, sessionId: string, isToday: boolean = true): void {
    this._checkAndResetStats();
    const { text: rawText } = parseMessageContent(msg as { role: string; content: string });
    // For LIVE ACTIVITY: show all messages (including cron/subagent)
    const text = this._extractActivityText(rawText);

    if (!text) return;

    // Determine if this is a system message (cron or subagent)
    const isCron = text.includes('[cron:');
    const isSubagent = text.includes('[Subagent Context]');
    const icon = isCron ? '⏰' : isSubagent ? '🤖' : '👤';

    // Only count messages during real-time monitoring (not during history load)
    // _computeStatsFromHistory() already calculated stats from complete history
    if (isToday && !this._isLoadingHistory) {
      this._stats.messages++;
    }
    this._addActivity({ type: 'user_message', text, ts, session: sessionId, icon });
  }

  private _recordTimestamp(ts: string): void {
    const date = new Date(ts);
    const timestamp = date.getTime();
    const now = Date.now();
    const lookbackMs = 24 * 3600 * 1000;
    
    if (now - timestamp > lookbackMs) return;
    
    const hourKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}T${date.getHours()}`;
    
    const currentCount = this._hourlyBuckets.get(hourKey) || 0;
    this._hourlyBuckets.set(hourKey, currentCount + 1);
    
    this._cachedHourlyActivity = null;
    
    this._stats.lastActivityAt = ts;
  }
  
  private _cleanupOldData(): void {
    const now = Date.now();
    const lookbackMs = 24 * 3600 * 1000;
    
    this._hourlyBuckets.forEach((_, hourKey) => {
      const [datePart, hourPart] = hourKey.split('T');
      const [year, month, day] = datePart.split('-').map(Number);
      const hour = parseInt(hourPart);
      const hourTimestamp = new Date(year, month, day, hour).getTime();
      
      if (now - hourTimestamp > lookbackMs) {
        this._hourlyBuckets.delete(hourKey);
      }
    });
  }

  private _addActivity(activity: ActivityItem): void {
    // 如果是 tool_call，先删除同类型的旧消息（每种工具只保留最新一条）
    // 包括 sessions_spawn 在内的所有工具都需要去重
    if (activity.type === 'tool_call') {
      this._recentActivity = this._recentActivity.filter(a => 
        !(a.type === 'tool_call' && a.tool === activity.tool)
      );
    }
    
    // 添加新消息到开头
    this._recentActivity.unshift(activity);
    
    // 超过限制时删除最后一条
    // Only truncate during real-time monitoring (not during history load)
    // History load will sort and truncate after all messages are loaded
    if (!this._isLoadingHistory && this._recentActivity.length > MAX_RECENT_ACTIVITY) {
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
  /**
   * Extract text for LIVE ACTIVITY display.
   * Shows ALL messages including cron and subagent tasks.
   */
  private _extractActivityText(raw: string): string {
    // First use the standard extractor
    let text = extractUserText(raw, 200);
    
    // If we got nothing, return empty
    if (!text) return '';
    
    // Handle Feishu messages: extract the actual content
    const feishuMatch = text.match(/\[message_id=[^\]]+\]\s*\n+([\s\S]+)/);
    if (feishuMatch && feishuMatch[1]) {
      return feishuMatch[1].trim();
    }
    
    // Filter only technical noise (but keep cron/subagent messages)
    const noisePatterns = [
      'A new session was started',
      'Read HEARTBEAT',
      'OpenClaw runtime context',
      'Internal task completion event',
      'Pre-compaction memory flush',
      'Exec completed',
    ];
    
    for (const pattern of noisePatterns) {
      if (text.includes(pattern)) return '';
    }
    
    return text;
  }

  /**
   * Extract the real user message for Task Log display.
   * Filters out system messages (cron, subagent, etc.).
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

  private _listSessionFiles(lookbackMs: number, options?: { includeResetArchives?: boolean; includeDeletedArchives?: boolean }): SessionFileInfo[] {
    const includeResetArchives = options?.includeResetArchives ?? false;
    const includeDeletedArchives = options?.includeDeletedArchives ?? false;
    const cutoff = Date.now() - lookbackMs;
    const allFiles: SessionFileInfo[] = [];

    // Scan all agent directories
    for (const { agentName, sessionsDir } of this._agentDirs) {
      try {
        const files = fs.readdirSync(sessionsDir).filter((f) => {
          if (f.endsWith('.jsonl')) return true;
          if (includeResetArchives && /\.jsonl\.reset\./.test(f)) return true;
          if (includeDeletedArchives && /\.jsonl\.deleted\./.test(f)) return true;
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
