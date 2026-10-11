import { Check, CircleCheck, CircleX, Hourglass, Inbox, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AlertRecord, Approval } from "@hermes/shared";
import { PageHeader } from "../../components/shell/PageHeader";
import { Badge, Button, Card, CardHeader, Countdown, DataTable, EmptyState, MarketChip, SideLabel, Skeleton, StatusPill, buttonClasses, useDelayedFlag, useToast, type Column } from "../../components/ui";
import { errorMessage, post } from "../../lib/api";
import { alertSide } from "../../lib/alert-view";
import { cn } from "../../lib/cn";
import { formatBps, formatCountdown, formatPrice, formatSize, formatTableTime, formatUsd, orNA } from "../../lib/format";
import { qk, useAlert, useAlerts, useApprovals, useLimits, usePositions } from "../../lib/queries";
import { PAGE } from "../../lib/routes";
import { useNow } from "../live/hooks";

type Decision = "approve" | "reject";
const WEEK = 7 * 86_400_000;
const sideWord = (a: Pick<Approval, "side" | "kind">) => (a.kind === "close" ? "Close" : a.side === "short" ? "Short" : "Long");

interface DecideVars {
  approval: Approval;
  decision: Decision;
  /** `Short BTC 0.120`, for the toast. */
  label: string;
}

/** Approve or reject with an optimistic move from the queue to Decided. Rolls back and says why on failure. */
function useDecide() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ approval, decision }: DecideVars) => post<Approval>(`/api/approvals/${approval.id}/${decision}`),
    onMutate: async ({ approval, decision, label }) => {
      await qc.cancelQueries({ queryKey: qk.approvals.all });
      const snapshot = qc.getQueriesData<Approval[]>({ queryKey: qk.approvals.all });
      const decided: Approval = { ...approval, status: decision === "approve" ? "approved" : "rejected", decidedAt: Date.now() };
      qc.setQueryData<Approval[]>(qk.approvals.list("pending"), (old) => old?.filter((a) => a.id !== approval.id));
      qc.setQueryData<Approval[]>(qk.approvals.list(), (old) => (old ? old.map((a) => (a.id === approval.id ? decided : a)) : old));
      if (decision === "approve") toast.positive("Approved and sent", `${label} is on its way to Perpl.`);
      else toast({ tone: "warning", icon: CircleX, title: "Rejected", body: `${label} was not sent.` });
      return { snapshot };
    },
    onError: (e, vars, ctx) => {
      ctx?.snapshot.forEach(([key, data]) => qc.setQueryData(key, data));
      toast.negative(vars.decision === "approve" ? "Could not approve" : "Could not reject", errorMessage(e), { actions: [{ label: "Try again", onClick: () => retryRef.current?.(vars) }] });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.approvals.all });
      void qc.invalidateQueries({ queryKey: qk.alerts.all });
    },
  });
}
// The toast's "Try again" needs the latest mutate; kept in a module ref so the hook stays simple.
const retryRef: { current: ((v: DecideVars) => void) | null } = { current: null };

export function ApprovalsPage() {
  const now = useNow(1000);
  const qc = useQueryClient();
  const toast = useToast();
  const limits = useLimits();
  const pendingQ = useApprovals("pending");
  const allQ = useApprovals();
  const alertsQ = useAlerts({ limit: 200 });
  const decide = useDecide();
  retryRef.current = (v) => decide.mutate(v);

  const pending = useMemo(() => (pendingQ.data ?? []).filter((a) => a.status === "pending").sort((a, b) => a.expiresAt - b.expiresAt), [pendingQ.data]);
  const alertById = useMemo(() => new Map((alertsQ.data?.items ?? []).map((a) => [a.id, a])), [alertsQ.data]);
  const history = useMemo(
    () =>
      (allQ.data ?? [])
        .filter((a) => a.status !== "pending" && (a.decidedAt ?? a.createdAt) >= Date.now() - WEEK)
        .sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt)),
    [allQ.data],
  );

  // A countdown that reaches zero moves the card to Decided as Expired. The server expires it too; this just does not wait.
  const expired = useRef(new Set<string>());
  useEffect(() => {
    for (const a of pending) {
      if (a.expiresAt > now || expired.current.has(a.id)) continue;
      expired.current.add(a.id);
      qc.setQueryData<Approval[]>(qk.approvals.list("pending"), (old) => old?.filter((x) => x.id !== a.id));
      qc.setQueryData<Approval[]>(qk.approvals.list(), (old) => (old ? old.map((x) => (x.id === a.id ? { ...x, status: "expired", decidedAt: a.expiresAt } : x)) : old));
      toast({ tone: "warning", icon: Hourglass, title: "Expired", body: `${sideWord(a)} ${a.market ?? ""} was not sent.` });
      void qc.invalidateQueries({ queryKey: qk.approvals.all });
    }
  }, [now, pending, qc, toast]);

  // A approves and R rejects the top card.
  const top = pending[0];
  const topLabel = top ? `${sideWord(top)} ${top.market ?? ""}`.trim() : "";
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (!top || e.metaKey || e.ctrlKey || e.altKey || decide.isPending) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable], [role=dialog]") || t.isContentEditable)) return;
      if (e.key === "a" || e.key === "A") decide.mutate({ approval: top, decision: "approve", label: topLabel });
      else if (e.key === "r" || e.key === "R") decide.mutate({ approval: top, decision: "reject", label: topLabel });
    },
    [top, topLabel, decide],
  );
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  const threshold = limits.data?.approvalThresholdUsd ?? null;
  const loading = pendingQ.isLoading;
  const skeleton = useDelayedFlag(loading);
  const failed = pendingQ.isError && !pendingQ.data;
  const nothing = !loading && !failed && pending.length === 0;

  return (
    <>
      <PageHeader
        title={
          <span className="row g2">
            Approvals {pending.length > 0 && <Badge variant="count">{pending.length}</Badge>}
          </span>
        }
        documentTitle="Approvals"
        subtitle={
          threshold !== null && threshold > 0 ? (
            <>
              Orders above your <span className="mono">{formatUsd(threshold, { decimals: 0 })}</span> approval threshold wait here. Nothing is sent until you approve.
            </>
          ) : (
            PAGE.approvals.subtitle
          )
        }
        actions={
          <Link className={buttonClasses({ variant: "ghost" })} to="/limits">
            <SlidersHorizontal aria-hidden />
            Change threshold
          </Link>
        }
      />

      {failed && (
        <Card>
          <EmptyState icon={CircleX} tone="negative" title="Could not load approvals" actions={<Button size="sm" onClick={() => void pendingQ.refetch()}>Retry</Button>}>
            Hermes did not respond. Orders waiting for you still expire on schedule.
          </EmptyState>
        </Card>
      )}
      {loading && skeleton && <ApprovalSkeleton />}
      {nothing && (
        <Card>
          <EmptyState icon={Inbox} title="Nothing to approve">
            {threshold !== null && threshold > 0 ? `Orders above ${formatUsd(threshold, { decimals: 0 })} wait here for you.` : "Orders above your approval threshold wait here for you."} You can change that amount in Risk limits.
          </EmptyState>
        </Card>
      )}

      {pending.map((a) => (
        <ApprovalCard key={a.id} approval={a} now={now} busy={decide.isPending && decide.variables?.approval.id === a.id} onDecide={(decision, label) => decide.mutate({ approval: a, decision, label })} />
      ))}

      {history.length > 0 && <DecidedCard rows={history} alerts={alertById} />}
    </>
  );
}

// --- pending card --------------------------------------------------------------------------

function ApprovalCard({ approval: a, now, busy, onDecide }: { approval: Approval; now: number; busy: boolean; onDecide: (d: Decision, label: string) => void }) {
  const detail = useAlert(a.alertId);
  const limits = useLimits();
  const positions = usePositions();
  const d = detail.data;
  const parsed = (d?.parsed ?? {}) as { size?: number; leverage?: number; maxSlippageBps?: number };
  const market = a.market ?? d?.market ?? null;
  const price = d?.alertPrice ?? null;
  const notional = a.notionalUsd ?? d?.sizeUsd ?? null;
  const size = parsed.size ?? (notional !== null && price ? notional / price : null);
  const threshold = limits.data?.approvalThresholdUsd ?? null;
  const slip = parsed.maxSlippageBps ?? limits.data?.defaultSlippageBps ?? null;
  // Buying (open long, close short) pays up to the cap above the alert price; selling gets down to the cap below it.
  const buy = (a.kind === "open" && a.side === "long") || (a.kind === "close" && a.side === "short");
  const limitPrice = price !== null && slip !== null ? price * (1 + (buy ? 1 : -1) * (slip / 1e4)) : null;
  const mark = positions.data?.find((p) => p.market === market)?.markPrice ?? null;
  // Positive = worse for the trader.
  const moveBps = mark !== null && price ? ((mark - price) / price) * 1e4 * (buy ? 1 : -1) : null;

  const remaining = Math.max(0, Math.ceil((a.expiresAt - now) / 1000));
  const total = Math.max(1, Math.round((a.expiresAt - a.createdAt) / 1000));
  const sizeText = orNA(size, (v) => formatSize(v, market));
  const label = `${sideWord(a)} ${market ?? ""} ${sizeText === "n/a" ? "" : sizeText}`.trim();
  const levText = parsed.leverage ? `${parsed.leverage.toFixed(1)}x` : "n/a";

  return (
    <section className="card appr" aria-label={`Approval for ${label}`}>
      <div className="appr-head">
        <div className="col g1">
          <div className="appr-title">
            {a.kind === "close" ? <SideLabel side={a.side === "short" ? "close-short" : "close-long"} /> : <SideLabel side={a.side === "short" ? "short" : "long"} />}
            {market && <MarketChip market={market} />}
            <span className="mono">{sizeText}</span>
          </div>
          <span className="xs muted">
            {a.strategyName ?? "n/a"} · alert{" "}
            <Link className="link mono" to={`/alerts/${a.alertId}`}>
              {a.alertId}
            </Link>{" "}
            at <span className="mono">{formatTableTime(a.createdAt, now)}</span>
          </span>
        </div>
        <Countdown remainingSec={remaining} totalSec={total} />
      </div>
      <div className="appr-stats">
        <div>
          <span className="l">Notional</span>
          <span className="v">{orNA(notional, (v) => formatUsd(v))}</span>
          <span className="s">{notional !== null && threshold ? `${formatUsd(Math.max(0, notional - threshold), { decimals: 0 })} over threshold` : "n/a"}</span>
        </div>
        <div>
          <span className="l">Alert price</span>
          <span className="v">{formatPrice(price, market)}</span>
          <span className="s">from TradingView</span>
        </div>
        <div>
          <span className="l">Mark now</span>
          <span className="v">{formatPrice(mark, market)}</span>
          <span className={cn("s", moveBps !== null && moveBps < 0 && "pos", moveBps !== null && moveBps > 5 && "warn")}>
            {moveBps === null ? "No open position to read it from" : moveBps < 0 ? `${formatBps(Math.abs(moveBps))} better ${buy ? "for a buy" : "for a short"}` : `${formatBps(moveBps)} worse than alert`}
          </span>
        </div>
        <div>
          <span className="l">Limit price</span>
          <span className="v">{formatPrice(limitPrice, market)}</span>
          <span className="s">{slip !== null ? `alert ${buy ? "plus" : "minus"} ${slip} bps` : "n/a"}</span>
        </div>
        <div>
          <span className="l">Leverage</span>
          <span className="v">{levText}</span>
          <span className="s">{limits.data ? `max ${limits.data.maxLeverage}x` : "n/a"}</span>
        </div>
      </div>
      <div className="appr-foot">
        <span className="note">
          <CircleCheck className="i-14 pos" aria-hidden />
          Passed the other 5 checks. Approving sends the order to Perpl at once.
        </span>
        <Button variant="secondary" kbd="R" disabled={busy} onClick={() => onDecide("reject", label)}>
          Reject
        </Button>
        <Button variant="primary" icon={Check} kbd="A" disabled={busy} onClick={() => onDecide("approve", label)}>
          Approve and send
        </Button>
      </div>
    </section>
  );
}

function ApprovalSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading">
      <div className="appr-head">
        <div className="col g1">
          <Skeleton w={160} h={24} />
          <Skeleton w={260} h={12} />
        </div>
        <Skeleton w={120} h={32} style={{ marginLeft: "auto" }} />
      </div>
      <div className="appr-stats">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i}>
            <Skeleton w={60} h={12} />
            <Skeleton w={90} h={20} />
            <Skeleton w={80} h={12} />
          </div>
        ))}
      </div>
      <div className="appr-foot" style={{ justifyContent: "flex-end" }}>
        <Skeleton w={80} h={32} r={6} />
        <Skeleton w={150} h={32} r={6} />
      </div>
    </Card>
  );
}

// --- history -------------------------------------------------------------------------------

function resultFor(a: Approval, alert: AlertRecord | undefined) {
  if (a.status === "rejected" || a.status === "expired") return <span className="muted">Not sent</span>;
  if (!alert) return <span className="faint">n/a</span>;
  if (alert.status === "filled" || alert.status === "partially_filled")
    return (
      <>
        Filled{alert.slippageBps !== null && (
          <>
            {" "}· <span className="mono">{formatBps(alert.slippageBps)}</span>
          </>
        )}
      </>
    );
  if (alert.status === "failed") return <span className="neg">Not filled</span>;
  if (alert.status === "blocked") return <span className="muted">Not sent</span>;
  return <span className="muted">In flight</span>;
}

function DecidedCard({ rows, alerts }: { rows: Approval[]; alerts: Map<string, AlertRecord> }) {
  const columns: Column<Approval>[] = [
    { key: "asked", header: "Asked", hideSm: true, mono: true, className: "secondary", cell: (a) => formatTableTime(a.createdAt) },
    {
      key: "order",
      header: "Order",
      cell: (a) => {
        const al = alerts.get(a.alertId);
        const price = al?.alertPrice;
        const size = a.notionalUsd !== null && price ? a.notionalUsd / price : null;
        return (
          <span className="row g2">
            {a.kind === "close" && al ? <SideLabel side={alertSide(al)} /> : <SideLabel side={a.side === "short" ? "short" : "long"} />}
            {a.market && <MarketChip market={a.market} />}
            <span className="mono xs">{orNA(size, (v) => formatSize(v, a.market))}</span>
          </span>
        );
      },
    },
    { key: "strategy", header: "Strategy", hideSm: true, className: "secondary", cell: (a) => a.strategyName ?? "n/a" },
    { key: "notional", header: "Notional", numeric: true, hideSm: true, cell: (a) => orNA(a.notionalUsd, (v) => formatUsd(v)) },
    {
      key: "decision",
      header: "Decision",
      cell: (a) => {
        const took = a.decidedAt ? Math.max(0, Math.round((a.decidedAt - a.createdAt) / 1000)) : null;
        if (a.status === "approved")
          return (
            <>
              <StatusPill tone="positive" icon={Check}>Approved</StatusPill> {took !== null && <span className="xs muted mono">in {formatCountdown(took)}</span>}
            </>
          );
        if (a.status === "rejected")
          return (
            <StatusPill tone="negative" icon={X}>
              Rejected
            </StatusPill>
          );
        return (
          <>
            <StatusPill icon={Hourglass}>Expired</StatusPill> <span className="xs muted mono">after {formatCountdown(Math.round((a.expiresAt - a.createdAt) / 1000))}</span>
          </>
        );
      },
    },
    { key: "result", header: "Result", hideSm: true, className: "xs secondary", cell: (a) => resultFor(a, alerts.get(a.alertId)) },
  ];
  return (
    <Card>
      <CardHeader title="Decided" meta="Last 7 days" />
      <DataTable aria-label="Decided approvals" columns={columns} rows={rows} rowKey={(a) => a.id} rowHref={(a) => `/alerts/${a.alertId}`} />
    </Card>
  );
}
