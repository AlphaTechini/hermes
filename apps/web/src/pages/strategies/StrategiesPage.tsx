import { Plus } from "lucide-react";
import { useCallback, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../../components/shell/PageHeader";
import { Button, useDelayedFlag } from "../../components/ui";
import { PAGE } from "../../lib/routes";
import { useAlerts, useLimits, useStrategies } from "../../lib/queries";
import { startOfLocalDay, useNow } from "../common/useNow";
import { NewStrategyDrawer } from "./NewStrategyDrawer";
import { StrategyDetail } from "./StrategyDetail";
import { StrategyList } from "./StrategyList";
import { strategyStats } from "./stats";

/** `/strategies` and `/strategies/:id`: master list on the left, detail on the right (stacked on mobile). */
export function StrategiesPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const list = useStrategies();
  const limits = useLimits();
  const alerts = useAlerts({ limit: 200 });
  const now = useNow(10_000);
  const [creating, setCreating] = useState(false);
  const slow = useDelayedFlag(list.isLoading);

  const strategies = list.data;
  const allowedMarkets = limits.data?.allowedMarkets;
  const marketAllowed = useCallback((m: string | null) => !m || !allowedMarkets || allowedMarkets.includes(m), [allowedMarkets]);
  const current = id ? strategies?.find((x) => x.id === id) : undefined;
  const stats = strategyStats(alerts.data?.items, startOfLocalDay(now));

  // Land on the first strategy; leave a stale id (deleted elsewhere) for the first one.
  if (strategies && strategies.length > 0 && (!id || !strategies.some((s) => s.id === id))) {
    return <Navigate to={`/strategies/${strategies[0]!.id}`} replace />;
  }

  return (
    <>
      <PageHeader
        title={PAGE.strategies.title}
        documentTitle={current ? `${current.name} · ${PAGE.strategies.title}` : PAGE.strategies.title}
        subtitle={PAGE.strategies.subtitle}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
            New strategy
          </Button>
        }
      />
      <div className="md-layout">
        <StrategyList
          strategies={strategies}
          loading={list.isLoading}
          showSkeleton={slow}
          error={list.isError && !list.data}
          onRetry={() => void list.refetch()}
          currentId={id}
          stats={stats}
          marketAllowed={marketAllowed}
          now={now}
          onNew={() => setCreating(true)}
        />
        {id && strategies?.some((s) => s.id === id) ? <StrategyDetail id={id} marketAllowed={marketAllowed} /> : <div />}
      </div>
      <NewStrategyDrawer open={creating} onClose={() => setCreating(false)} onOpenStrategy={(sid) => navigate(`/strategies/${sid}`)} />
    </>
  );
}
