import fs from 'fs';

/**
 * Noise patterns to strip from user message text.
 * These are system-injected metadata lines that aren't meaningful for display.
 */
const SYSTEM_NOISE_PATTERNS: RegExp[] = [
  /^System:.*$/gm,
  /^Conversation info.*$/gm,
  /^Sender.*$/gm,
  /```[\s\S]*?```/g,  // 匹配所有代码块
  /\[media attached:.*?\]/g,
  /\[image data.*?\]/g,
  /^When reading .*?\.md.*$/gm,
  /^Read HEARTBEAT.*$/gm,
  /^Current time:.*$/gm,
  /^A new session was started.*$/gm,
];

export interface ParsedContent {
  text: string;
  toolCalls: ToolCall[];
}

export interface ToolCall {
  type: string;
  name: string;
  [key: string]: unknown;
}

interface Message {
  role: string;
  content: string | ContentPart[];
}

interface ContentPart {
  type: string;
  text?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Clean system noise from user message text and return meaningful lines.
 */
export function extractUserText(raw: string, maxLines = 6, maxLen = 120): string {
  let text = raw;
  for (const pattern of SYSTEM_NOISE_PATTERNS) {
    text = text.replace(pattern, '');
  }

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (l.startsWith('{') || l.startsWith('"')) return false;
      if (l.startsWith('Read HEARTBEAT') || l.startsWith('When reading')) return false;
      if (l.startsWith('Current time:')) return false;
      if (l.startsWith('A new session was started')) return false;
      if (l.startsWith('```')) return false;
      if (l.includes('workspace file') || l.includes('exact path')) return false;
      return true;
    })
    .slice(0, maxLines)
    .map((l) => l.slice(0, maxLen));

  return lines.join('\n');
}

/**
 * Extract the first meaningful summary line from assistant text.
 * Skips headings, code fences, and tables. Preserves list items.
 */
export function extractAssistantSummary(fullText: string, maxLen = 80, minLen = 3, maxLines = 6): string {
  // 转换飞书 @ 标签
  let text = fullText.replace(/<at user_id="[^"]+">([^<]+)<\/at>/g, '@$1');
  
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('```') && !l.startsWith('|') && l.length > minLen)
    .slice(0, maxLines)
    .map((l) => l.slice(0, maxLen));
  
  return lines.join('\n');
}

/**
 * Parse text content and tool calls from a message object.
 * Handles both string and structured content arrays.
 */
export function parseMessageContent(msg: Message): ParsedContent {
  if (msg.role === 'user') {
    let text: string;
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    } else {
      text = '';
    }
    return { text, toolCalls: [] };
  }

  if (msg.role === 'assistant') {
    const content = Array.isArray(msg.content) ? msg.content : [];
    const toolCalls = content.filter((c) => c.type === 'toolCall') as ToolCall[];
    const text = content.filter((c) => c.type === 'text').map((p) => p.text ?? '').join('');
    return { text, toolCalls };
  }

  return { text: '', toolCalls: [] };
}

/**
 * Read lines from a file region efficiently.
 */
export function readFileRegionLines(filePath: string, offset: number, maxBytes: number): string[] {
  const stat = fs.statSync(filePath);
  const readSize = Math.min(stat.size - offset, maxBytes);
  if (readSize <= 0) return [];

  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, offset);
    return buf.toString('utf8').split('\n').filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Parse JSONL lines, yielding parsed entries. Silently skips malformed lines.
 */
export function parseJsonLines(lines: string[]): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      results.push(JSON.parse(line));
    } catch {
      // Skip malformed lines.
    }
  }
  return results;
}
