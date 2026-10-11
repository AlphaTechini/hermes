import { CircleX, FlaskConical, TriangleAlert, Webhook } from "lucide-react";
import { Link } from "react-router-dom";
import type { StrategyDTO } from "@hermes/shared";
import { errorMessage } from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";
import { useToggleStrategy } from "../../lib/queries";
import { Button, Card, CardHeader, EmptyState, MarketChip, Skeleton, StatusPill, Tag, Toggle, useToast } from "../../components/ui";
import { formatRate, type StrategyStats } from "./stats";

interface Props {
  strategies: StrategyDTO[] | undefined;
  loading: boolean;
  showSkeleton: boolean;
  error: boolean;
  onRetry: () => void;
  currentId: string | undefined;
  stats: Map<string, StrategyStats>;
  marketAllowed: (m: string | null) => boolean;
  now: number;
  onNew: () => void;
}

export function StrategyList({ strategies, loading, showSkeleton, error, onRetry, currentId, stats, marketAllowed, now, onNew }: Props) {
  const toggle = useToggleStrategy();
  const toast = useToast();
  const onCount = strategies?.filter((s) => s.enabled).length ?? 0;

  return (
    <Card>
      <CardHeader
        title={
          <>
            All strategies{" "}
            {strategies && (
              <Tag mono>{strategies.length}</Tag>
            )}
          </>
        }
        meta={strategies && strategies.length > 0 ? `${onCount} on` : undefined}
      />
      {error ? (
        <EmptyState compact icon={CircleX} tone="negative" title="Could not load strategies" actions={<Button onClick={onRetry}>Retry</Button>}>
          Hermes did not respond. Your webhooks still work.
        </EmptyState>
      ) : loading ? (
        showSkeleton ? (
          <div aria-busy="true" aria-label="Loading strategies">
            {[0, 1, 2].map((i) => (
              <div key={i} className="li-row" style={{ cursor: "default" }}>
                <Skeleton w={32} h={20} />
                <span className="col hm-grow g2">
                  <Skeleton w="60%" h={14} />
                  <Skeleton w="45%" h={12} />
                  <Skeleton w="70%" h={12} />
                </span>
              </div>
            ))}
          </div>
        ) : null
      ) : strategies && strategies.length === 0 ? (
        <EmptyState icon={Webhook} title="No strategies yet" actions={<Button variant="primary" onClick={onNew}>New strategy</Button>}>
          Create one strategy per TradingView alert. You get a webhook URL and a message to paste.
        </EmptyState>
      ) : (
        <div>
          {strategies?.map((s) => {
            const st = stats.get(s.id);
            const allowed = marketAllowed(s.defaultMarket);
            return (
              <div key={s.id} className="li-row" aria-current={s.id === currentId ? "true" : undefined} style={{ position: "relative", padding: 0 }}>
                <Link to={`/strategies/${s.id}`} className="row g3" style={{ alignItems: "flex-start", flex: "1 1 auto", minWidth: 0, padding: "12px 62px 12px 16px", color: "inherit" }}>
                  {s.defaultMarket ? <MarketChip market={s.defaultMarket} disabled={!s.enabled} /> : <span className="mkt" style={{ color: "var(--text-muted)" }}>any</span>}
                  <span className="col hm-grow g1">
                    <span className="row g2" style={{ minWidth: 0 }}>
                      <span className={`w500 truncate${s.enabled ? "" : " secondary"}`}>{s.name}</span>
                      {s.dryRun && (
                        <StatusPill tone="accent" icon={FlaskConical} title="Dry run: checks run, nothing is sent to Perpl">
                          Dry run
                        </StatusPill>
                      )}
                    </span>
                    <span className="xs muted row g2">
                      <span className="hm-dot" data-tone={s.enabled && s.lastAlertAt ? "positive" : undefined} />
                      {!s.enabled ? "Off" : s.lastAlertAt ? `Last alert ${formatRelativeTime(s.lastAlertAt, now)}` : "No alerts yet"}
                    </span>
                    {!allowed && s.defaultMarket ? (
                      <span className="xs warn row g1">
                        <TriangleAlert className="i-12" aria-hidden />
                        {s.defaultMarket} is not in your allowed markets
                      </span>
                    ) : st ? (
                      <span className="xs secondary">
                        <span className="mono">{st.today}</span> today ·{" "}
                        {s.dryRun ? (
                          "checked only"
                        ) : (
                          <>
                            <span className="mono">{formatRate(st.filledRate)}</span> filled
                          </>
                        )}
                        {st.blocked > 0 && (
                          <>
                            {" "}
                            · <span className="warn">{st.blocked} blocked</span>
                          </>
                        )}
                      </span>
                    ) : (
                      <span className="xs secondary">
                        <span className="mono">0</span> today
                      </span>
                    )}
                  </span>
                </Link>
                <span style={{ position: "absolute", right: 16, top: 14 }}>
                  <Toggle
                    aria-label={`${s.name} enabled`}
                    checked={s.enabled}
                    onCheckedChange={(enabled) => toggle.mutate({ id: s.id, enabled }, { onError: (e) => toast.negative("Could not change the strategy", errorMessage(e)) })}
                  />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
