import { memo, useMemo } from 'react';
import { fmtTokens } from '../lib/format';
import type { UsageCostData } from '../lib/types';

interface TodayCardProps {
  usageCost?: UsageCostData;
  hourlyActivity?: number[];
}

export const TodayCard = memo(function TodayCard({ usageCost, hourlyActivity }: TodayCardProps) {
  // 使用 useMemo 缓存计算结果
  const daily = usageCost?.daily ?? [];
  const today = daily.length ? daily[daily.length - 1] : null;

  const hourly = hourlyActivity ?? new Array(24).fill(0);
  const maxH = Math.max(...hourly, 1);
  const now = new Date().getHours(); // 使用用户本地时区的当前小时
  
  // 缓存小时条形图数据
  const hourlyBars = useMemo(
    () => hourly.map((v, i) => ({
      pct: (v / maxH) * 100,
      opacity: v > 0 ? 0.4 + 0.6 * (v / maxH) : 0.15,
      isNow: i === now,
      title: `${i}:00 — ${v} events`,
    })),
    [hourly, maxH, now]
  );

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-icon">⚡</span>
        <span className="card-title">TODAY</span>
      </div>
      <div className="card-body">
        <div className="stat-grid">
          <div className="stat">
            <div className="stat-value">{fmtTokens(today?.totalTokens)}</div>
            <div className="stat-label">Tokens</div>
          </div>
          <div className="stat">
            <div className="stat-value accent-green">{fmtTokens(today?.input)}</div>
            <div className="stat-label">Input</div>
          </div>
          <div className="stat">
            <div className="stat-value accent-cyan">{fmtTokens(today?.output)}</div>
            <div className="stat-label">Output</div>
          </div>
          <div className="stat">
            <div className="stat-value accent-yellow">{fmtTokens(today?.cacheRead)}</div>
            <div className="stat-label">Cache Read</div>
          </div>
        </div>
        <div className="hourly-heat">
          <div className="hourly-label">Activity Timeline</div>
          <div className="hourly-bars">
            {hourlyBars.map((bar, i) => (
              <div
                key={i}
                className={`hbar${bar.isNow ? ' hbar-now' : ''}`}
                style={{ height: `${Math.max(bar.pct, 4)}%`, opacity: bar.opacity }}
                title={bar.title}
              />
            ))}
          </div>
          <div className="hourly-labels">
            <span>0</span><span>6</span><span>12</span><span>18</span><span>23</span>
          </div>
        </div>
      </div>
    </div>
  );
});
