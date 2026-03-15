import { fmtTokens } from '../lib/format';
import type { UsageTotals } from '../lib/types';

interface CostBreakdownCardProps {
  totals?: UsageTotals;
}

const COST_ITEMS = [
  { label: 'Cache Write', key: 'cacheWrite' as const, color: '#b366ff' },
  { label: 'Cache Read', key: 'cacheRead' as const, color: '#00f0ff' },
  { label: 'Output', key: 'output' as const, color: '#00ff88' },
  { label: 'Input', key: 'input' as const, color: '#ffcc00' },
];

export function CostBreakdownCard({ totals }: CostBreakdownCardProps) {
  const items = COST_ITEMS.map((item) => ({
    ...item,
    value: totals?.[item.key] ?? 0,
  }));
  const max = Math.max(...items.map((i) => i.value), 0.01);

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-icon">💰</span>
        <span className="card-title">TOKEN BREAKDOWN</span>
      </div>
      <div className="card-body">
        <div className="cost-bars">
          {items.map((item) => (
            <div className="cost-bar-item" key={item.key}>
              <div className="cost-bar-header">
                <span>{item.label}</span>
                <span>{fmtTokens(item.value)}</span>
              </div>
              <div className="cost-bar-track">
                <div
                  className="cost-bar-fill"
                  style={{
                    width: `${((item.value / max) * 100).toFixed(1)}%`,
                    background: item.color,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
