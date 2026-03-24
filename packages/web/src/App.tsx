import { useMemo } from 'react';
import { useMetrics } from './hooks/useMetrics';
import { Header } from './components/Header';
import { TokenUsageCard } from './components/TokenUsageCard';
import { TodayCard } from './components/TodayCard';
import { CostBreakdownCard } from './components/CostBreakdownCard';
import { SessionsCard } from './components/SessionsCard';
import { TaskLogCard } from './components/TaskLogCard';
import { ActivityCard } from './components/ActivityCard';
import { Footer } from './components/Footer';

export function App() {
  const { data, wsStatus } = useMetrics();

  const activity = useMemo(() => data?.activity, [data?.activity]);
  const sessions = useMemo(() => data?.status?.sessions?.recent ?? [], [data?.status?.sessions?.recent]);
  const usageCost = useMemo(() => data?.usageCost, [data?.usageCost]);
  const totals = useMemo(() => data?.usageCost?.totals, [data?.usageCost?.totals]);
  const hourlyActivity = useMemo(() => activity?.hourlyActivity, [activity?.hourlyActivity]);
  const tasks = useMemo(() => activity?.tasks ?? [], [activity?.tasks]);
  const recent = useMemo(() => activity?.recent ?? [], [activity?.recent]);

  return (
    <>
      <div className="scanline" />
      <div className="dashboard">
        <Header data={data} />
        <div className="grid">
          <TokenUsageCard usageCost={usageCost} />
          <TodayCard usageCost={usageCost} hourlyActivity={hourlyActivity} />
          <CostBreakdownCard totals={totals} />
          <SessionsCard sessions={sessions} />
          <TaskLogCard tasks={tasks} />
          <ActivityCard recent={recent} />
        </div>
        <Footer timestamp={data?.timestamp} wsStatus={wsStatus} />
      </div>
    </>
  );
}
