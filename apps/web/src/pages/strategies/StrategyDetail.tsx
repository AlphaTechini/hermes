import { CircleCheck, CircleX, Ellipsis, FlaskConical, Hourglass, Send, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MARKET_SYMBOLS, type AlertRecord, type StrategyDTO } from "@hermes/shared";
import { alertOutcome, alertSide } from "../../lib/alert-view";
import { errorMessage } from "../../lib/api";
import { formatBps, formatClock, formatDate, formatFraction, formatMs, formatTableTime, orNA } from "../../lib/format";
import { useAlert, useAlerts, useDeleteStrategy, useLimits, useReport, useSendTestAlert, useStrategy, useToggleStrategy, useUpdateStrategy } from "../../lib/queries";
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  ConfirmModal,
  DataTable,
  EmptyState,
  IconButton,
  Input,
  KpiRow,
  KpiTile,
  MarketChip,
  NumberInput,
  Popover,
  SegmentedControl,
  Select,
  SideLabel,
  Skeleton,
  StatusPill,
  Tag,
  Toggle,
  useDelayedFlag,
  useToast,
} from "../../components/ui";
import { ConnectBody } from "./ConnectBody";

const VALUE_SM = { fontSize: 20, lineHeight: "28px" } as const;

export function StrategyDetail({ id, marketAllowed }: { id: string; marketAllowed: (m: string | null) => boolean }) {
  const q = useStrategy(id);
  const slow = useDelayedFlag(q.isLoading);
  if (q.isLoading) return slow ? <DetailSkeleton /> : null;
  if (!q.data) {
    return (
      <Card>
        <EmptyState icon={CircleX} tone="negative" title="Could not load this strategy" actions={<Button onClick={() => void q.refetch()}>Retry</Button>}>
          Hermes did not respond. Your strategies are safe on the server.
        </EmptyState>
      </Card>
    );
  }
  return <Loaded key={q.data.id} s={q.data} marketAllowed={marketAllowed} />;
}

function DetailSkeleton() {
  return (
    <div className="col g4" style={{ minWidth: 0 }} aria-busy="true" aria-label="Loading strategy">
      <Card>
        <CardBody className="col g2">
          <Skeleton w={180} h={20} />
          <Skeleton w={260} h={12} />
        </CardBody>
        <KpiRow style={{ border: 0, borderTop: "1px solid var(--border-subtle)", borderRadius: "0 0 8px 8px" }}>
          {[0, 1, 2, 3].map((i) => (
            <KpiTile key={i} label="" loading skeleton={[72, 64, 0]} />
          ))}
        </KpiRow>
      </Card>
      <Card>
        <CardHeader title="Connect TradingView" />
        <CardBody className="col g4">
          <Skeleton h={32} />
          <Skeleton h={32} />
          <Skeleton h={160} />
        </CardBody>
      </Card>
    </div>
  );
}

function Loaded({ s, marketAllowed }: { s: StrategyDTO; marketAllowed: (m: string | null) => boolean }) {
  const toast = useToast();
  const navigate = useNavigate();
  const toggle = useToggleStrategy();
  const del = useDeleteStrategy();
  const send = useSendTestAlert();
  const report = useReport(s.id, "7d");
  const [menu, setMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lastTest, setLastTest] = useState<{ alertId: string; at: number } | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const r = report.data;
  const allowed = marketAllowed(s.defaultMarket);

  const sendTest = () => {
    const market = s.defaultMarket ?? "BTC";
    send.mutate(
      { id: s.id, action: "buy", market, sizeUsd: 100, marketPosition: "long" },
      {
        onSuccess: (res) => {
          setLastTest({ alertId: res.alertId, at: Date.now() });
          toast.accent("Test alert sent", `Long ${market} $100 posted to your webhook. Watch it on Live.`, { actions: [{ label: "Watch on Live", to: "/live" }], icon: Send });
        },
        onError: (e) => toast.negative("Could not send the test alert", errorMessage(e)),
      },
    );
  };

  const doDelete = () =>
    del.mutate(s.id, {
      onSuccess: () => {
        setConfirmDelete(false);
        toast.positive("Strategy deleted", `${s.name} no longer accepts alerts.`);
        navigate("/strategies", { replace: true });
      },
      onError: (e) => toast.negative("Could not delete the strategy", errorMessage(e)),
    });

  return (
    <div className="col g4" style={{ minWidth: 0 }}>
      <Card>
        <div className="card-body row between wrap g4">
          <div className="col g1" style={{ minWidth: 0 }}>
            <div className="row g3 wrap">
              <h2 style={{ fontSize: 16, lineHeight: "24px" }}>{s.name}</h2>
              {s.defaultMarket && <MarketChip market={s.defaultMarket} disabled={!allowed} />}
              <Tag mono title={s.id}>
                {s.id}
              </Tag>
              {s.dryRun && (
                <StatusPill tone="accent" icon={FlaskConical} title="Alerts run every check and stop there. Nothing is sent to Perpl.">
                  Dry run
                </StatusPill>
              )}
            </div>
            <span className="xs muted">
              Created {formatDate(s.createdAt)} · <span className="mono">{r ? r.counts.total : "n/a"}</span> alerts in the last 7 days
            </span>
            {!allowed && s.defaultMarket && (
              <span className="xs warn row g1" style={{ marginTop: 4 }}>
                <TriangleAlert className="i-12" aria-hidden />
                {s.defaultMarket} is not in your allowed markets.{" "}
                <Link className="link" to="/limits">
                  Change limits
                </Link>
              </span>
            )}
          </div>
          <div className="row g2">
            <Toggle
              label="Enabled"
              labelSide="left"
              checked={s.enabled}
              onCheckedChange={(enabled) => toggle.mutate({ id: s.id, enabled }, { onError: (e) => toast.negative("Could not change the strategy", errorMessage(e)) })}
            />
            <span className="vdiv" />
            <Button size="sm" icon={Send} loading={send.isPending} loadingLabel="Sending" onClick={sendTest}>
              Send test alert
            </Button>
            <IconButton ref={moreRef} size="sm" icon={Ellipsis} label="More" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu} />
            <Popover open={menu} onClose={() => setMenu(false)} anchorRef={moreRef} placement="bottom-end" role="menu">
              <button
                className="menu-item"
                role="menuitem"
                style={{ width: "100%", color: "var(--negative-text)" }}
                onClick={() => {
                  setMenu(false);
                  setConfirmDelete(true);
                }}
              >
                <Trash2 aria-hidden />
                Delete strategy
              </button>
            </Popover>
          </div>
        </div>
        {s.dryRun && (
          <div style={{ padding: "0 16px 16px" }}>
            <Callout tone="accent" icon={FlaskConical}>
              <b>Dry run is on.</b> Alerts run every check and stop there. Nothing is sent to Perpl, so there are no fills and no grade.
            </Callout>
          </div>
        )}
        <hr className="divider" />
        <KpiRow style={{ border: 0, borderRadius: "0 0 8px 8px" }}>
          <KpiTile size="sm" label="Fill rate, 7d" loading={report.isLoading} skeleton={[72, 56, 0]} value={r?.fillRate != null ? formatFraction(r.fillRate).replace("%", "") : "n/a"} unit={r?.fillRate != null ? "%" : undefined} />
          <KpiTile size="sm" label="Median alert to fill" loading={report.isLoading} skeleton={[96, 56, 0]} value={r?.latency.medianMs != null ? formatMs(r.latency.medianMs).replace(/ (ms|s)$/, "") : "n/a"} unit={r?.latency.medianMs != null ? (r.latency.medianMs >= 1000 ? "s" : "ms") : undefined} />
          <KpiTile size="sm" label="Median slippage" loading={report.isLoading} skeleton={[96, 56, 0]} value={r?.slippage.medianBps != null ? formatBps(r.slippage.medianBps).replace(" bps", "") : "n/a"} unit={r?.slippage.medianBps != null ? "bps" : undefined} />
          <KpiTile
            size="sm"
            label="Grade"
            loading={report.isLoading}
            skeleton={[48, 56, 0]}
            value={
              <span className="row g2" style={VALUE_SM}>
                {r?.grade ?? "n/a"}{" "}
                <Link className="link xs w500" to={`/report/${s.id}`} style={{ letterSpacing: 0 }}>
                  Report card
                </Link>
              </span>
            }
          />
        </KpiRow>
      </Card>

      <Card>
        <CardHeader title="Connect TradingView" meta="3 fields to paste into your alert" />
        <CardBody>
          <ConnectBody strategy={s} />
        </CardBody>
        <CardFooter className="row between wrap g2">
          <LastTest lastTest={lastTest} />
          <DryRunToggle s={s} />
        </CardFooter>
      </Card>

      <Defaults s={s} />

      <RecentAlerts strategyId={s.id} />

      <ConfirmModal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete strategy?" confirmLabel="Delete strategy" confirmIcon={Trash2} variant="danger" loading={del.isPending} loadingLabel="Deleting" onConfirm={doDelete}>
        {s.name} stops accepting alerts. TradingView alerts that still post to its webhook URL will fail. This cannot be undone.
      </ConfirmModal>
    </div>
  );
}

// --- last test ------------------------------------------------------------------------

function LastTest({ lastTest }: { lastTest: { alertId: string; at: number } | null }) {
  const alert = useAlert(lastTest?.alertId);
  if (!lastTest) return <span className="muted">No test sent yet. Send one to watch it go through every check.</span>;
  const a = alert.data;
  if (a?.status === "dry_run") {
    return (
      <span className="row g2 wrap">
        <FlaskConical className="i-14 acc" aria-hidden />
        Last test <span className="mono secondary">{formatClock(lastTest.at, { ms: false })}</span>
        <span>passed every check, not sent (dry run)</span>
        <span>·</span>
        <Link className="link mono" to={`/alerts/${lastTest.alertId}`}>
          {lastTest.alertId}
        </Link>
      </span>
    );
  }
  const out = a ? alertOutcome(a) : null;
  const ok = out?.kind === "filled" || out?.kind === "partly_filled";
  const Icon = !out || out.kind === "in_flight" ? Hourglass : ok ? CircleCheck : out.kind === "blocked" ? TriangleAlert : CircleX;
  const tone = ok ? "pos" : out?.kind === "blocked" ? "warn" : out && out.kind !== "in_flight" ? "neg" : "muted";
  return (
    <span className="row g2 wrap">
      <Icon className={`i-14 ${tone}`} aria-hidden />
      Last test <span className="mono secondary">{formatClock(lastTest.at, { ms: false })}</span>
      {out ? (
        out.kind === "in_flight" ? (
          <span>in flight</span>
        ) : ok && a ? (
          <>
            filled in <span className="mono secondary">{formatMs(a.latencyMs)}</span>
          </>
        ) : (
          <span>
            {out.label.toLowerCase()}
            {out.why ? `: ${out.why}` : ""}
          </span>
        )
      ) : (
        <span>sent</span>
      )}
      <span>·</span>
      <Link className="link mono" to={`/alerts/${lastTest.alertId}`}>
        {lastTest.alertId}
      </Link>
    </span>
  );
}

// --- dry run --------------------------------------------------------------------------

/** Dry run is saved the moment it changes: turning it off starts real orders, so that direction asks first. */
function DryRunToggle({ s }: { s: StrategyDTO }) {
  const toast = useToast();
  const update = useUpdateStrategy(s.id);
  const [confirmOff, setConfirmOff] = useState(false);
  const set = (dryRun: boolean) =>
    update.mutate(
      { dryRun },
      {
        onSuccess: () => {
          setConfirmOff(false);
          if (dryRun) toast.accent("Dry run is on", "Alerts run every check and stop there. Nothing is sent to Perpl.", { icon: FlaskConical });
          else toast.positive("Dry run is off", "Alerts from this strategy send real orders to Perpl.");
        },
        onError: (e) => toast.negative("Could not change dry run", errorMessage(e)),
      },
    );
  return (
    <>
      <Toggle label="Dry run: checks run, nothing is sent to Perpl" labelSide="left" checked={s.dryRun} disabled={update.isPending} onCheckedChange={(on) => (on ? set(true) : setConfirmOff(true))} />
      <ConfirmModal open={confirmOff} onClose={() => setConfirmOff(false)} title="Turn off dry run?" confirmLabel="Turn off dry run" variant="danger" loading={update.isPending} loadingLabel="Saving" onConfirm={() => set(false)}>
        From the next alert, {s.name} sends real orders to Perpl. Alerts that pass every limit can fill.
      </ConfirmModal>
    </>
  );
}

// --- order settings -------------------------------------------------------------------

interface Draft {
  name: string;
  market: string;
  sizeUsd: number | null;
  leverage: number | null;
  /** null = use the account default from Risk limits. */
  maxSlippageBps: number | null;
}
const draftOf = (s: StrategyDTO): Draft => ({ name: s.name, market: s.defaultMarket ?? "none", sizeUsd: s.defaultSizeUsd, leverage: s.defaultLeverage, maxSlippageBps: s.maxSlippageBps });
const ORDER_TYPE_LABEL: Record<StrategyDTO["orderType"], string> = { market: "Market, immediate or cancel" };

function Defaults({ s }: { s: StrategyDTO }) {
  const toast = useToast();
  const update = useUpdateStrategy(s.id);
  const limits = useLimits();
  const saved = useMemo(() => draftOf(s), [s]);
  const [d, setD] = useState<Draft>(saved);
  const [sizeMode, setSizeMode] = useState<"alert" | "fixed">(s.defaultSizeUsd ? "fixed" : "alert");
  useEffect(() => {
    setD(saved);
    setSizeMode(saved.sizeUsd ? "fixed" : "alert");
  }, [saved]);

  const dirty = d.name.trim() !== saved.name || d.market !== saved.market || (sizeMode === "alert" ? null : d.sizeUsd) !== saved.sizeUsd || d.leverage !== saved.leverage || d.maxSlippageBps !== saved.maxSlippageBps;
  const maxLev = limits.data?.maxLeverage;
  const errors = {
    name: d.name.trim() ? undefined : "Give the strategy a name.",
    size: sizeMode === "fixed" && (d.sizeUsd === null || d.sizeUsd <= 0) ? "Enter a size above $0, or use the size from the alert." : undefined,
    leverage: d.leverage !== null && d.leverage <= 0 ? "Leverage must be above 0x." : undefined,
    slippage: d.maxSlippageBps !== null && (!Number.isInteger(d.maxSlippageBps) || d.maxSlippageBps < 0 || d.maxSlippageBps > 10_000) ? "Use a whole number of bps from 0 to 10,000." : undefined,
  };
  const invalid = Boolean(errors.name || errors.size || errors.leverage || errors.slippage);
  const defaultSlip = limits.data?.defaultSlippageBps;
  const effectiveSlip = d.maxSlippageBps ?? defaultSlip;

  const save = () =>
    update.mutate(
      {
        name: d.name.trim(),
        defaultMarket: d.market === "none" ? null : d.market,
        defaultSizeUsd: sizeMode === "alert" ? null : d.sizeUsd,
        defaultLeverage: d.leverage,
        maxSlippageBps: d.maxSlippageBps,
      },
      {
        onSuccess: () => toast.positive("Settings saved", "They apply from the next alert."),
        onError: (e) => toast.negative("Could not save settings", errorMessage(e), { actions: [{ label: "Try again", onClick: save }] }),
      },
    );

  return (
    <Card>
      <CardHeader
        title="Order settings"
        meta="Applied to every alert from this strategy"
        actions={
          <Button variant={dirty ? "primary" : "ghost"} size="sm" disabled={!dirty || invalid} loading={update.isPending} loadingLabel="Saving" onClick={save}>
            Save
          </Button>
        }
      />
      <CardBody className="form-grid">
        <Input label="Name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} error={errors.name} maxLength={80} />
        <Select
          label="Default market"
          value={d.market}
          onChange={(market) => setD({ ...d, market })}
          options={[{ value: "none", label: "From the alert" }, ...MARKET_SYMBOLS.map((m) => ({ value: m as string, label: m, market: m }))]}
          hint="Used when the message has no market."
        />
        <Input
          label="Order type"
          value={ORDER_TYPE_LABEL[s.orderType] ?? "Market, immediate or cancel"}
          readOnly
          aria-readonly="true"
          boxClassName="is-disabled"
          hint="Fills now within your slippage limit and cancels the rest. Market is the only type for now."
        />
        <NumberInput
          label="Max slippage"
          unit="bps"
          value={d.maxSlippageBps}
          onValueChange={(maxSlippageBps) => setD({ ...d, maxSlippageBps })}
          min={0}
          max={10_000}
          decimals={0}
          placeholder={defaultSlip === undefined ? "Default" : String(defaultSlip)}
          boxClassName="[&_input::placeholder]:font-sans"
          error={errors.slippage}
          hint={
            errors.slippage ? undefined : (
              <>
                {effectiveSlip === undefined ? "Worst price is the alert price plus the limit for buys, minus for sells." : `Worst price = alert price + ${effectiveSlip} bps for buys, minus for sells.`}
                {d.maxSlippageBps === null && (
                  <>
                    {" "}
                    Empty uses the default from{" "}
                    <Link className="link" to="/limits">
                      Risk limits
                    </Link>
                    .
                  </>
                )}
              </>
            )
          }
        />
        <div className="field">
          <span className="label">Size</span>
          <SegmentedControl
            aria-label="Size mode"
            value={sizeMode}
            onChange={(m) => {
              setSizeMode(m);
              if (m === "fixed" && d.sizeUsd === null) setD({ ...d, sizeUsd: 100 });
            }}
            options={[
              { value: "alert", label: "From alert" },
              { value: "fixed", label: "Fixed USD" },
            ]}
          />
          {sizeMode === "fixed" ? (
            <NumberInput aria-label="Fixed size in USD" prefix="$" unit="per order" value={d.sizeUsd} onValueChange={(sizeUsd) => setD({ ...d, sizeUsd })} min={0} error={errors.size} hint={errors.size ? undefined : "Used when the alert has no size."} />
          ) : (
            <span className="hint">
              Uses <span className="mono">size</span> from the message{d.market !== "none" ? `, in ${d.market}` : ""}.
            </span>
          )}
        </div>
        <NumberInput
          label="Leverage if the alert has none"
          unit="x"
          value={d.leverage}
          onValueChange={(leverage) => setD({ ...d, leverage })}
          min={0}
          decimals={undefined}
          error={errors.leverage}
          hint={errors.leverage ? undefined : maxLev ? `Your risk limit caps this at ${maxLev}x.` : "Your risk limit caps this."}
        />
      </CardBody>
    </Card>
  );
}

// --- recent alerts --------------------------------------------------------------------

function RecentAlerts({ strategyId }: { strategyId: string }) {
  const q = useAlerts({ strategyId, limit: 8 });
  const rows = q.data?.items ?? [];
  const slow = useDelayedFlag(q.isLoading);
  return (
    <Card>
      <CardHeader
        title="Recent alerts"
        meta="From this strategy"
        actions={
          <Link className="btn btn-ghost btn-sm" to="/live">
            Open Live
          </Link>
        }
      />
      {q.isError ? (
        <EmptyState compact icon={CircleX} tone="negative" title="Could not load alerts" actions={<Button size="sm" onClick={() => void q.refetch()}>Retry</Button>}>
          Hermes did not respond. Alerts are still being processed on the server.
        </EmptyState>
      ) : (
        <DataTable<AlertRecord>
          aria-label="Recent alerts for this strategy"
          rows={rows}
          loading={q.isLoading && slow}
          rowKey={(a) => a.id}
          rowHref={(a) => `/alerts/${a.id}`}
          empty={
            q.isLoading ? undefined : (
              <EmptyState compact icon={Send} title="No alerts yet">
                Send a test alert, or wait for TradingView to post to the webhook.
              </EmptyState>
            )
          }
          columns={[
            { key: "t", header: "Time", mono: true, cell: (a) => <span className="secondary">{formatTableTime(a.receivedAt)}</span> },
            { key: "a", header: "Alert", cell: (a) => <span className="row g2"><SideLabel side={alertSide(a)} size="xs" />{a.market && <MarketChip market={a.market} />}</span> },
            { key: "s", header: "Outcome", cell: (a) => <StatusPill kind={alertOutcome(a).kind} /> },
            { key: "l", header: "Alert to fill", numeric: true, hideSm: true, cell: (a) => orNA(a.latencyMs, formatMs) },
            { key: "p", header: "Slippage", numeric: true, hideSm: true, cell: (a) => orNA(a.slippageBps, (v) => formatBps(v)) },
          ]}
        />
      )}
    </Card>
  );
}
