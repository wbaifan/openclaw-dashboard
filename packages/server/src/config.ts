import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || process.env.USERPROFILE || '/root';
const OPENCLAW_HOME = path.join(HOME, '.openclaw');
const AGENT_NAME = process.env.AGENT_NAME || 'main';  // Keep for backward compatibility

/**
 * Scan all agent directories and return their sessions paths.
 * Returns an array of { agentName, sessionsDir } objects.
 */
export function getAgentSessionsDirs(): { agentName: string; sessionsDir: string }[] {
  const agentsDir = path.join(OPENCLAW_HOME, 'agents');
  const result: { agentName: string; sessionsDir: string }[] = [];

  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionsDir = path.join(agentsDir, entry.name, 'sessions');
      try {
        // Check if sessions directory exists
        fs.accessSync(sessionsDir, fs.constants.R_OK);
        result.push({ agentName: entry.name, sessionsDir });
      } catch {
        // Sessions dir doesn't exist or not readable, skip
      }
    }
  } catch {
    // agents dir doesn't exist, fall through
  }

  // Fallback: if no agents found, use the default AGENT_NAME for backward compatibility
  if (result.length === 0) {
    result.push({
      agentName: AGENT_NAME,
      sessionsDir: path.join(OPENCLAW_HOME, 'agents', AGENT_NAME, 'sessions'),
    });
  }

  return result;
}

export const config = {
  port: Number(process.env.PORT) || 3210,
  host: process.env.HOST || '0.0.0.0',
  gwPort: Number(process.env.GW_PORT || process.env.OPENCLAW_GATEWAY_PORT) || 18789,
  identityFile: path.join(process.cwd(), '.device-identity.json'),
  /** @deprecated Use getAgentSessionsDirs() for multi-agent support */
  sessionsDir: path.join(OPENCLAW_HOME, 'agents', AGENT_NAME, 'sessions'),
  gwToken: resolveGatewayToken(),
} as const;

/** Resolve gateway auth token from env vars or the OpenClaw config file. */
function resolveGatewayToken(): string {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  if (process.env.GW_TOKEN) return process.env.GW_TOKEN;
  try {
    const raw = fs.readFileSync(path.join(OPENCLAW_HOME, 'openclaw.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    const token: unknown = parsed?.gateway?.auth?.token;
    if (typeof token === 'string' && token && !token.startsWith('__OPENCLAW')) return token;
  } catch {
    // Config file may not exist; fall through to empty token.
  }
  return '';
}
