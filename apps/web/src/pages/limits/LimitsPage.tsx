import { CirclePause, CircleX, Play, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { MARKET_SYMBOLS, type AlertRecord, type RiskLimits } from "@hermes/shared";
import { PageHeader } from "../../components/shell/PageHeader";
import { errorMessage } from "../../lib/api";
import { formatBps, formatDateTime, formatLeverageX, formatNumber, formatPrice, formatSignedUsd, formatUsd, orNA } from "../../lib/format";
import { PAGE } from "../../lib/routes";
import { useAccount, useAlerts, useApprovals, useLimits, useMarkets, useOrders, usePositions, useSetPaused, useUpdateLimits } from "../../lib/queries";
import {
  Button,
  Card,
  CardHeader,
  ConfirmModal,
  EmptyState,
  KpiRow,
  KpiTile,
  MarketChip,
  MarketTile,
  Meter,
  NumberInput,
  SaveBar,
  Select,
  Skeleton,
  useDelayedFlag,
  useToast,
} from "../../components/ui";
import { msUntilUtcMidnight, startOfLocalDay, useNow } from "../common/useNow";
import { LeverageScale } from "./LeverageScale";
import { LimitRow, UsageHead } from "./LimitRow";

type Draft = Omit<RiskLimits, "paused">;
const FIELDS = ["allowedMarkets", "maxPositionUsd", "maxLeverage", "dailyLossStopUsd", "approvalThresholdUsd", "approvalExpirySec", "maxAlertAgeSec", "maxOrdersPerMinute", "defaultSlippageBps"] as const;
type Field = (typeof FIELDS)[number];

const LABEL: Record<Field, string> = {
  allowedMarkets: "Allowed markets",
  maxPositionUsd: "Max position size",
  maxLeverage: "Max leverage",
  dailyLossStopUsd: "Daily loss stop",
  approvalThresholdUsd: "Approval threshold",
  approvalExpirySec: "Approval expiry",
  maxAlertAgeSec: "Max alert age",
  maxOrdersPerMinute: "Max orders per minute",
  defaultSlippageBps: "Default slippage",
};

/** `30 s`, `2 min`, `1 h`, `90 s`: whole units only, the way the select reads. */
const formatExpiry = (sec: number): string => (sec % 3600 === 0 ? `${sec / 3600} h` : sec % 60 === 0 ? `${sec / 60} min` : `${formatNumber(sec)} s`);
const EXPIRY_CHOICES = [30, 60, 120, 300, 600, 1800, 3600];

const fmtField = (f: Field, l: Draft): string => {
  switch (f) {
    case "allowedMarkets":
      return l.allowedMarkets.join(", ") || "none";
    case "maxPositionUsd":
    case "dailyLossStopUsd":
    case "approvalThresholdUsd":
      return formatUsd(l[f], { decimals: Number.isInteger(l[f]) ? 0 : 2 });
    case "maxLeverage":
      return formatLeverageX(l.maxLeverage);
    case "approvalExpirySec":
      return formatExpiry(l.approvalExpirySec);
    case "maxAlertAgeSec":
      return `${formatNumber(l.maxAlertAgeSec)} s`;
    case "maxOrdersPerMinute":
      return `${formatNumber(l.maxOrdersPerMinute)} per min`;
    case "defaultSlippageBps":
      return `${formatNumber(l.defaultSlippageBps)} bps`;
  }
};

const sameField = (f: Field, a: Draft, b: Draft) => (f === "allowedMarkets" ? [...a[f]].sort().join() === [...b[f]].sort().join() : a[f] === b[f]);

const REASON_SHORT: Record<string, string> = {
  size_above_max: "Size",
  market_not_allowed: "Market",
  leverage_above_max: "Leverage",
  daily_loss_stop_hit: "Loss stop",
  trading_paused: "Paused",
  stale_alert: "Age",
  rate_limited: "Rate",
  strategy_disabled: "Disabled",
  no_position_to_close: "No position",
  perpl_not_connected: "Perpl",
  invalid_size: "Size unknown",
};

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function LimitsPage() {
  const toast = useToast();
  const limits = useLimits();
  const update = useUpdateLimits();
  const setPaused = useSetPaused();
  const positions = usePositions();
  const account = useAccount();
  const markets = useMarkets();
  const alerts = useAlerts({ limit: 200 });
  const approvals = useApprovals();
  const orders = useOrders(100);
  const now = useNow(1000 * 20);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmPause, setConfirmPause] = useState(false);
  const slow = useDelayedFlag(limits.isLoading);

  const saved = limits.data;
  const savedDraft: Draft | null = useMemo(() => {
    if (!saved) return null;
    const { paused: _p, ...rest } = saved;
    return rest;
  }, [saved]);
  const d = draft ?? savedDraft;

  // --- today's numbers from cached data (the stream keeps them current) ---
  const today = useMemo(() => {
    const start = startOfLocalDay(now);
    const list = (alerts.data?.items ?? []).filter((a) => a.receivedAt >= start);
    const checked = list.filter((a) => !["rejected_auth", "invalid", "duplicate", "received", "verified"].includes(a.status));
    const blocked = list.filter((a) => a.status === "blocked");
    const byReason = new Map<string, number>();
    for (const a of blocked) byReason.set(a.blockReason ?? "other", (byReason.get(a.blockReason ?? "other") ?? 0) + 1);
    const reasonCount = (r: string) => byReason.get(r) ?? 0;
    const blockedMarkets = new Map<string, number>();
    for (const a of blocked) if (a.blockReason === "market_not_allowed" && a.market) blockedMarkets.set(a.market, (blockedMarkets.get(a.market) ?? 0) + 1);
    const slip = list.map((a: AlertRecord) => a.slippageBps).filter((x): x is number => x !== null);
    return { checked: checked.length, blocked: blocked.length, byReason, reasonCount, blockedMarkets, slipMedian: median(slip) };
  }, [alerts.data, now]);

  // The daily loss stop is evaluated by the server on total PnL today (realized + unrealized, UTC day).
  const alertsFailed = alerts.isError && !alerts.data;
  const acc = account.data;
  const pnlToday = acc ? (acc.todayPnlUsd ?? acc.realizedPnlTodayUsd + acc.unrealizedPnlUsd) : null;
  const lossUsed = acc ? (acc.lossStopUsedUsd ?? Math.max(0, -(pnlToday ?? 0))) : null;
  const marks = useMemo(() => new Map((markets.data ?? []).map((m) => [m.symbol, m.markPrice])), [markets.data]);

  const pos = positions.data ?? [];
  const posByMarket = new Map(pos.map((p) => [p.market, p]));

  const ordersLastMinute = (orders.data ?? []).filter((o) => o.createdAt >= now - 60_000).length;
  const pending = approvals.data?.filter((a) => a.status === "pending").length ?? 0;
  const approvalStats = useMemo(() => {
    const since = now - 7 * 86_400_000;
    const week = (approvals.data ?? []).filter((a) => a.createdAt >= since);
    const n = (s: string) => week.filter((a) => a.status === s).length;
    return { asked: week.length, waiting: n("pending"), approved: n("approved"), expired: n("expired"), rejected: n("rejected") };
  }, [approvals.data, now]);

  // Highest leverage among open positions: from the latest opening order in that market.
  const leverageByMarket = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of orders.data ?? []) {
      if (o.kind !== "open" || o.leverage === null || !o.market || m.has(o.market)) continue;
      m.set(o.market, o.leverage);
    }
    return m;
  }, [orders.data]);

  // --- validation ---
  const errors = useMemo(() => {
    if (!d) return {} as Partial<Record<Field, string>>;
    const e: Partial<Record<Field, string>> = {};
    if (d.allowedMarkets.length === 0) e.allowedMarkets = "Keep at least one market, or pause trading instead.";
    if (!(d.maxPositionUsd > 0)) e.maxPositionUsd = "Max position size must be above $0.";
    if (!(d.maxLeverage >= 1 && d.maxLeverage <= 20)) e.maxLeverage = "Leverage must be between 1x and 20x.";
    if (!(d.dailyLossStopUsd > 0)) e.dailyLossStopUsd = "Daily loss stop must be above $0.";
    if (!(d.approvalThresholdUsd > 0)) e.approvalThresholdUsd = "Approval threshold must be above $0.";
    if (!(d.approvalExpirySec >= 10 && d.approvalExpirySec <= 86_400)) e.approvalExpirySec = "Approvals expire after 10 seconds to 24 hours.";
    if (!(d.maxAlertAgeSec > 0)) e.maxAlertAgeSec = "Max alert age must be above 0 seconds.";
    if (!(d.maxOrdersPerMinute >= 1) || !Number.isInteger(d.maxOrdersPerMinute)) e.maxOrdersPerMinute = "Use a whole number of orders, at least 1.";
    if (!(d.defaultSlippageBps >= 0) || !Number.isInteger(d.defaultSlippageBps)) e.defaultSlippageBps = "Use a whole number of bps, 0 or more.";
    return e;
  }, [d]);
  const invalid = Object.keys(errors).length > 0;

  const changed: Field[] = savedDraft && d ? FIELDS.filter((f) => !sameField(f, savedDraft, d)) : [];
  const dirty = changed.length > 0;
  // Meters and tiles keep measuring against the SAVED value while a field holds something invalid (0, empty).
  const eff = <K extends Field>(k: K, valid: boolean): Draft[K] => (valid || !savedDraft ? d![k] : savedDraft[k]);
  const set = <K extends Field>(k: K, v: Draft[K]) => d && setDraft({ ...d, [k]: v });
  const was = (f: Field) => (savedDraft && changed.includes(f) ? <> Was <span className="mono">{fmtField(f, savedDraft)}</span>. Saved changes apply to the next alert.</> : null);

  const save = () => {
    if (!d || !saved) return;
    if (invalid) {
      toast.warning("Fix the highlighted fields", "Nothing was saved yet.");
      return;
    }
    update.mutate(
      { ...d, paused: saved.paused },
      {
        onSuccess: () => {
          setDraft(null);
          toast.positive("Limits saved", "They apply from the next alert.");
        },
        onError: (e) =>
          toast.negative("Could not save limits", `${errorMessage(e, "The server did not answer.")} Your changes are still here.`, { actions: [{ label: "Try again", onClick: save }] }),
      },
    );
  };

  const doPause = () => {
    const next = !saved?.paused;
    setPaused.mutate(next, {
      onSuccess: () => {
        setConfirmPause(false);
        if (!next) toast.positive("Trading resumed", "Hermes sends new orders again from the next alert.");
        else toast.warning("Trading paused", "New orders are blocked. Open positions stay open.");
      },
      onError: (e) => toast.negative("Could not change trading", errorMessage(e)),
    });
  };

  const paused = Boolean(saved?.paused);
  const header = (
    <PageHeader
      title={PAGE.limits.title}
      subtitle={PAGE.limits.subtitle}
      actions={
        paused ? (
          <Button variant="primary" icon={Play} loading={setPaused.isPending} loadingLabel="Resuming" onClick={doPause}>
            Resume trading
          </Button>
        ) : (
          <Button variant="danger" icon={CirclePause} disabled={!saved} onClick={() => setConfirmPause(true)}>
            Pause trading
          </Button>
        )
      }
    />
  );

  if (limits.isError && !saved) {
    return (
      <>
        {header}
        <Card>
          <EmptyState icon={CircleX} tone="negative" title="Could not load your limits" actions={<Button onClick={() => void limits.refetch()}>Retry</Button>}>
            Hermes did not respond. Your limits are still enforced on the server.
          </EmptyState>
        </Card>
      </>
    );
  }

  if (!d || !saved) {
    return (
      <>
        {header}
        <KpiRow aria-label="Limits today">
          {[0, 1, 2, 3].map((i) => (
            <KpiTile key={i} label="" loading={slow} />
          ))}
        </KpiRow>
        <Card>
          <CardHeader title="Limits" />
          <div aria-busy="true" aria-label="Loading limits">
            {[0, 1, 2, 3].map((i) => (
              <div className="set-row" key={i}>
                <div className="col g2">{slow && <><Skeleton w={140} h={14} /><Skeleton h={12} /><Skeleton w="70%" h={12} /></>}</div>
                {slow && <Skeleton h={32} r={6} />}
                {slow && <Skeleton h={32} r={6} />}
              </div>
            ))}
          </div>
        </Card>
      </>
    );
  }

  const posRows = [...pos].sort((a, b) => b.notionalUsd - a.notionalUsd);
  const largest = posRows[0];
  const expiryOptions = [...new Set([...EXPIRY_CHOICES, d.approvalExpirySec, saved.approvalExpirySec])].sort((a, b) => a - b).map((v) => ({ value: String(v), label: formatExpiry(v) }));
  const levRows = posRows.map((p) => ({ market: p.market, lv: leverageByMarket.get(p.market) })).filter((r): r is { market: string; lv: number } => r.lv !== undefined);
  const maxLevOpen = levRows.reduce((m, r) => Math.max(m, r.lv), 0);
  const levGroups = new Map<number, string[]>();
  for (const r of levRows) levGroups.set(r.lv, [...(levGroups.get(r.lv) ?? []), r.market]);
  const levText = [...levGroups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([lv, ms]) => `${ms.length > 1 ? `${ms.slice(0, -1).join(", ")} and ${ms[ms.length - 1]}` : ms[0]} at ${formatLeverageX(lv, { decimals: 1 })}`)
    .join(", ");
  const resetMs = msUntilUtcMidnight(now);
  const resetText = `${Math.floor(resetMs / 3_600_000)}h ${String(Math.floor((resetMs % 3_600_000) / 60_000)).padStart(2, "0")}m`;
  const posCap = eff("maxPositionUsd", !errors.maxPositionUsd);
  const levCap = eff("maxLeverage", !errors.maxLeverage);
  const lossCap = eff("dailyLossStopUsd", !errors.dailyLossStopUsd);
  const rateCap = eff("maxOrdersPerMinute", !errors.maxOrdersPerMinute);
  const slipCap = eff("defaultSlippageBps", !errors.defaultSlippageBps);
  const lossPct = lossUsed !== null && lossCap > 0 ? (lossUsed / lossCap) * 100 : null;
  const lastChanged = saved.updatedAt ? formatDateTime(saved.updatedAt).replace(/ (\d\d:\d\d)$/, ", $1") : null;
  const blockedBy = (r: string) => today.reasonCount(r);
  const reasons = [...today.byReason.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => ({ label: REASON_SHORT[r] ?? "Other", n }));
  // Each "label count" pair stays on one line, so a narrow tile never leaves an orphan number.
  const reasonText =
    reasons.length === 0 ? null : (
      <>
        {reasons.map((r, i) => (
          <span key={r.label}>
            {i > 0 && " · "}
            <span style={{ whiteSpace: "nowrap" }}>
              {r.label} {r.n}
            </span>
          </span>
        ))}
      </>
    );

  return (
    <>
      {header}

      <KpiRow aria-label="Limits today">
        <KpiTile
          label="Alerts checked today"
          value={alertsFailed ? "n/a" : formatNumber(today.checked)}
          sub={alertsFailed ? "Could not load alerts" : `${today.checked - today.blocked} passed · ${today.blocked} stopped`}
          loading={alerts.isLoading}
        />
        <KpiTile label="Blocked by a limit" value={alertsFailed ? "n/a" : formatNumber(today.blocked)} sub={alertsFailed ? "Could not load alerts" : (reasonText ?? "Nothing blocked today")} loading={alerts.isLoading} />
        <KpiTile
          label="Daily loss used"
          value={lossPct === null ? "n/a" : formatNumber(lossPct, 1)}
          unit={lossPct === null ? undefined : "%"}
          tone={lossPct !== null && lossPct >= 100 ? "negative" : lossPct !== null && lossPct >= 80 ? "warning" : undefined}
          sub={
            lossUsed === null ? (
              account.isError ? "Could not load your account" : "Waiting for your account"
            ) : (
              <>
                <span className="d secondary">{formatUsd(lossUsed)}</span> of <span className="d secondary">{formatUsd(lossCap, { decimals: Number.isInteger(lossCap) ? 0 : 2 })}</span>
              </>
            )
          }
          loading={account.isLoading}
        />
        <KpiTile
          label="Waiting for approval"
          value={formatNumber(pending)}
          sub={
            <Link className="link" to="/approvals">
              Open approvals
            </Link>
          }
          loading={approvals.isLoading}
        />
      </KpiRow>

      <Card>
        <CardHeader title="Limits" meta={lastChanged ? `Last changed ${lastChanged}` : "No changes saved yet"} />

        <LimitRow
          wide
          label="Allowed markets"
          changed={changed.includes("allowedMarkets")}
          description="Alerts for any other market are blocked. Turning a market off does not close open positions."
          control={
            <>
              <div className="mkt-tiles" role="group" aria-label="Allowed markets">
                {MARKET_SYMBOLS.map((m) => {
                  const on = d.allowedMarkets.includes(m);
                  const p = posByMarket.get(m);
                  // The mark is a market value: it comes from market data, with a held position as a fallback.
                  const mark = marks.get(m) ?? p?.markPrice ?? null;
                  const blocked = today.blockedMarkets.get(m) ?? 0;
                  return (
                    <MarketTile
                      key={m}
                      market={m}
                      checked={on}
                      onChange={(c) => set("allowedMarkets", c ? [...d.allowedMarkets, m] : d.allowedMarkets.filter((x) => x !== m))}
                      price={mark !== null ? <span style={on ? undefined : { color: "var(--text-muted)" }}>{formatPrice(mark, m)}</span> : markets.isLoading ? <span className="muted">&nbsp;</span> : <span className="muted">n/a</span>}
                      note={
                        blocked > 0 && !on ? (
                          <span className="warn">{plural(blocked, "alert")} blocked today</span>
                        ) : mark === null && !markets.isLoading ? (
                          "No mark price from Perpl"
                        ) : p ? (
                          <>Open {formatUsd(p.notionalUsd, { decimals: 0 })}</>
                        ) : (
                          "No position"
                        )
                      }
                    />
                  );
                })}
              </div>
              {errors.allowedMarkets && (
                <span className="field-error" role="alert">
                  {errors.allowedMarkets}
                </span>
              )}
            </>
          }
        />

        <LimitRow
          label="Max position size"
          changed={changed.includes("maxPositionUsd")}
          description="Largest position Hermes may hold in one market, in USD notional, after the order fills."
          control={
            <NumberInput
              aria-label="Max position size in USD"
              prefix="$"
              unit="per market"
              value={d.maxPositionUsd}
              onValueChange={(v) => set("maxPositionUsd", v ?? 0)}
              min={0}
              error={errors.maxPositionUsd}
              hint={was("maxPositionUsd") ?? (blockedBy("size_above_max") > 0 ? `${plural(blockedBy("size_above_max"), "alert")} blocked by this today.` : "Nothing blocked by this today.")}
            />
          }
          usage={
            <div className="usage">
              <UsageHead label="Now, per market" value={largest && posCap > 0 ? <>Largest {formatNumber((largest.notionalUsd / posCap) * 100, 1)}%</> : undefined} />
              {posRows.length === 0 ? (
                <span className="xs muted">No open positions.</span>
              ) : (
                <div className="bars">
                  {posRows.map((p) => (
                    <div className="bar-row" key={p.market}>
                      <MarketChip market={p.market} />
                      <Meter value={p.notionalUsd} max={posCap} aria-label={`${p.market} position against the limit`} />
                      <span className="v">
                        {formatUsd(p.notionalUsd, { decimals: 0 })} / {formatUsd(posCap, { decimals: 0 })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          }
        />

        <LimitRow
          label="Max leverage"
          changed={changed.includes("maxLeverage")}
          description="Alerts asking for more are blocked, not reduced. Perpl's own market maximum still applies."
          control={
            <div className="field">
              <NumberInput aria-label="Max leverage" unit="x" value={d.maxLeverage} onValueChange={(v) => set("maxLeverage", v ?? 0)} min={0} max={50} error={errors.maxLeverage} hint={was("maxLeverage") ?? undefined} />
              <LeverageScale value={d.maxLeverage} onChange={(v) => set("maxLeverage", v)} />
            </div>
          }
          usage={
            <div className="usage">
              <UsageHead
                label="Highest open position"
                value={
                  levRows.length ? (
                    <>
                      {formatLeverageX(maxLevOpen, { decimals: 1 })} <span className="muted">/ {formatLeverageX(levCap)}</span>
                    </>
                  ) : (
                    "n/a"
                  )
                }
              />
              <Meter value={maxLevOpen} max={levCap} aria-label="Highest open leverage against the limit" />
              <span className="xs muted">{levRows.length ? `${levText}.` : posRows.length ? "Leverage of open positions is not available yet." : "No open positions."}</span>
            </div>
          }
        />

        <LimitRow
          label="Daily loss stop"
          changed={changed.includes("dailyLossStopUsd")}
          description="Once today's realized and unrealized loss reaches this, Hermes blocks new orders until 00:00 UTC. Orders that close a position still go through."
          control={
            <NumberInput
              aria-label="Daily loss stop in USD"
              prefix="$"
              unit="per day"
              value={d.dailyLossStopUsd}
              onValueChange={(v) => set("dailyLossStopUsd", v ?? 0)}
              min={0}
              error={errors.dailyLossStopUsd}
              hint={was("dailyLossStopUsd") ?? undefined}
            />
          }
          usage={
            <div className="usage">
              <UsageHead
                label="Used today"
                value={
                  lossUsed === null ? (
                    "n/a"
                  ) : (
                    <>
                      {formatUsd(lossUsed)} <span className="muted">/ {formatUsd(lossCap, { decimals: Number.isInteger(lossCap) ? 0 : 2 })}</span>
                    </>
                  )
                }
              />
              <Meter value={lossUsed ?? 0} max={lossCap} size="lg" threshold={0.8} aria-label="Daily loss used" />
              {acc && pnlToday !== null && (
                <span className="xs muted">
                  PnL today <span className={`mono ${pnlToday < 0 ? "neg" : pnlToday > 0 ? "pos" : "secondary"}`}>{formatSignedUsd(pnlToday)}</span>
                  {acc.todayRealizedUsd !== undefined && acc.todayUnrealizedUsd !== undefined && (
                    <>
                      {" "}
                      · realized <span className="mono secondary">{formatSignedUsd(acc.todayRealizedUsd)}</span> · open <span className="mono secondary">{formatSignedUsd(acc.todayUnrealizedUsd)}</span>
                    </>
                  )}
                </span>
              )}
              <span className="xs muted">
                Resets in <span className="mono secondary">{resetText}</span>. You get a warning at 80%.
              </span>
            </div>
          }
        />

        <LimitRow
          label="Approval threshold"
          changed={changed.includes("approvalThresholdUsd") || changed.includes("approvalExpirySec")}
          description="Orders above this notional wait for you in Approvals. If you do nothing, they expire and are not sent."
          control={
            <div className="col g3">
              <NumberInput
                aria-label="Approval threshold in USD"
                prefix="$"
                unit="notional"
                value={d.approvalThresholdUsd}
                onValueChange={(v) => set("approvalThresholdUsd", v ?? 0)}
                min={0}
                error={errors.approvalThresholdUsd}
                hint={was("approvalThresholdUsd") ?? undefined}
              />
              <Select
                label="Expire after"
                value={String(d.approvalExpirySec)}
                onChange={(v) => set("approvalExpirySec", Number(v))}
                options={expiryOptions}
                error={errors.approvalExpirySec}
                hint={was("approvalExpirySec") ?? "An order nobody approves in time is not sent."}
              />
            </div>
          }
          usage={
            <div className="usage">
              <UsageHead label="Last 7 days" value={`${approvalStats.asked} asked`} />
              <div className="row g4 xs secondary wrap">
                <span>
                  <span className="mono fg">{approvalStats.waiting}</span> waiting now
                </span>
                <span>
                  <span className="mono fg">{approvalStats.approved}</span> approved
                </span>
                <span>
                  <span className="mono fg">{approvalStats.expired}</span> expired
                </span>
                <span>
                  <span className="mono fg">{approvalStats.rejected}</span> rejected
                </span>
              </div>
              {pending > 0 && (
                <Link className="link xs" to="/approvals">
                  Review the {pending} waiting
                </Link>
              )}
            </div>
          }
        />

        <LimitRow
          label="Max alert age"
          changed={changed.includes("maxAlertAgeSec")}
          description="Alerts that reach Hermes later than this, measured from the alert's own time, are blocked as stale."
          control={<NumberInput aria-label="Max alert age in seconds" unit="seconds" value={d.maxAlertAgeSec} onValueChange={(v) => set("maxAlertAgeSec", v ?? 0)} min={0} error={errors.maxAlertAgeSec} hint={was("maxAlertAgeSec") ?? undefined} />}
          usage={
            <div className="usage">
              <UsageHead label="Blocked as too old today" value={blockedBy("stale_alert")} />
              <span className="xs muted">{blockedBy("stale_alert") > 0 ? "Check that TradingView and your clock agree, or raise the limit." : "Nothing arrived too late today."}</span>
            </div>
          }
        />

        <LimitRow
          label="Max orders per minute"
          changed={changed.includes("maxOrdersPerMinute")}
          description="A runaway strategy stops here. Further alerts in the same minute are blocked until the count drops."
          control={<NumberInput aria-label="Max orders per minute" unit="per minute" value={d.maxOrdersPerMinute} onValueChange={(v) => set("maxOrdersPerMinute", v ?? 0)} min={0} error={errors.maxOrdersPerMinute} hint={was("maxOrdersPerMinute") ?? undefined} />}
          usage={
            <div className="usage">
              <UsageHead
                label="Last minute"
                value={
                  <>
                    {ordersLastMinute} <span className="muted">/ {formatNumber(rateCap)}</span>
                  </>
                }
              />
              <Meter value={ordersLastMinute} max={rateCap} aria-label="Orders in the last minute" />
              <span className="xs muted">{blockedBy("rate_limited") > 0 ? `${plural(blockedBy("rate_limited"), "alert")} blocked by this today.` : "Nothing blocked by this today."}</span>
            </div>
          }
        />

        <LimitRow
          label="Default slippage"
          changed={changed.includes("defaultSlippageBps")}
          description="How far from the alert price an order may fill. Buys may go up by this much and sells down. A strategy can set its own."
          control={<NumberInput aria-label="Default slippage in bps" unit="bps" value={d.defaultSlippageBps} onValueChange={(v) => set("defaultSlippageBps", v ?? 0)} min={0} error={errors.defaultSlippageBps} hint={was("defaultSlippageBps") ?? undefined} />}
          usage={
            <div className="usage">
              <UsageHead
                label="Median slippage today"
                value={
                  today.slipMedian === null ? (
                    "n/a"
                  ) : (
                    <>
                      {formatBps(today.slipMedian)} <span className="muted">/ {formatNumber(slipCap)} bps</span>
                    </>
                  )
                }
              />
              <Meter value={Math.max(0, today.slipMedian ?? 0)} max={slipCap} aria-label="Median slippage against the limit" />
              <span className="xs muted">{orNA(today.slipMedian, () => "Positive slippage means a worse fill than the alert price.")}</span>
            </div>
          }
        />
      </Card>

      <Card>
        <div className="card-body row g3 wrap" style={{ alignItems: "center" }}>
          <ShieldCheck className="i-16 pos" aria-hidden />
          <span className="secondary" style={{ flex: "1 1 240px" }}>
            Wallet policy is enforced by Privy on every transaction.
          </span>
          <Link className="link" to="/wallet">
            See wallet policy
          </Link>
        </div>
      </Card>

      {dirty && (
        <SaveBar
          saving={update.isPending}
          onDiscard={() => setDraft(null)}
          onSave={save}
          summary={
            <>
              {plural(changed.length, "unsaved change")} ·{" "}
              {changed.length === 1 && savedDraft ? (
                <>
                  {LABEL[changed[0]!]} <span className="mono">{fmtField(changed[0]!, savedDraft)}</span> to <span className="mono fg">{fmtField(changed[0]!, d)}</span>
                </>
              ) : (
                changed.map((f) => LABEL[f]).join(", ")
              )}
              {invalid && <span className="warn"> · Fix the highlighted fields to save</span>}
            </>
          }
        />
      )}

      <ConfirmModal open={confirmPause} onClose={() => setConfirmPause(false)} title="Pause trading?" confirmLabel="Pause trading" confirmIcon={CirclePause} variant="danger" loading={setPaused.isPending} loadingLabel="Pausing" onConfirm={doPause}>
        Hermes stops sending new orders from every strategy. Alerts still arrive and are logged as blocked. Open positions stay open.
      </ConfirmModal>
    </>
  );
}
