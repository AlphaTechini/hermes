import { useMemo } from "react";
import { slippageBpsFor, type AlertRecord, type Fill, type Order, type Position } from "@hermes/shared";
import { alertSide } from "../../lib/alert-view";
import { cn } from "../../lib/cn";
import {
  SLIPPAGE_BETTER_TITLE,
  formatBps,
  formatLeverageX,
  formatPercent,
  formatPrice,
  formatSignedUsd,
  formatSize,
  formatTableTime,
  formatUsd,
  orNA,
  pnlTone,
  slippageTone,
} from "../../lib/format";
import { useAccount, useAlert, usePositions } from "../../lib/queries";
import { Badge, Button, Card, CardFooter, CardHeader, DataTable, EmptyState, ExplorerLink, MarketChip, SideLabel, Skeleton, TextLink, type Column } from "../../components/ui";
import { useFlash } from "./hooks";
import { CircleAlert, Layers } from "lucide-react";

/** A number that flashes green or red for 900 ms when it moves. */
function Flash({ value, children, className }: { value: number | null | undefined; children: React.ReactNode; className?: string }) {
  const flash = useFlash(value);
  return <span className={cn(flash, className)}>{children}</span>;
}

/** A figure in a card footer: an inline skeleton bar while the first read is in flight. */
function FootValue({ loading, children }: { loading: boolean; children: React.ReactNode }) {
  return loading ? <Skeleton w={40} h={12} style={{ display: "inline-block", verticalAlign: "middle" }} /> : <span className="mono secondary">{children}</span>;
}

export function PositionsCard({ orders, className }: { orders: Order[] | undefined; className?: string }) {
  const positions = usePositions();
  const account = useAccount();
  const list = positions.data ?? [];
  const posLoading = positions.isLoading;
  const posFailed = positions.isError && !positions.data;
  const upnl = list.reduce((a, p) => a + p.upnl, 0);

  // Position leverage is not on the position DTO: take it from the newest opening order for that market.
  const leverage = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of (orders ?? []).slice().sort((a, b) => b.createdAt - a.createdAt)) {
      if (o.kind === "open" && o.market && o.leverage && !m.has(o.market)) m.set(o.market, o.leverage);
    }
    return m;
  }, [orders]);

  const acc = account.data;
  const margin = acc ? (acc.marginUsedUsd ?? (acc.live ? Math.max(0, acc.equityUsd - acc.availableUsd) : null)) : null;
  const accLoading = account.isLoading;

  const columns: Column<Position>[] = [
    { key: "m", header: "Market", cell: (p) => <MarketChip market={p.market} /> },
    { key: "s", header: "Side", cell: (p) => <SideLabel side={p.side} /> },
    { key: "z", header: "Size", numeric: true, cell: (p) => formatSize(p.size, p.market) },
    { key: "n", header: "Notional", numeric: true, hideSm: true, cell: (p) => formatUsd(p.notionalUsd) },
    { key: "e", header: "Entry", numeric: true, hideSm: true, cell: (p) => formatPrice(p.entryPrice, p.market) },
    { key: "k", header: "Mark", numeric: true, hideSm: true, cell: (p) => <Flash value={p.markPrice}>{formatPrice(p.markPrice, p.market)}</Flash> },
    {
      key: "u",
      header: "Unrealized PnL",
      numeric: true,
      cell: (p) => {
        const basis = p.size * p.entryPrice;
        const pct = basis > 0 ? (p.upnl / basis) * 100 : null;
        const tone = pnlTone(p.upnl);
        return (
          <Flash value={p.upnl} className={cn(tone === "positive" && "pos", tone === "negative" && "neg")}>
            {formatSignedUsd(p.upnl)} <span className="muted hide-sm">{formatPercent(pct, { signed: true, decimals: 2 })}</span>
          </Flash>
        );
      },
    },
    { key: "l", header: "Lev.", numeric: true, hideSm: true, cell: (p) => orNA(leverage.get(p.market), (v) => formatLeverageX(v, { decimals: 1 })) },
  ];

  const tone = pnlTone(upnl);
  return (
    <Card className={className}>
      <CardHeader
        title={
          <>
            Open positions {!posLoading && !posFailed && <Badge mono>{list.length}</Badge>}
          </>
        }
        meta={
          !posLoading && !posFailed && list.length > 0 && (
            <>
              Unrealized <span className={cn("mono", tone === "positive" && "pos", tone === "negative" && "neg")}>{formatSignedUsd(upnl)}</span>
            </>
          )
        }
      />
      <DataTable
        aria-label="Open positions"
        columns={columns}
        rows={list}
        rowKey={(p) => `${p.market}:${p.side}`}
        loading={posLoading}
        skeletonRows={3}
        error={
          posFailed ? (
            <EmptyState icon={CircleAlert} tone="negative" compact title="Could not load positions" actions={<Button size="sm" variant="secondary" onClick={() => void positions.refetch()}>Retry</Button>}>
              Hermes did not respond. Your positions on Perpl are not affected.
            </EmptyState>
          ) : undefined
        }
        empty={
          <EmptyState icon={Layers} compact title="No open positions">
            Positions opened by your alerts show here.
          </EmptyState>
        }
      />
      <CardFooter>
        <span>
          Margin used <FootValue loading={accLoading}>{orNA(margin, (v) => formatUsd(v))}</FootValue> of <FootValue loading={accLoading}>{orNA(acc?.equityUsd, (v) => formatUsd(v))}</FootValue> equity
        </span>
        {accLoading ? <Skeleton w={96} h={12} /> : <span className="mono">{acc?.accountId ? `Perpl account #${acc.accountId}` : "Perpl account n/a"}</span>}
      </CardFooter>
    </Card>
  );
}

/**
 * Slippage of one fill against the price of the alert that caused it. The alert normally comes from the list already
 * loaded on the page; when it is not there (the list failed, or the alert is older than it) it is read on its own, so
 * this column does not depend on the alerts list.
 */
function FillSlippage({ fill: f, alert, lookup }: { fill: Fill; alert: AlertRecord | undefined; lookup: boolean }) {
  const own = useAlert(alert || !lookup || !f.alertId ? undefined : f.alertId);
  const a = alert ?? own.data;
  const raw = a?.alertPrice && f.side && f.kind ? slippageBpsFor(a.alertPrice, f.price, f.side, f.kind) : (a?.slippageBps ?? null);
  const bps = raw !== null && Number.isFinite(raw) ? raw : null;
  if (bps === null) return own.isLoading ? <Skeleton w={40} h={12} style={{ marginLeft: "auto" }} /> : <span className="faint">n/a</span>;
  const t = slippageTone(bps);
  return (
    <span className={cn(t === "better" && "pos", t === "warning" && "warn")} title={t === "better" ? SLIPPAGE_BETTER_TITLE(bps) : undefined}>
      {formatBps(bps)}
    </span>
  );
}

export function FillsCard({
  fills,
  alerts,
  alertsSettled,
  failed,
  onRetry,
  className,
}: {
  fills: Fill[] | undefined;
  alerts: AlertRecord[] | undefined;
  /** The alerts list finished (loaded or failed): fills whose alert is not in it may look it up on their own. */
  alertsSettled: boolean;
  failed?: boolean;
  onRetry?: () => void;
  className?: string;
}) {
  const byAlert = useMemo(() => new Map((alerts ?? []).map((a) => [a.id, a])), [alerts]);
  const rows = (fills ?? []).slice(0, 5);

  const columns: Column<Fill>[] = [
    {
      key: "f",
      header: "Fill",
      cell: (f) => {
        const a = f.alertId ? byAlert.get(f.alertId) : undefined;
        const side = f.kind === "close" ? "close" : (f.side ?? (a ? alertSide(a) : "long"));
        const sizeText = formatSize(f.size, f.market);
        return (
          <span className="row g2">
            {f.market && <MarketChip market={f.market} />}
            <span className="col">
              {side === "close" ? (
                <SideLabel side="close" size="xs">{`Close ${sizeText}`}</SideLabel>
              ) : (
                <SideLabel side={side} size="xs">{`${side === "long" ? "Long" : "Short"} ${sizeText}`}</SideLabel>
              )}
              <span className="mono xxs muted">{formatTableTime(f.atMs)}</span>
            </span>
          </span>
        );
      },
    },
    { key: "p", header: "Price", numeric: true, cell: (f) => formatPrice(f.price, f.market) },
    { key: "sl", header: "Slippage", numeric: true, cell: (f) => <FillSlippage fill={f} alert={f.alertId ? byAlert.get(f.alertId) : undefined} lookup={alertsSettled} /> },
    { key: "t", header: "Tx", numeric: true, hideSm: true, cell: (f) => (f.txHash ? <ExplorerLink value={f.txHash} /> : <span className="faint">n/a</span>) },
  ];

  return (
    <Card className={className}>
      <CardHeader title="Recent fills" actions={<TextLink className="xs" to="/report">Report card</TextLink>} />
      <DataTable
        aria-label="Recent fills"
        density="two-line"
        columns={columns}
        rows={rows}
        rowKey={(f) => f.id}
        loading={fills === undefined && !failed}
        skeletonRows={4}
        error={
          failed && fills === undefined ? (
            <EmptyState icon={CircleAlert} tone="negative" compact title="Could not load fills" actions={onRetry ? <Button size="sm" variant="secondary" onClick={onRetry}>Retry</Button> : undefined}>
              Hermes did not respond. Your fills on Perpl are not affected.
            </EmptyState>
          ) : undefined
        }
        empty={
          <EmptyState icon={Layers} compact title="No fills yet">
            Fills from your alerts show here with a link to the transaction.
          </EmptyState>
        }
      />
    </Card>
  );
}
