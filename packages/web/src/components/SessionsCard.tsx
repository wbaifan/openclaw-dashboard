import { fmtTokens, timeAgo, detectChannel } from '../lib/format';
import type { SessionItem } from '../lib/types';

interface SessionsCardProps {
  sessions: SessionItem[];
}

export function SessionsCard({ sessions }: SessionsCardProps) {
  // 过滤掉 run session（key 包含 :run: 的 session）
  const filteredSessions = sessions.filter(s => !s.key.includes(':run:'));
  
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-icon">🔗</span>
        <span className="card-title">SESSIONS</span>
        <span className="badge">{filteredSessions.length}</span>
      </div>
      <div className="card-body">
        <div className="session-list">
          {filteredSessions.length === 0 ? (
            <div className="empty">No sessions</div>
          ) : (
            filteredSessions.map((s) => <SessionRow key={s.key} session={s} />)
          )}
        </div>
      </div>
    </div>
  );
}

function SessionRow({ session: s }: { session: SessionItem }) {
  const ch = detectChannel(s.key);
  const displayText = s.label || s.key
    .replace('agent:main:', '')
    .replace(/:[a-f0-9-]{20,}/g, '')
    .replace(/:\d{6,}/g, '');
  const pct = s.percentUsed ?? 0;
  const ctxColor = pct > 70 ? '#ff3366' : pct > 40 ? '#ffcc00' : '#00f0ff';

  return (
    <div className="session-item">
      <span className={`session-channel ${ch}`}>{ch}</span>
      <span className="session-key" title={s.key}>{displayText}</span>
      <span className="session-tokens">{fmtTokens(s.totalTokens)}</span>
      <div className="ctx-bar">
        <div className="ctx-bar-fill" style={{ width: `${pct}%`, background: ctxColor }} />
      </div>
      <span className="session-pct" style={{ color: ctxColor }}>{pct}%</span>
      <span className="session-time">{timeAgo(s.age)}</span>
    </div>
  );
}
