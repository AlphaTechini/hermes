import { Inbox, Send, Copy, CircleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { AlertRecord, Fill } from "@hermes/shared";
import { PageHeader } from "../../components/shell/PageHeader";
import {
  Button,
  Card,
  CardFooter,
  CardHeader,
  Drawer,
  EmptyState,
  KpiRow,
  KpiTile,
  PipelineStageNames,
  SegmentedControl,
  Select,
  SkeletonRows,
  useCopy,
  useDelayedFlag,
  useToast,
} from "../../components/ui";
import { errorMessage } from "../../lib/api";
import { useStreamStatus } from "../../lib/stream";
import { formatBps, formatCountdown, formatMs, formatRelativeTime, formatTimeZone } from "../../lib/format";
import { PAGE } from "../../lib/routes";
import { useAlerts, useApprovals, useFills, useLimits, useOrders, useSendTestAlert, useStrategies } from "../../lib/queries";
import { AlertDetailView } from "../alert/AlertDetailView";
import { useNow } from "./hooks";
import { FillsCard, PositionsCard } from "./Tables";
import { StreamRow, type RowSize } from "./StreamRow";
import { bucketOf, startOfToday, todayStats, type OutcomeFilter } from "./stats";

const ALL = "all";
const VISIBLE = 10;

export function LivePage() {
  const toast = useToast();
  const now = useNow(1000);
  const [strategyId, setStrategyId] = useState<string>(ALL);
  const [filter, setFilter] = useState<OutcomeFilter>("all");
  const [showAll, setShowAll] = useState(false);
  // The alert drawer is deep-linked: `/live?alert=<id>`. Opening pushes a history entry, so Back closes it.
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const openId = params.get("alert");
  const pushedDrawer = useRef(false);
  const setOpenId = useCallback(
    (id: string | null) => {
      if (id) {
        pushedDrawer.current = true;
        setParams((p) => {
          const n = new URLSearchParams(p);
          n.set("alert", id);
          return n;
        });
      } else if (pushedDrawer.current) {
        pushedDrawer.current = false;
        navigate(-1);
      } else {
        setParams((p) => {
          const n = new URLSearchParams(p);
          n.delete("alert");
          return n;
        }, { replace: true });
      }
    },
    [navigate, setParams],
  );
  useEffect(() => {
    if (!openId) pushedDrawer.current = false; // closed with Back: the next close must not step back again
  }, [openId]);
  const stream = useStreamStatus();

  const strategies = useStrategies();
  const limits = useLimits();
  const alertsQ = useAlerts({ limit: 200, ...(strategyId !== ALL ? { strategyId } : {}) });
  const fills = useFills(100);
  const orders = useOrders(100);
  const pending = useApprovals("pending");
  const sendTest = useSendTestAlert();
  const { copy, copied } = useCopy();

  // --- today ---------------------------------------------------------------------------
  const dayStart = startOfToday(now);
  const items = alertsQ.data?.items;
  const today = useMemo(() => (items ?? []).filter((a) => a.receivedAt >= dayStart), [items, dayStart]);
  const stats = useMemo(() => todayStats(today), [today]);
  const hasToday = today.length > 0;
  // With nothing today the stream falls back to the latest alerts so the page is never empty after a quiet night.
  const pool = hasToday ? today : (items ?? []);
  const counts = useMemo(() => {
    const c = { all: pool.length, filled: 0, blocked: 0, missed: 0, dry_run: 0 };
    for (const a of pool) {
      const b = bucketOf(a);
      if (b) c[b]++;
    }
    return c;
  }, [pool]);
  const filtered = useMemo(() => (filter === "all" ? pool : pool.filter((a) => bucketOf(a) === filter)), [pool, filter]);
  const rows = showAll ? filtered : filtered.slice(0, VISIBLE);

  // --- rows that arrived after load animate in -----------------------------------------
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!items) return;
    if (known.current === null) {
      known.current = new Set(items.map((a) => a.id));
      return;
    }
    const added = items.filter((a) => !known.current!.has(a.id));
    if (added.length === 0) return;
    added.forEach((a) => known.current!.add(a.id));
    const ids = added.map((a) => a.id);
    setFresh((f) => new Set([...f, ...ids]));
    const t = setTimeout(
      () =>
        setFresh((f) => {
          const n = new Set(f);
          ids.forEach((i) => n.delete(i));
          return n;
        }),
      1800,
    );
    return () => clearTimeout(t);
  }, [items]);
  // A different strategy is a different list: nothing in it counts as new.
  useEffect(() => {
    known.current = null;
    setFresh(new Set());
  }, [strategyId]);

  // --- row helpers ---------------------------------------------------------------------
  const sizeOf = useMemo(() => buildSizeLookup(fills.data), [fills.data, orders.data]);
  const byId = useMemo(() => new Map((items ?? []).map((a) => [a.id, a])), [items]);
  const approvalByAlert = useMemo(() => new Map((pending.data ?? []).map((a) => [a.alertId, a.expiresAt])), [pending.data]);

  // --- send test alert -----------------------------------------------------------------
  const list = strategies.data ?? [];
  const target = list.find((s) => s.id === strategyId) ?? list[0];
  const send = () => {
    if (!target) return;
    sendTest.mutate(
      { id: target.id },
      {
        onSuccess: (r) => {
          if (r.duplicate) toast.warning("Test alert ignored", `${target.name} · Hermes treated it as a duplicate.`);
          else toast({ tone: "accent", icon: Send, title: "Test alert sent", body: `${target.name} · ${describeTest(r.body, target.defaultMarket)}. Watch it in the stream.` });
        },
        onError: (e) => toast.negative("Could not send the test alert", errorMessage(e), { actions: [{ label: "Try again", onClick: send }] }),
      },
    );
  };

  const loading = alertsQ.isLoading;
  const showSkeleton = useDelayedFlag(loading);
  const failed = alertsQ.isError && !alertsQ.data;
  const empty = !loading && !failed && (items?.length ?? 0) === 0;
  const cap = limits.data?.defaultSlippageBps ?? null;
  // Loading, failed and empty are three different states. A failed load must never read as "0 alerts today".
  const kpiLoading = loading && showSkeleton;
  const na = <span className="faint">n/a</span>;
  const cannot = failed ? "Could not load" : undefined;
  const live = stream.state;

  const strategyOptions = [{ value: ALL, label: "All strategies" }, ...list.map((s) => ({ value: s.id, label: s.name }))];

  return (
    <>
      <PageHeader
        {...PAGE.live}
        actions={
          <>
            <Select variant="button" aria-label="Strategy" className="hide-sm" value={strategyId} onChange={setStrategyId} options={strategyOptions} />
            <Button icon={Send} loading={sendTest.isPending} loadingLabel="Sending" disabled={!target} onClick={send} title={target ? undefined : "Create a strategy first"}>
              Send test alert
            </Button>
          </>
        }
      />

      <KpiRow aria-label="Today">
        <KpiTile
          label="Alerts today"
          loading={kpiLoading}
          skeleton={[72, 40, 150]}
          value={loading ? "" : failed ? na : stats.total}
          sub={
            cannot ?? (
              <>
                <span>{stats.filled} filled</span>
                <span className="faint">·</span>
                <span>{stats.blocked} blocked</span>
                <span className="faint">·</span>
                <span>{stats.missed} missed</span>
                {stats.dryRun > 0 && (
                  <>
                    <span className="faint">·</span>
                    <span>{stats.dryRun} dry run</span>
                  </>
                )}
              </>
            )
          }
        />
        <KpiTile
          label="Fill rate"
          loading={kpiLoading}
          skeleton={[56, 72, 170]}
          value={failed || stats.fillRate === null ? na : stats.fillRate.toFixed(1)}
          unit={failed || stats.fillRate === null ? undefined : "%"}
          sub={cannot ?? (stats.eligible > 0 ? `${stats.filled} of ${stats.eligible} that passed your limits` : "Waiting for the first alert that passes your limits")}
        />
        <KpiTile
          label="Median alert to fill"
          loading={kpiLoading}
          skeleton={[120, 72, 70]}
          value={failed || stats.medianMs === null ? na : Math.round(stats.medianMs)}
          unit={failed || stats.medianMs === null ? undefined : "ms"}
          sub={
            cannot ?? (
              <>
                p95 <span className="d secondary">{stats.p95Ms === null ? "n/a" : formatMs(stats.p95Ms)}</span>
              </>
            )
          }
        />
        <KpiTile
          label="Median slippage"
          loading={kpiLoading}
          skeleton={[100, 72, 160]}
          value={failed || stats.medianSlipBps === null ? na : stats.medianSlipBps.toFixed(1)}
          unit={failed || stats.medianSlipBps === null ? undefined : "bps"}
          sub={
            cannot ?? (
              <>
                vs alert price · cap <span className="d secondary">{cap === null ? "n/a" : formatBps(cap, { decimals: 0 })}</span>
              </>
            )
          }
        />
      </KpiRow>

      <Card>
        <CardHeader
          title="Alert stream"
          meta={<StreamState state={live} />}
          actions={
            !empty &&
            !failed && (
              <SegmentedControl<OutcomeFilter>
                aria-label="Filter by outcome"
                className="hide-sm"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "All", ...(loading ? {} : { count: counts.all }) },
                  { value: "filled", label: "Filled", ...(loading ? {} : { count: counts.filled }) },
                  { value: "blocked", label: "Blocked", ...(loading ? {} : { count: counts.blocked }) },
                  { value: "missed", label: "Missed", ...(loading ? {} : { count: counts.missed }) },
                  ...(counts.dry_run > 0 || filter === "dry_run" ? [{ value: "dry_run" as const, label: "Dry run", count: counts.dry_run }] : []),
                ]}
              />
            )
          }
        />
        {failed ? (
          <EmptyState icon={CircleAlert} tone="negative" title="Could not load alerts" actions={<Button size="sm" variant="secondary" onClick={() => void alertsQ.refetch()}>Retry</Button>}>
            Hermes did not respond. Alerts are still being processed on the server.
          </EmptyState>
        ) : empty ? (
          <EmptyState
            icon={Inbox}
            title="No alerts yet"
            actions={
              <>
                <Button size="sm" variant="primary" icon={Send} loading={sendTest.isPending} loadingLabel="Sending" disabled={!target} onClick={send}>
                  Send test alert
                </Button>
                {target ? (
                  <Button size="sm" variant="ghost" icon={Copy} onClick={() => void copy(target.webhookUrl)}>
                    {copied ? "Copied" : "Copy webhook URL"}
                  </Button>
                ) : (
                  <Link className="btn btn-ghost btn-sm" to="/strategies">
                    Create a strategy
                  </Link>
                )}
              </>
            }
          >
            When TradingView sends an alert to your webhook, it shows up here within a second. Send a test alert to try it now.
          </EmptyState>
        ) : loading ? (
          showSkeleton ? <SkeletonRows rows={5} /> : <div style={{ minHeight: 240 }} />
        ) : (
          <>
            <div className="stream" id="stream" style={showAll ? { maxHeight: 720, overflowY: "auto" } : undefined}>
              <div className="stream-head">
                <span>Time</span>
                <span>Signal</span>
                <span className="c-strat">Strategy</span>
                <PipelineStageNames />
                <span className="right">Total</span>
                <span>Outcome</span>
                <span />
              </div>
              {rows.length === 0 && (
                <div className="empty" style={{ padding: "32px 24px" }}>
                  <p>{filter === "dry_run" ? "No dry runs" : `No ${filter} alerts`} {hasToday ? "today" : "yet"}.</p>
                </div>
              )}
              {rows.map((a) => {
                const dupOf = a.status === "duplicate" ? (a.events.find((e) => e.status === "duplicate")?.detail?.duplicateOf as string | undefined) : undefined;
                const original = dupOf ? byId.get(dupOf) : undefined;
                return (
                <StreamRow
                  key={a.id}
                  alert={a}
                  size={sizeOf(a)}
                  original={original}
                  originalSize={original ? sizeOf(original) : undefined}
                  relative={formatRelativeTime(a.receivedAt, now)}
                  approvalLeft={approvalLeftFor(approvalByAlert.get(a.id), now)}
                  fresh={fresh.has(a.id)}
                  onOpen={setOpenId}
                />
                );
              })}
            </div>
            <CardFooter>
              <span>
                {hasToday ? `Showing ${rows.length} of ${filtered.length} alerts today` : `Showing the latest ${rows.length} alerts`} · times in {formatTimeZone()}
              </span>
              {filtered.length > VISIBLE && (
                <button type="button" className="link" style={{ background: "none", border: 0, padding: 0, font: "inherit", cursor: "pointer" }} onClick={() => setShowAll((v) => !v)}>
                  {showAll ? "Show fewer" : "View all"}
                </button>
              )}
            </CardFooter>
          </>
        )}
      </Card>

      <div className="grid-12">
        <PositionsCard className="span-7" orders={orders.data} />
        <FillsCard className="span-5" fills={fills.data} alerts={items} alertsSettled={!alertsQ.isLoading} failed={fills.isError} onRetry={() => void fills.refetch()} />
      </div>

      <Drawer open={openId !== null} onClose={() => setOpenId(null)} title={drawerTitle(openId)} width={720}>
        {openId && <AlertDetailView id={openId} variant="drawer" />}
      </Drawer>
    </>
  );
}

/** `Alert alr_jsDeAChkCFWu73`. Truncates with an ellipsis (the Drawer's h2 does the clipping) and keeps the full id in `title`. */
function drawerTitle(id: string | null) {
  return id ? (
    <span className="hm-truncate" style={{ display: "block" }} title={id}>
      Alert <span className="mono">{id}</span>
    </span>
  ) : (
    "Alert"
  );
}

/** The live dot in the stream header follows the real connection: Live, Reconnecting, or Paused when updates stopped. */
function StreamState({ state }: { state: ReturnType<typeof useStreamStatus>["state"] }) {
  const tone = state === "live" ? "positive" : state === "reconnecting" || state === "connecting" ? "warning" : undefined;
  const label = state === "live" ? "Live" : state === "reconnecting" ? "Reconnecting" : state === "connecting" ? "Connecting" : "Paused";
  return (
    <span className="row g2" role="status">
      <span className="hm-dot" data-tone={tone} data-live={tone ? "true" : undefined} />
      {label}
    </span>
  );
}

function approvalLeftFor(expiresAt: number | undefined, now: number): string | null {
  if (expiresAt === undefined) return null;
  return formatCountdown(Math.max(0, Math.ceil((expiresAt - now) / 1000)));
}

/** Base size and notional per alert: the fill size when there is one, otherwise requested notional / alert price. */
function buildSizeLookup(fills: Fill[] | undefined): (a: AlertRecord) => RowSize {
  const byAlert = new Map<string, { size: number; usd: number }>();
  for (const f of fills ?? []) {
    if (!f.alertId) continue;
    const cur = byAlert.get(f.alertId) ?? { size: 0, usd: 0 };
    cur.size += f.size;
    cur.usd += f.size * f.price;
    byAlert.set(f.alertId, cur);
  }
  return (a) => {
    const f = byAlert.get(a.id);
    if (f && a.kind === "close") return { base: f.size, usd: f.usd };
    const usd = a.sizeUsd ?? (f ? f.usd : null);
    const base = f ? f.size : usd !== null && a.alertPrice ? usd / a.alertPrice : null;
    return { base, usd };
  };
}

/** `Long BTC $100` from the posted test body (secret already redacted). Falls back to the market. */
function describeTest(body: string | undefined, fallbackMarket: string | null): string {
  try {
    const j = JSON.parse(body ?? "") as Record<string, unknown>;
    const action = String(j.action ?? "buy").toLowerCase();
    const word = action === "sell" || action === "short" ? "Short" : action.startsWith("close") || action === "flat" ? "Close" : "Long";
    const market = String(j.market ?? fallbackMarket ?? "BTC").replace(/^.*:/, "").replace(/USDT?\.?P?$/, "");
    const usd = Number(j.size_usd);
    return `${word} ${market}${Number.isFinite(usd) && usd > 0 ? ` $${usd}` : ""}`;
  } catch {
    return `Test alert on ${fallbackMarket ?? "BTC"}`;
  }
}
