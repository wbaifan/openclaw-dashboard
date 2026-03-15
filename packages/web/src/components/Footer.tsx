import { useState, useEffect } from 'react';
import type { WsStatus } from '../hooks/useMetrics';

interface FooterProps {
  timestamp?: number;
  wsStatus: WsStatus;
}

// 相对时间格式化函数
const getRelativeTime = (ts: number): string => {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 10) return '刚刚';
  if (diff < 60) return `${diff}秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  return `${Math.floor(diff / 3600)}小时前`;
};

export function Footer({ timestamp, wsStatus }: FooterProps) {
  // Force re-render every second to update time display
  const [, setTick] = useState(0);

  useEffect(() => {
    // Update every second for "ticking" time
    const interval = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000); // 1 second

    return () => clearInterval(interval);
  }, []);

  const updated = timestamp
    ? '更新于: ' + getRelativeTime(timestamp)
    : '更新于: --';

  const wsColor =
    wsStatus === 'live'
      ? 'var(--green)'
      : wsStatus === 'connecting'
        ? 'var(--text2)'
        : 'var(--red)';

  return (
    <footer className="footer">
      <span>🫠 颓弟 Dashboard</span>
      <span>{updated}</span>
      <span style={{ color: wsColor }}>WS: {wsStatus === 'live' ? 'live' : wsStatus === 'connecting' ? 'connecting...' : 'offline'}</span>
    </footer>
  );
}
