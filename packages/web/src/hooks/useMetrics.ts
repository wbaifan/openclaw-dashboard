import { useState, useEffect, useRef, useCallback } from 'react';
import type { DashboardMetrics } from '../lib/types';

export type WsStatus = 'connecting' | 'live' | 'offline';

export interface UseMetricsResult {
  data: DashboardMetrics | null;
  wsStatus: WsStatus;
}

/**
 * 浅比较两个对象是否相等
 * 只比较第一层属性，避免深比较的性能开销
 */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  
  if (keysA.length !== keysB.length) return false;
  
  for (const key of keysA) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) {
      return false;
    }
  }
  
  return true;
}

/**
 * 比较新旧 metrics 数据，判断是否需要更新
 * 只比较关键字段，避免不必要的重新渲染
 */
function shouldUpdateData(
  prev: DashboardMetrics | null,
  next: DashboardMetrics
): boolean {
  if (!prev) return true;
  
  // 比较顶层关键字段
  if (prev.timestamp !== next.timestamp) return true;
  if (prev.gwConnected !== next.gwConnected) return true;
  
  // 比较 activity（最频繁更新的部分）
  if (!shallowEqual(prev.activity, next.activity)) return true;
  
  // 比较 usageCost
  if (!shallowEqual(prev.usageCost, next.usageCost)) return true;
  
  // 比较 status
  if (!shallowEqual(prev.status, next.status)) return true;
  
  // 比较 health
  if (!shallowEqual(prev.health, next.health)) return true;
  
  // 比较 presence
  if (!shallowEqual(prev.presence, next.presence)) return true;
  
  return false;
}

export function useMetrics(): UseMetricsResult {
  const [data, setData] = useState<DashboardMetrics | null>(null);
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>();
  const prevDataRef = useRef<DashboardMetrics | null>(null);

  const connect = useCallback(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const base = location.pathname.replace(/\/+$/, '');
    const ws = new WebSocket(`${proto}://${location.host}${base}/ws`);
    wsRef.current = ws;
    setWsStatus('connecting');

    ws.onopen = () => {
      setWsStatus('live');
      clearTimeout(reconnectRef.current);
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'metrics') {
          // 只有数据真正变化时才更新 state
          if (shouldUpdateData(prevDataRef.current, msg.data)) {
            prevDataRef.current = msg.data;
            setData(msg.data);
          }
        }
      } catch {
        // Ignore malformed messages.
      }
    };

    ws.onclose = () => {
      setWsStatus('offline');
      reconnectRef.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => ws.close();
  }, []);

  useEffect(() => {
    connect();

    // Fallback: if WS hasn't connected after 5s, try REST API.
    const fallback = setTimeout(() => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        const base = location.pathname.replace(/\/+$/, '');
        fetch(base + '/api/metrics')
          .then((r) => r.json())
          .then((data) => {
            if (shouldUpdateData(prevDataRef.current, data)) {
              prevDataRef.current = data;
              setData(data);
            }
          })
          .catch(() => {});
      }
    }, 5000);

    return () => {
      clearTimeout(fallback);
      clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { data, wsStatus };
}
