import {
  ArrowUp,
  Ban,
  CircleCheck,
  CircleDot,
  Copy,
  ShieldOff,
  ExternalLink,
  FileSearch,
  OctagonX,
  RotateCcw,
  SlidersHorizontal,
  ArrowUpRight,
} from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { AlertDetail } from "@hermes/shared";
import { PageHeader } from "../../components/shell/PageHeader";
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ChecksList,
  CodeBlock,
  EmptyState,
  ExplorerLink,
  KeyValue,
  KpiRow,
  KpiTile,
  LifecyclePipeline,
  Skeleton,
  StatusPill,
  Tag,
  Timeline,
  useCopy,
  useDelayedFlag,
  useToast,
  SideLabel,
  buttonClasses,
} from "../../components/ui";
import { alertOutcome, alertPipeline, alertSide, type SideKind } from "../../lib/alert-view";
import { errorMessage } from "../../lib/api";
import { cn } from "../../lib/cn";
import {
  SLIPPAGE_BETTER_TITLE,
  formatBlock,
  formatBps,
  formatClock,
  formatDate,
  formatLeverageX,
  formatMs,
  formatPrice,
  priceDecimals,
  formatSize,
  formatTimeZone,
  formatUsd,
  formatUtc,
  orNA,
  slippageTone,
} from "../../lib/format";
import { useAccount, useAlert, useLimits, useReport, useSendTestAlert, useSimulatedPerpl } from "../../lib/queries";
import { buildTimeline } from "./timeline";
import { narrativeFor } from "./narrative";
import { orderFrame, perplMessages } from "./frame";
import {
  PERPL_EXCHANGE,
  baseSize,
  maxSlippageOf,
  notionalOf,
  orderTypeText,
  parsedOf,
  payloadView,
  rawTicker,
  redactedPayload,
  riskChecks,
  sentMaxSlippage,
  slippageUsd,
  variantOf,
} from "./derive";
import "./alert.css";

const SIDE_WORD: Record<SideKind, string> = { long: "Long", short: "Short", "close-long": "Close long", "close-short": "Close short", close: "Close" };

export interface AlertDetailViewProps {
  id: string;
  /** `page` is the full `/alerts/:id` screen; `drawer` is the same content stacked in a single column for the Live drawer. */
  variant: "page" | "drawer";
  /** Called when a link inside the view navigates away (the drawer closes itself). */
  onNavigate?: () => void;
}

/** Alert detail: summary, price versus fill, timeline, risk checks, order frame, Perpl messages, fills and the raw payload. */
export function AlertDetailView({ id, variant, onNavigate }: AlertDetailViewProps) {
  const q = useAlert(id);
  const limits = useLimits();
  const account = useAccount();
  const skeleton = useDelayedFlag(q.isLoading);

  if (q.isError && !q.data) {
    const notFound = (q.error as { status?: number } | null)?.status === 404;
    return (
      <>
        {variant === "page" && <PageHeader title="Alert" crumbs={[{ label: "Live", to: "/live" }, { label: <span className="mono">{id}</span> }]} />}
        <Card>
          <EmptyState
            icon={FileSearch}
            tone={notFound ? undefined : "negative"}
            title={notFound ? "Alert not found" : "Could not load this alert"}
            actions={
              notFound ? (
                <Link className={buttonClasses({ size: "sm" })} to="/live">
                  Back to Live
                </Link>
              ) : (
                <Button size="sm" onClick={() => void q.refetch()}>
                  Retry
                </Button>
              )
            }
          >
            {notFound ? "This alert does not exist, or it belongs to another account." : "Hermes did not respond. The alert is still safe on the server."}
          </EmptyState>
        </Card>
      </>
    );
  }
  if (!q.data) {
    return (
      <>
        {variant === "page" && <PageHeader title="Alert" crumbs={[{ label: "Live", to: "/live" }, { label: <span className="mono">{id}</span> }]} subtitle={skeleton ? <Skeleton w={280} h={14} /> : undefined} />}
        {skeleton && <DetailSkeleton variant={variant} />}
      </>
    );
  }
  return <Loaded d={q.data} variant={variant} limits={limits.data} account={account.data} onNavigate={onNavigate} />;
}

type LoadedProps = { d: AlertDetail; variant: "page" | "drawer"; limits: ReturnType<typeof useLimits>["data"]; account: ReturnType<typeof useAccount>["data"]; onNavigate: (() => void) | undefined };

function Loaded({ d, variant, limits, account, onNavigate }: LoadedProps) {
  const toast = useToast();
  const { copy, copied } = useCopy();
  const replay = useSendTestAlert();
  const simulated = useSimulatedPerpl();
  const report = useReport(d.strategyId, "7d");

  const kind = variantOf(d);
  const out = alertOutcome(d);
  const checks = riskChecks(d);
  const tl = buildTimeline(d, checks);
  const pipe = alertPipeline(d);
  const narrative = narrativeFor(d, limits, checks);
  const frame = orderFrame(d);
  const messages = perplMessages(d);
  const p = parsedOf(d);
  // Alerts that stopped before Hermes parsed them have no market, side or size on the record. Read what the message
  // itself says and label it as unverified, instead of showing "Alert n/a" over a payload that says "short BTC".
  const unparsed = d.kind === null && d.side === null && d.market === null;
  const fromMessage = unparsed ? payloadView(d) : null;
  const side = fromMessage?.side ?? alertSide(d);
  const market = d.market ?? fromMessage?.market ?? null;
  const size = baseSize(d) ?? fromMessage?.size ?? null;
  const isDryRun = kind === "dry_run";
  const sentMs = sentMaxSlippage(frame);
  const order = d.orders[0];
  const filledNow = d.status === "filled" || d.status === "partially_filled";
  const fillTx = d.fills.find((f) => f.txHash)?.txHash ?? null;
  const t0 = d.events[0]?.atMs ?? d.receivedAt;
  const drawer = variant === "drawer";

  const doReplay = () => {
    const parsedAction = p.action;
    replay.mutate(
      { id: d.strategyId, ...(parsedAction ? { action: parsedAction } : {}), ...(d.market ? { market: d.market } : {}), ...(p.sizeUsd ? { sizeUsd: p.sizeUsd } : {}), ...(d.alertPrice ? { price: d.alertPrice } : {}) },
      {
        onSuccess: (r) => toast({ tone: "accent", title: r.duplicate ? "Test alert ignored" : "Test alert sent", body: `${d.strategyName ?? "Strategy"} · ${SIDE_WORD[side]} ${d.market ?? ""}. Watch it in the stream.`, ...(r.duplicate ? {} : { actions: [{ label: "Open Live", to: "/live" }] }) }),
        onError: (e) => toast.negative("Could not send the test alert", errorMessage(e), { actions: [{ label: "Try again", onClick: doReplay }] }),
      },
    );
  };

  const title = (
    <span className="row g3 wrap">
      <span className="row g2">
        {unparsed && !fromMessage?.side ? <span>Alert</span> : <SideLabel side={side} />}
        {market && <span>{market}</span>}
        {size !== null ? (
          <span className="mono w500" style={{ fontSize: 18 }}>
            {formatSize(size, market)}
          </span>
        ) : fromMessage?.sizeUsd != null ? (
          <span className="mono w500" style={{ fontSize: 18 }}>
            {formatUsd(fromMessage.sizeUsd, { decimals: 0 })}
          </span>
        ) : null}
      </span>
      <StatusPill kind={out.kind} />
    </span>
  );
  const subtitle = (
    <>
      {d.strategyName ?? "n/a"} · received <span className="mono" title={formatUtc(t0)}>{formatClock(t0)}</span> {formatTimeZone().split(" ")[0]}, {formatDate(t0)}
      {d.idempotencyKey?.startsWith("id:") && (
        <>
          {" "}· alert id <span className="mono">{d.idempotencyKey.slice(3)}</span>
        </>
      )}
    </>
  );
  const actions = (
    <>
      <Button variant="ghost" size="sm" icon={Copy} onClick={() => void copy(d.id)}>
        {copied ? "Copied" : "Copy ID"}
      </Button>
      {kind === "blocked" && narrative?.limit && (
        <Link className={buttonClasses({ size: "sm" })} to="/limits" onClick={onNavigate}>
          <SlidersHorizontal aria-hidden />
          Review limit
        </Link>
      )}
      {(kind === "trade" || isDryRun) && (
        <Button size="sm" icon={RotateCcw} loading={replay.isPending} loadingLabel="Sending" onClick={doReplay}>
          Replay as test alert
        </Button>
      )}
      {fillTx && !simulated && (
        <a className={buttonClasses({ size: "sm" })} href={`https://testnet.monadexplorer.com/tx/${fillTx}`} target="_blank" rel="noopener">
          <ExternalLink aria-hidden />
          Fill on explorer
        </a>
      )}
    </>
  );

  // --- KPI strip --------------------------------------------------------------------
  const slipTone = slippageTone(d.slippageBps, maxSlippageOf(d, limits, sentMs));
  const slipUsd = slippageUsd(d);
  const ticker = rawTicker(d);
  const notional = notionalOf(d) ?? fromMessage?.sizeUsd ?? null;
  const alertPrice = d.alertPrice ?? fromMessage?.price ?? null;
  const unverified = "From the message, not verified";
  const overBy = d.blockReason === "size_above_max" && notional !== null && limits ? Math.max(0, resultingOf(d, notional) - limits.maxPositionUsd) : null;
  const decisionMs = tl.totalMs;
  const kpiClass = drawer ? "alert-drawer-kpis" : undefined;

  const kpis =
    kind === "trade" ? (
      <KpiRow aria-label="Alert versus fill" className={kpiClass}>
        <KpiTile label="Alert price" mono value={formatPrice(d.alertPrice, d.market)} sub={ticker ? `From TradingView, ${ticker}` : "From TradingView"} />
        <KpiTile
          label="Fill price"
          mono
          value={filledNow ? formatPrice(d.avgFillPrice, d.market) : <span className="muted">{d.status === "failed" ? "Not filled" : d.status === "expired" ? "Not sent" : "Waiting"}</span>}
          sub={filledNow ? `Perpl ${d.market ?? ""}, ${d.fills.length} ${d.fills.length === 1 ? "fill" : "fills"}, ${order?.type === "limit" ? "limit" : "IOC"}` : d.status === "failed" ? "No fill, no fee" : d.status === "expired" ? "No order, no fee" : "Waiting for Perpl"}
        />
        <KpiTile
          label="Slippage"
          value={d.slippageBps === null ? <span className="faint">n/a</span> : formatBps(d.slippageBps).replace(" bps", "")}
          unit={d.slippageBps === null ? undefined : "bps"}
          tone={slipTone === "better" ? "positive" : slipTone === "warning" ? "warning" : undefined}
          sub={
            slipUsd === null ? (
              "Vs alert price"
            ) : (
              <span title={slipTone === "better" && d.slippageBps !== null ? SLIPPAGE_BETTER_TITLE(d.slippageBps) : undefined}>
                {slipUsd < 0 ? "Better" : "Worse"} than alert by <span className="d secondary">{formatUsd(Math.abs(slipUsd))}</span>
              </span>
            )
          }
        />
        <KpiTile
          label="Alert to fill"
          value={d.latencyMs === null ? <span className="faint">n/a</span> : Math.round(d.latencyMs)}
          unit={d.latencyMs === null ? undefined : "ms"}
          sub={
            report.data?.latency.medianMs != null ? (
              <>
                Strategy median <span className="d secondary">{formatMs(report.data.latency.medianMs)}</span>
              </>
            ) : d.latencyMs === null ? (
              "Not filled yet"
            ) : (
              "Received to first fill"
            )
          }
        />
      </KpiRow>
    ) : (
      <KpiRow aria-label="Alert summary" className={kpiClass}>
        <KpiTile
          label="Alert price"
          mono
          value={alertPrice === null ? <span className="faint">n/a</span> : formatPrice(alertPrice, market)}
          sub={fromMessage && alertPrice !== null ? unverified : ticker ? `From TradingView, ${ticker}` : "From TradingView"}
        />
        <KpiTile label="Fill price" mono value={<span className="muted">Not sent</span>} sub={isDryRun ? "Dry run, nothing sent" : "No order, no fee"} />
        <KpiTile
          label="Order notional"
          value={notional === null ? <span className="faint">n/a</span> : formatUsd(notional, { summary: true })}
          sub={
            overBy !== null && overBy > 0 ? (
              <span className="row warn" style={{ gap: 4 }}>
                <ArrowUp aria-hidden />
                <span className="d">{formatUsd(overBy, { decimals: 0 })}</span> over the limit
              </span>
            ) : fromMessage && notional !== null ? (
              unverified
            ) : (
              "Requested size"
            )
          }
        />
        <KpiTile
          label="Time to decision"
          value={decisionMs === null ? <span className="faint">n/a</span> : decisionMs < 1 ? "<1" : decisionMs >= 1000 ? (decisionMs / 1000).toFixed(2) : Math.round(decisionMs)}
          unit={decisionMs === null ? undefined : decisionMs >= 1000 ? "s" : "ms"}
          sub={kind === "blocked" ? "Received to blocked" : isDryRun ? "Received to dry run" : "Received to decision"}
        />
      </KpiRow>
    );

  // --- cards --------------------------------------------------------------------------
  const lifecycle = (
    <Card>
      <CardHeader
        title="Lifecycle"
        meta={
          isDryRun
            ? `3 of 6 stages · dry run${tl.totalMs !== null ? ` · ${formatMs(tl.totalMs)}` : ""}`
            : pipe.stoppedAt >= 0 && d.status !== "filled"
            ? `Stopped at stage ${pipe.stoppedAt + 1} of 6`
            : d.status === "filled" || d.status === "partially_filled"
              ? `6 of 6 stages${tl.totalMs !== null ? ` · ${formatMs(tl.totalMs)}` : ""}`
              : `${pipe.stages.filter((s) => s.state === "done" || s.state === "final").length} of 6 stages · in flight`
        }
      />
      <CardBody style={{ paddingBottom: 12 }}>
        <LifecyclePipeline stages={pipe.stages} size="lg" />
      </CardBody>
      <hr className="divider" />
      <Timeline items={tl.items} axisTotal={tl.axisTotal} axisMid={tl.axisMid} />
    </Card>
  );

  const m = checks.meta;
  const risk = (
    <Card>
      <CardHeader
        title="Risk checks"
        meta={
          m === "Not checked" ? (
            "Not checked"
          ) : (
            <>
              {m.failed > 0 && (
                <>
                  <span className="warn">{m.failed} failed</span> ·{" "}
                </>
              )}
              {m.passed} passed{m.skipped > 0 ? ` · ${m.skipped} not run` : ""}
            </>
          )
        }
      />
      {checks.notChecked ? (
        <EmptyState icon={ShieldOff} compact title="Not checked">
          {checks.notCheckedWhy}
        </EmptyState>
      ) : (
        <ChecksList items={checks.items} icons={{ pass: CircleCheck, fail: OctagonX, skip: CircleDot }} />
      )}
    </Card>
  );

  const onchain = (
    <Card>
      <CardHeader title="Onchain" meta="Monad testnet" />
      {kind !== "trade" || (!d.fills.length && !order) ? (
        <div className="empty" style={{ padding: "28px 20px" }}>
          <div className="empty-icon">
            <Ban aria-hidden />
          </div>
          <p>{kind === "blocked" || kind === "dropped" ? "No transaction. Blocked alerts never reach Perpl, so there is nothing onchain." : isDryRun ? "No transaction. Dry runs never reach Perpl, so there is nothing onchain." : "No transaction yet. A fill shows its transaction here."}</p>
        </div>
      ) : (
        <CardBody style={{ paddingTop: 4, paddingBottom: 4 }}>
          <KeyValue
            items={[
              ...d.fills.map((f, i): [ReactNode, ReactNode] => [d.fills.length > 1 ? `Fill tx ${i + 1}` : "Fill tx", f.txHash ? <ExplorerLink key={f.id} value={f.txHash} simulated={simulated} /> : <span className="faint">n/a</span>]),
              ...(d.fills.length && d.fills[d.fills.length - 1]?.block != null ? ([["Fill block", <span className="mono" key="fb">{formatBlock(d.fills[d.fills.length - 1]!.block)}</span>]] as [ReactNode, ReactNode][]) : []),
              ["Perpl order", <span className="mono" key="po">{order?.perplOrderId ? Number(order.perplOrderId).toLocaleString("en-US") : <span className="faint">n/a</span>}</span>],
              ["Request id (rq)", <span className="mono" key="rq">{order?.rq != null ? order.rq.toLocaleString("en-US") : <span className="faint">n/a</span>}</span>],
              ["Account", <span className="mono" key="ac">{account?.accountId ? `#${account.accountId}` : <span className="faint">n/a</span>}</span>],
              ["Exchange", <ExplorerLink key="ex" kind="address" value={PERPL_EXCHANGE} />],
            ]}
          />
        </CardBody>
      )}
    </Card>
  );

  const sentLimit = frame && typeof frame.fields.p === "number" ? frame.fields.p : null;
  const orderCard = kind === "trade" && order ? (
    <Card>
      <CardHeader title="Order" />
      <CardBody style={{ paddingTop: 4, paddingBottom: 4 }}>
        <KeyValue
          items={[
            ["Type", orderTypeText(order, d)],
            ["Size", <span className="mono" key="s">{orNA(order.size ?? size, (v) => formatSize(v, d.market))} {d.market}</span>],
            ["Notional", <span className="mono" key="n">{orNA(notional, (v) => formatUsd(v))}</span>],
            // The frame is the truth: `p: 0` means no limit price (a market order bounded by max slippage). Never show the fill price as a limit.
            ["Limit price", sentLimit === null ? <span className="faint" key="l">n/a</span> : sentLimit === 0 ? <span key="l">None, bounded by max slippage</span> : <span className="mono" key="l">{formatPrice(sentLimit / 10 ** priceDecimals(d.market), d.market)}</span>],
            ["Max slippage", <span className="mono" key="m">{orNA(maxSlippageOf(d, limits, sentMs), (v) => `${v} bps`)}</span>],
            ["Leverage", <span className="mono" key="lv">{orNA(order.leverage, (v) => formatLeverageX(v))}</span>],
          ]}
        />
      </CardBody>
    </Card>
  ) : null;

  const messagesCard = (kind === "trade" || kind === "dry_run") && messages.length > 0 ? <MessagesCard messages={messages} /> : null;

  const payload = <CodeBlock title="Raw payload" meta="from TradingView" code={redactedPayload(d.rawBody)} copyAriaLabel="Copy payload" />;
  const frameBlock = frame ? <CodeBlock title="Order frame sent" meta={`mt 22 · ${formatClock(frame.atMs)}`} code={frame.display} copyValue={frame.copy} copyAriaLabel="Copy order frame" /> : null;

  const callout = narrative ? (
    <Callout tone={narrative.tone} icon={narrative.tone === "warning" ? OctagonX : undefined}>
      {narrative.body}
    </Callout>
  ) : null;

  const header =
    variant === "page" ? (
      <PageHeader
        title={title}
        documentTitle={`Alert ${d.id}`}
        subtitle={subtitle}
        crumbs={[{ label: "Live", to: "/live" }, { label: <span className="mono">{d.id}</span> }]}
        actions={actions}
      />
    ) : (
      <div className="col g3">
        <h2 className="row g3 wrap" style={{ fontSize: 18, lineHeight: "24px", fontWeight: 600, letterSpacing: "-0.015em" }}>
          {title}
        </h2>
        <p className="page-sub" style={{ margin: 0 }}>{subtitle}</p>
        <div className="row g2 wrap">
          {actions}
          <Link className={buttonClasses({ size: "sm", variant: "ghost" })} to={`/alerts/${d.id}`} onClick={onNavigate}>
            <ArrowUpRight aria-hidden />
            Open full page
          </Link>
        </div>
      </div>
    );

  if (drawer) {
    return (
      <div className="alert-view col g4">
        {header}
        {callout}
        {kpis}
        {lifecycle}
        {risk}
        {messagesCard}
        {frameBlock}
        {payload}
        {orderCard}
        {onchain}
      </div>
    );
  }

  return (
    <div className="alert-view" style={{ display: "contents" }}>
      {header}
      {callout}
      {kpis}
      <div className="grid-12" style={{ alignItems: "start" }}>
        <div className="span-8 col g4">
          {lifecycle}
          {messagesCard}
          {frameBlock ? (
            <div className="grid-12" style={{ gap: 16 }}>
              <div className="span-6">{payload}</div>
              <div className="span-6">{frameBlock}</div>
            </div>
          ) : (
            payload
          )}
        </div>
        <div className="span-4 col g4">
          {risk}
          {onchain}
          {orderCard}
        </div>
      </div>
    </div>
  );
}

/** Position the order would have created (blocked by max size), read from the block detail text; falls back to the notional. */
function resultingOf(d: AlertDetail, notional: number): number {
  const t = d.events.find((e) => e.status === "blocked")?.detail?.detail;
  const m = typeof t === "string" ? /position ([\d.]+) USD/.exec(t) : null;
  return m ? Number(m[1]) : notional;
}

function MessagesCard({ messages }: { messages: ReturnType<typeof perplMessages> }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader title={<>Perpl messages <Tag mono>{messages.length}</Tag></>} meta="Trading socket, deduplicated" />
      <div className="table-wrap">
        <table className="t" aria-label="Perpl messages">
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Message</th>
              <th className="num hide-sm">Block</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((m) => (
              <Fragment key={m.key}>
                <tr data-msg-row onClick={() => setOpen(open === m.key ? null : m.key)} className="clickable">
                  <td className="mono secondary">{formatClock(m.at)}</td>
                  <td>
                    <button type="button" className="tag mono" style={{ cursor: "pointer", border: 0 }} aria-expanded={open === m.key} aria-label={`mt ${m.mt}, show raw message`}>
                      mt {m.mt}
                    </button>
                  </td>
                  <td className="wrap-cell">
                    {m.text} {m.muted && <span className="muted">· {m.muted}</span>}
                  </td>
                  <td className="num hide-sm">{m.block !== null ? formatBlock(m.block) : <span className="faint">n/a</span>}</td>
                </tr>
                {open === m.key && (
                  <tr className="msg-raw">
                    <td colSpan={4}>
                      <CodeBlock noCopy code={JSON.stringify(m.raw, null, 2)} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function DetailSkeleton({ variant }: { variant: "page" | "drawer" }) {
  const block = (h: number) => <Skeleton w="100%" h={h} r={8} />;
  return (
    <div className="col g4" aria-busy="true" aria-label="Loading">
      {block(110)}
      <div className={variant === "page" ? "grid-12" : "col g4"}>
        <div className={cn("col g4", variant === "page" && "span-8")}>{block(380)}{block(160)}</div>
        <div className={cn("col g4", variant === "page" && "span-4")}>{block(260)}{block(200)}</div>
      </div>
    </div>
  );
}
