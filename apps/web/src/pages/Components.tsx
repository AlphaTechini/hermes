import {
  ArrowDown,
  CirclePause,
  CircleCheck,
  CircleX,
  Copy,
  Inbox,
  OctagonX,
  Radio,
  RefreshCw,
  Send,
  ShieldCheck,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { useMemo, useState } from "react";
import { PageHeader } from "../components/shell/PageHeader";
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  ChartLegend,
  ChecksList,
  Checkbox,
  CodeBlock,
  ConfirmModal,
  ConnectionPill,
  CopyField,
  Countdown,
  DataTable,
  Drawer,
  EmptyState,
  ExplorerLink,
  GradeBadge,
  GradeScale,
  Histogram,
  IconButton,
  Input,
  KeyValue,
  KpiDelta,
  KpiRow,
  KpiTile,
  LifecyclePipeline,
  LineChart,
  MarketChip,
  MarketTile,
  Meter,
  Modal,
  NumberInput,
  PipelineDots,
  SaveBar,
  SegmentedControl,
  Select,
  SideLabel,
  Skeleton,
  SkeletonRows,
  Sparkline,
  Spinner,
  StatusPill,
  Stepper,
  Tabs,
  Textarea,
  Timeline,
  ToastView,
  Toggle,
  Tooltip,
  useToast,
  type Column,
} from "../components/ui";
import { alertOutcome, alertPipeline } from "../lib/alert-view";
import { PAGE, ONBOARDING_STEPS } from "../lib/routes";
import { formatBps, formatPrice, formatSignedUsd, formatSize, formatUsd, shortHex } from "../lib/format";
import type { AlertRecord, AlertStatus } from "@hermes/shared";

interface PosRow {
  market: string;
  side: "long" | "short";
  size: number;
  notional: number;
  entry: number;
  mark: number;
  upnl: number;
}
const POS: PosRow[] = [
  { market: "BTC", side: "long", size: 0.07, notional: 7843.59, entry: 111998.2, mark: 112051.3, upnl: 3.72 },
  { market: "ETH", side: "short", size: 1.2, notional: 4924.92, entry: 4098.62, mark: 4104.1, upnl: -6.58 },
  { market: "MON", side: "long", size: 150000, notional: 6039.75, entry: 0.040118, mark: 0.040265, upnl: 22.05 },
];

const TEMPLATE = `{
  "strategy": "stg_8Kq2Zr",
  "secret": "••••••••••••hx2K",
  "id": "{{strategy.order.id}}-{{timenow}}",
  "market": "BTC",
  "action": "{{strategy.order.action}}",
  "size": "{{strategy.order.contracts}}",
  "price": "{{close}}",
  "leverage": 5,
  "time": "{{timenow}}"
}`;
const FRAME = `{
  "mt": 22,            // OrderRequest
  "sn": 88412,
  "rq": 1904233,
  "t": 1,              // OpenLong
  "tif": 3,            // ImmediateOrCancel
  "lv": 500,           // 5.00x
  "ok": true,
  "px": null
}`;

const MED = [512, 498, 470, 455, 530, 505, 488, 472, 461, 520, 610, 540, 495, 480, 470, 466, 489, 502, 476, 459, 463, 491, 478, 470, 452, 468, 481, 486];
const P95 = [880, 842, 801, 790, 930, 905, 860, 820, 812, 890, 1420, 980, 870, 850, 820, 815, 860, 880, 835, 810, 812, 862, 840, 826, 798, 820, 851, 871];
const HIST = [6, 9, 12, 16, 19, 18, 14, 11, 9, 7, 5, 4, 3, 2];
const BIN_LABELS = ["<0", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12+"];

const FAKE_ALERT: AlertRecord = {
  id: "A-10482",
  strategyId: "stg_8Kq2Zr",
  strategyName: "Breakout 15m",
  idempotencyKey: null,
  status: "filled",
  blockReason: null,
  errorCode: null,
  market: "BTC",
  side: "long",
  kind: "open",
  sizeUsd: 5602,
  alertPrice: 112031,
  receivedAt: 0,
  createdAt: 0,
  latencyMs: 612,
  avgFillPrice: 112048.5,
  slippageBps: 1.6,
  events: [
    { id: 1, alertId: "A-10482", status: "received", atMs: 1000, detail: null },
    { id: 2, alertId: "A-10482", status: "verified", atMs: 1004, detail: null },
    { id: 3, alertId: "A-10482", status: "risk_checked", atMs: 1006, detail: null },
    { id: 4, alertId: "A-10482", status: "sent", atMs: 1017, detail: null },
    { id: 5, alertId: "A-10482", status: "accepted", atMs: 1201, detail: null },
    { id: 6, alertId: "A-10482", status: "filled", atMs: 1612, detail: null },
  ],
};

/** A fixture alert whose events end at the given statuses. Pipelines below are computed from these with `alertPipeline()`, as the app does. */
function fixture(status: AlertStatus, steps: [AlertStatus, number][], extra: Partial<AlertRecord> = {}): AlertRecord {
  return {
    ...FAKE_ALERT,
    id: `A-${status}`,
    status,
    latencyMs: null,
    avgFillPrice: null,
    slippageBps: null,
    events: steps.map(([st, atMs], i) => ({ id: i + 1, alertId: `A-${status}`, status: st, atMs: 1000 + atMs, detail: null })),
    ...extra,
  };
}

const PIPES: [string, AlertRecord][] = [
  ["In flight", fixture("sent", [["received", 0], ["verified", 3], ["risk_checked", 5], ["sent", 17]])],
  ["Needs approval", fixture("pending_approval", [["received", 0], ["verified", 4], ["risk_checked", 6], ["pending_approval", 8]])],
  ["Filled", FAKE_ALERT],
  ["Blocked at checks", fixture("blocked", [["received", 0], ["verified", 4], ["blocked", 5]], { blockReason: "size_above_max" })],
  ["Not filled", fixture("failed", [["received", 0], ["verified", 4], ["risk_checked", 6], ["sent", 16], ["accepted", 192], ["failed", 494]], { errorCode: "timeout" })],
  ["Rejected by Perpl", fixture("failed", [["received", 0], ["verified", 4], ["risk_checked", 6], ["sent", 17], ["failed", 84]], { errorCode: "order_rejected" })],
  ["Ignored", fixture("duplicate", [["received", 0], ["duplicate", 2]])],
  ["Expired", fixture("expired", [["received", 0], ["verified", 4], ["risk_checked", 6], ["pending_approval", 8], ["expired", 120008]])],
  ["Bad secret", fixture("rejected_auth", [["received", 0], ["rejected_auth", 1]])],
  ["Invalid, later stages skipped", fixture("invalid", [["received", 0], ["invalid", 2]])],
];

function Lbl({ children }: { children: React.ReactNode }) {
  return <div className="gal-lbl">{children}</div>;
}

/**
 * Every primitive in every state (design/prototype/states.html first, then the rest of the inventory).
 * Reviewers compare this page with the prototype at 1440 and 390 wide, in both themes.
 */
export function ComponentsPage() {
  const toast = useToast();
  const [tab, setTab] = useState("connect");
  const [seg, setSeg] = useState("all");
  const [range, setRange] = useState("7d");
  const [sel, setSel] = useState("limit");
  const [market, setMarket] = useState("BTC");
  const [checked, setChecked] = useState(true);
  const [n1, setN1] = useState<number | null>(25000);
  const [n2, setN2] = useState<number | null>(0);
  const [on, setOn] = useState(true);
  const [mkts, setMkts] = useState({ BTC: true, ETH: true, ZEC: false });
  const [modal, setModal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [dirty, setDirty] = useState(true);

  const posCols = useMemo<Column<PosRow>[]>(
    () => [
      { key: "m", header: "Market", cell: (p) => <MarketChip market={p.market} /> },
      { key: "s", header: "Side", cell: (p) => <SideLabel side={p.side} /> },
      { key: "z", header: "Size", numeric: true, cell: (p) => formatSize(p.size, p.market) },
      { key: "n", header: "Notional", numeric: true, hideSm: true, cell: (p) => formatUsd(p.notional) },
      { key: "e", header: "Entry", numeric: true, hideSm: true, cell: (p) => formatPrice(p.entry, p.market) },
      { key: "k", header: "Mark", numeric: true, hideSm: true, cell: (p) => formatPrice(p.mark, p.market) },
      { key: "u", header: "Unrealized PnL", numeric: true, cell: (p) => <span className={p.upnl >= 0 ? "pos" : "neg"}>{formatSignedUsd(p.upnl)}</span> },
    ],
    [],
  );

  const pipe = alertPipeline(FAKE_ALERT);

  return (
    <>
      <PageHeader {...PAGE.components} />

      <div className="gal">
        {/* ---------------- Buttons ---------------- */}
        <Card className="span2">
          <CardHeader title="Buttons" meta="sm 28 · md 32 · lg 40" />
          <CardBody className="col" style={{ gap: 16 }}>
            <div>
              <Lbl>variants · md</Lbl>
              <div className="gal-row">
                <Button variant="primary">Primary</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="danger" icon={CirclePause}>Danger</Button>
                <Button variant="accent">Accent</Button>
                <IconButton variant="secondary" icon={Copy} label="Copy" />
                <Button variant="primary" disabled>Disabled</Button>
                <Button variant="secondary" loading loadingLabel="Saving">Save</Button>
              </div>
            </div>
            <div>
              <Lbl>sizes</Lbl>
              <div className="gal-row">
                <Button variant="primary" size="sm">Small</Button>
                <Button variant="primary">Medium</Button>
                <Button variant="primary" size="lg">Large</Button>
                <Button variant="secondary" size="sm" icon={Send}>Send test alert</Button>
                <Button variant="primary" kbd="A">Approve and send</Button>
              </div>
            </div>
          </CardBody>
        </Card>

        {/* ---------------- Inputs ---------------- */}
        <Card>
          <CardHeader title="Inputs" meta="32 default · 40 large" />
          <CardBody className="col" style={{ gap: 16 }}>
            <Input label="Default" placeholder="Strategy name" />
            <NumberInput label="Focused, with unit" boxClassName="is-focus" prefix="$" unit="per market" value={n1} onValueChange={setN1} min={1} />
            <NumberInput label="Error" unit="x" value={n2} onValueChange={setN2} error="Leverage must be between 1x and 20x." />
            <CopyField label="Read only, copy" value="https://hermes-relay.trycloudflare.com/v1/alerts/stg_8Kq2Zr" labeledCopy={false} />
            <Select label="Select" value={sel} onChange={setSel} options={[{ value: "limit", label: "Limit, immediate or cancel" }, { value: "market", label: "Market" }]} />
            <Input label="Disabled" defaultValue="Breakout 15m" disabled />
          </CardBody>
        </Card>

        {/* ---------------- Controls ---------------- */}
        <Card>
          <CardHeader title="Controls" />
          <CardBody className="col" style={{ gap: 16 }}>
            <div>
              <Lbl>toggle · on / off / disabled / positive (trading)</Lbl>
              <div className="gal-row">
                <Toggle checked={on} onCheckedChange={setOn} label="On" />
                <Toggle checked={false} onCheckedChange={() => {}} label="Off" />
                <Toggle checked disabled label="Disabled" />
                <Toggle tone="positive" checked={on} onCheckedChange={setOn} label="Trading" />
              </div>
            </div>
            <div>
              <Lbl>checkbox</Lbl>
              <div className="gal-row">
                <Checkbox checked={checked} onCheckedChange={setChecked} label="Dry run" />
                <Checkbox checked={false} onCheckedChange={() => {}} label="Unchecked" />
              </div>
            </div>
            <div>
              <Lbl>segmented</Lbl>
              <SegmentedControl aria-label="Outcome" value={seg} onChange={setSeg} options={[{ value: "all", label: "All", count: 47 }, { value: "filled", label: "Filled", count: 41 }, { value: "blocked", label: "Blocked", count: 4 }]} />
            </div>
            <div>
              <Lbl>tabs</Lbl>
              <Tabs flush aria-label="Demo tabs" value={tab} onChange={setTab} tabs={[{ value: "connect", label: "Connect" }, { value: "order", label: "Order settings" }, { value: "activity", label: "Activity", count: 152 }]} />
            </div>
            <div>
              <Lbl>meter · ok / warning 80%+ / negative 100%</Lbl>
              <div className="col" style={{ gap: 12 }}>
                <Meter value={27} />
                <Meter value={84} />
                <Meter value={100} />
              </div>
            </div>
          </CardBody>
        </Card>

        {/* ---------------- Pills and badges ---------------- */}
        <Card className="span2">
          <CardHeader title="Status pills and badges" />
          <CardBody className="col" style={{ gap: 16 }}>
            <div>
              <Lbl>alert outcome</Lbl>
              <div className="gal-row">
                <StatusPill kind="in_flight" />
                <StatusPill kind="needs_approval" />
                <StatusPill kind="filled" />
                <StatusPill kind="partly_filled" />
                <StatusPill kind="blocked" />
                <StatusPill kind="not_filled" />
                <StatusPill kind="rejected" />
                <StatusPill kind="ignored" />
                <StatusPill kind="expired" />
              </div>
            </div>
            <div>
              <Lbl>market · side · tag · connection</Lbl>
              <div className="gal-row">
                {["BTC", "ETH", "SOL", "MON", "ZEC"].map((m) => <MarketChip key={m} market={m} />)}
                <SideLabel side="long" />
                <SideLabel side="short" />
                <SideLabel side="close-long" />
                <Badge mono>mt 25</Badge>
                <Badge>stg_8Kq2Zr</Badge>
                <ConnectionPill state="connected" />
                <ConnectionPill state="reconnecting" />
                <ConnectionPill state="offline" />
              </div>
            </div>
            <div>
              <Lbl>pipeline · every terminal state</Lbl>
              <div className="col" style={{ gap: 16 }}>
                {PIPES.map(([name, alert]) => (
                  <div key={name} className="row" style={{ gap: 16, flexWrap: "wrap" }}>
                    <div className="col" style={{ width: 150, flex: "none", gap: 4, alignItems: "flex-start" }}>
                      <span className="xs muted">{name}</span>
                      <StatusPill kind={alertOutcome(alert).kind} />
                    </div>
                    <div className="hm-grow" style={{ minWidth: 280 }}><LifecyclePipeline stages={alertPipeline(alert).stages} size="lg" /></div>
                  </div>
                ))}
              </div>
            </div>
          </CardBody>
        </Card>

        {/* ---------------- Loading ---------------- */}
        <Card>
          <CardHeader title="Loading" meta="skeletons keep the final layout" />
          <KpiRow cols={3} style={{ border: 0, borderBottom: "1px solid var(--border-subtle)", borderRadius: 0 }}>
            <KpiTile loading label="" skeleton={[72, 96, 120]} />
            <KpiTile loading label="" skeleton={[64, 80, 100]} />
            <KpiTile loading label="" skeleton={[80, 72, 90]} />
          </KpiRow>
          <SkeletonRows rows={4} />
        </Card>

        {/* ---------------- Empty states ---------------- */}
        <Card>
          <CardHeader title="Empty states" />
          <EmptyState
            icon={Radio}
            title="No alerts yet"
            actions={
              <>
                <Button variant="primary" size="sm" icon={Send}>Send test alert</Button>
                <Button variant="ghost" size="sm">Copy webhook URL</Button>
              </>
            }
            className="bb"
          >
            When TradingView sends an alert to your webhook, it shows up here within a second. Send a test alert to try it now.
          </EmptyState>
          <div style={{ borderTop: "1px solid var(--border-subtle)" }} />
          <EmptyState icon={Inbox} title="Nothing to approve">
            Orders above <span className="mono">$10,000</span> wait here for you. You can change that amount in Risk limits.
          </EmptyState>
        </Card>

        {/* ---------------- Toasts ---------------- */}
        <Card>
          <CardHeader title="Toasts" meta="bottom right · 4 s · stack of 3 max" />
          <CardBody className="col" style={{ gap: 8 }}>
            <ToastView className="gal-static" tone="positive" title="Filled Long BTC 0.050" body="112,048.5 · 1.6 bps · 612 ms" actions={[{ label: "View alert", to: "/live" }]} />
            <ToastView className="gal-static" tone="warning" icon={OctagonX} title="Blocked Long SOL 140.0" body="Over your max position size of $25,000." />
            <ToastView className="gal-static" tone="negative" title="Could not save limits" body="The server did not answer. Your changes are still here." actions={[{ label: "Try again" }]} />
            <ToastView className="gal-static" tone="accent" title="Approval needed" body="Short BTC 0.120 · $13,445 · expires in 2:00" actions={[{ label: "Review", to: "/approvals" }]} />
            <div><Button size="sm" variant="secondary" onClick={() => toast.positive("Limits saved", "They apply from the next alert.")}>Fire a live toast</Button></div>
          </CardBody>
        </Card>

        {/* ---------------- Modal ---------------- */}
        <Card>
          <CardHeader title="Modal" meta="440 wide · confirm destructive actions" />
          <CardBody>
            <div className="stage-box">
              <div className="modal gal-static" role="presentation">
                <div className="modal-body">
                  <h3>Pause trading?</h3>
                  <p>Hermes stops sending new orders from every strategy. Alerts still arrive and are logged as blocked. Open positions stay open.</p>
                </div>
                <div className="modal-foot">
                  <Button variant="ghost">Cancel</Button>
                  <Button variant="danger" icon={CirclePause}>Pause trading</Button>
                </div>
              </div>
            </div>
          </CardBody>
        </Card>

        {/* ---------------- Errors ---------------- */}
        <Card>
          <CardHeader title="Errors" />
          <CardBody className="col" style={{ gap: 12 }}>
            <Callout tone="negative"><b>Perpl rejected the API key.</b> It may have expired or been revoked. Create a new trade-only key and paste it again.</Callout>
            <Callout tone="warning" icon={TriangleAlert}><b>Daily loss stop reached.</b> New orders are blocked until 00:00 UTC. Closing orders still go through.</Callout>
            <Callout tone="accent">TradingView only sends webhooks on paid plans with two-factor authentication.</Callout>
            <EmptyState compact tone="negative" icon={WifiOff} title="Could not load alerts" actions={<Button variant="secondary" size="sm" icon={RefreshCw}>Retry</Button>}>
              Hermes did not respond. Alerts are still being processed on the server.
            </EmptyState>
          </CardBody>
        </Card>

        {/* =============== beyond states.html: the rest of the inventory =============== */}

        <Card className="span2">
          <CardHeader title="KPI tiles" meta="one strip, 1px dividers · 4, 3 or 6 per row · 2 on mobile" />
          <KpiRow cols={4} style={{ border: 0, borderRadius: 0 }}>
            <KpiTile label="Alerts today" value="47" sub={<><span>41 filled</span><span className="faint">·</span><span>4 blocked</span><span className="faint">·</span><span>2 missed</span></>} />
            <KpiTile label="Fill rate" value="95.3" unit="%" sub="41 of 43 that passed your limits" />
            <KpiTile label="Median alert to fill" value="486" unit="ms" sub={<>p95 <span className="d secondary">871 ms</span></>} />
            <KpiTile label="Median slippage" value="2.1" unit="bps" sub={<KpiDelta tone="positive" icon={<ArrowDown />}>38 ms faster</KpiDelta>} />
          </KpiRow>
          <div style={{ borderTop: "1px solid var(--border-subtle)" }} />
          <KpiRow cols={3} style={{ border: 0, borderRadius: 0 }}>
            <KpiTile label="Alert price" mono value="112,031.0" sub="From TradingView, BINANCE:BTCUSDT 15m" />
            <KpiTile label="Realized PnL" value="+$1,284.50" tone="positive" sub="Slippage cost −$71.40 · fees −$42.18" />
            <KpiTile label="Stopped" value="22" size="sm" sub="9 blocked by limits · 13 missed" />
          </KpiRow>
        </Card>

        <Card className="span2">
          <CardHeader title="Data table" meta="sticky header, numeric columns right-aligned, clickable rows" actions={<span className="card-meta">Open positions <Badge mono>3</Badge></span>} />
          <DataTable aria-label="Open positions" columns={posCols} rows={POS} rowKey={(p) => p.market} onRowClick={(p) => toast.accent(`Clicked ${p.market}`)} />
          <CardFooter>
            <span>Margin used <span className="mono secondary">$3,761.65</span> of <span className="mono secondary">$10,482.16</span> equity</span>
            <span className="mono">Perpl account #4821</span>
          </CardFooter>
        </Card>

        <Card className="span2">
          <CardHeader title="Lifecycle" meta="6 of 6 stages · 612 ms" />
          <CardBody className="col" style={{ gap: 20 }}>
            <LifecyclePipeline stages={pipe.stages} size="lg" />
            <div className="gal-row" style={{ gap: 24 }}>
              <div style={{ width: 360 }}><LifecyclePipeline stages={pipe.stages} /></div>
              <div style={{ width: 160 }}><PipelineDots stages={pipe.stages} /></div>
              <span className="xs muted">row form (4px) and dot form</span>
            </div>
          </CardBody>
          <Timeline
            axisTotal="612 ms"
            axisMid={["200", "400"]}
            items={[
              { time: "14:32:07.412", title: "Received", description: <>POST from TradingView <span className="mono">52.89.214.238</span> to <span className="mono">/v1/alerts/stg_8Kq2Zr</span></>, delta: "0 ms", bar: { left: 0, width: 0.3 } },
              { time: "14:32:07.416", title: "Verified", description: "Secret matches. Alert id is new. Message has every required field.", delta: "+4 ms", bar: { left: 0, width: 0.7 } },
              { time: "14:32:07.418", title: "Risk checks passed", description: "6 of 6 checks passed. Under the approval threshold, sent without waiting.", delta: "+2 ms", bar: { left: 0.7, width: 0.4 } },
              { time: "14:32:07.429", title: "Sent to Perpl", description: <>Order frame <span className="mono">mt 22</span> · <span className="mono">rq 1,904,233</span></>, delta: "+11 ms", bar: { left: 1.1, width: 1.8 } },
              { time: "14:32:07.613", title: "Accepted", description: <>Placed in block <span className="mono">41,822,869</span> (<span className="mono">mt 24</span>)</>, delta: "+184 ms", bar: { left: 2.9, width: 30 } },
              { time: "14:32:08.024", title: "Filled", state: "final", description: <>0.050 @ 112,048.5 in block <span className="mono">41,822,871</span> · fee $1.68</>, delta: "+411 ms", bar: { left: 33, width: 67 } },
            ]}
          />
        </Card>

        <Card>
          <CardHeader title="Code block" meta="JSON highlight, copy copies the real value" />
          <CardBody className="col" style={{ gap: 12 }}>
            <CodeBlock title="TradingView message" meta="includes your secret" code={TEMPLATE} copyValue={TEMPLATE.replace("••••••••••••hx2K", "whsec_9fT2mQ7vLc4Rk8Zp1Xn6hx2K")} copyLabel="Copy message" />
            <CodeBlock title="Order frame sent" meta="mt 22" code={FRAME} copyAriaLabel="Copy order frame" />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Copy fields" />
          <CardBody className="col" style={{ gap: 16 }}>
            <CopyField label="Webhook URL" labeledCopy value="https://hermes-relay.trycloudflare.com/hooks/stg_8Kq2Zr" />
            <CopyField secret label="Secret" value="whsec_9fT2mQ7vLc4Rk8Zp1Xn6hx2K" after={<Button variant="secondary" icon={RefreshCw}>Rotate</Button>} />
            <CopyField label="Wallet address" size="lg" value="0x7a3F9c21E0b84d6A5f1C3e7B92d40aF8c6E191c2" href="https://testnet.monadexplorer.com/address/0x7a3F9c21E0b84d6A5f1C3e7B92d40aF8c6E191c2" labeledCopy={false} />
            <div className="row" style={{ gap: 12 }}>
              <ExplorerLink value="0x8f3ae21c00000000000000000000000000000000000000000000000000000000" />
              <ExplorerLink kind="address" value="0x7a3F9c21E0b84d6A5f1C3e7B92d40aF8c6E191c2">{shortHex("0x7a3F9c21E0b84d6A5f1C3e7B92d40aF8c6E191c2")}</ExplorerLink>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Input sizes, select, tooltip" />
          <CardBody className="col" style={{ gap: 16 }}>
            <Input label="Large" size="lg" placeholder="40 high, radius 8" />
            <Textarea label="Textarea" placeholder="Notes" rows={2} />
            <Select label="Market" value={market} onChange={setMarket} options={[{ value: "BTC", label: "Bitcoin", market: "BTC" }, { value: "ETH", label: "Ether", market: "ETH" }, { value: "ZEC", label: "Zcash", market: "ZEC", disabled: true }]} />
            <div className="gal-row">
              <Select variant="button" aria-label="Strategy" value={range} onChange={setRange} options={[{ value: "7d", label: "Last 7 days" }, { value: "30d", label: "Last 30 days" }, { value: "all", label: "All time" }]} />
              <SegmentedControl aria-label="Range" value={range} onChange={setRange} options={[{ value: "7d", label: "7d" }, { value: "30d", label: "30d" }, { value: "all", label: "All" }]} />
              <Tooltip content="Filled 0.4 bps better than the alert price"><span className="pos mono xs">{formatBps(-0.4)}</span></Tooltip>
              <IconButton icon={Copy} label="Copy ID" />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Callout and banner" />
          <CardBody className="col" style={{ gap: 12 }}>
            <Callout tone="positive" icon={ShieldCheck}><b>Trade-only keys can open and close positions. They can never withdraw or transfer funds.</b> Perpl enforces this, not Hermes.</Callout>
            <Callout><b>Neutral callout.</b> Raised surface, for plain notes.</Callout>
            <div style={{ margin: "0 -16px" }}>
              <Banner icon={WifiOff} action={<Button size="sm" variant="ghost">Details</Button>}><b>Perpl trading socket dropped.</b> Reconnecting, attempt 2 of 5. New alerts wait up to 10 s, then fail with a reason.</Banner>
              <Banner tone="negative" icon={WifiOff}><b>Live updates stopped.</b> Reconnecting.</Banner>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Overlays" meta="drawer 480 · modal 440 · focus trapped, Escape closes" />
          <CardBody>
            <div className="gal-row">
              <Button variant="secondary" onClick={() => setDrawer(true)}>Open drawer</Button>
              <Button variant="secondary" onClick={() => setModal(true)}>Open modal</Button>
              <Button variant="danger" icon={CirclePause} onClick={() => setConfirm(true)}>Confirm modal</Button>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Stepper, spinner, avatar" />
          <CardBody className="col" style={{ gap: 16 }}>
            <Stepper steps={ONBOARDING_STEPS.map((s) => ({ ...s }))} current={2} />
            <div className="gal-row">
              <Spinner size={16} label="Loading" />
              <Spinner size={24} />
              <Avatar name="ifeoma@example.com" />
              <Skeleton w={96} h={12} />
            </div>
          </CardBody>
        </Card>

        <Card className="span2">
          <CardHeader title="Charts" meta="SVG at container pixel width · one y axis" actions={<ChartLegend items={[{ label: "Median" }, { label: "p95", tone: "secondary" }]} />} />
          <CardBody>
            <LineChart
              series={[{ key: "med", label: "Median", values: MED }, { key: "p95", label: "p95", values: P95, tone: "secondary" }]}
              yTicks={[0, 500, 1000, 1500]}
              formatY={(v) => (v === 1000 ? "1 s" : v === 1500 ? "1.5 s" : String(v))}
              xTicks={["4 Oct", "5 Oct", "6 Oct", "7 Oct", "8 Oct", "9 Oct", "10 Oct"].map((label, k) => ({ index: k * 4, label }))}
              annotation={{ index: 10, seriesKey: "p95", text: "1.42 s · Perpl reconnect" }}
              tooltip={(i) => (
                <>
                  <b>{4 + Math.floor(i / 4)} Oct, {String((i % 4) * 6).padStart(2, "0")}:00</b>
                  <span>Median {MED[i]} ms · p95 {P95[i]} ms</span>
                </>
              )}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Slippage histogram" meta="135 fills · bps worse than the alert price" />
          <CardBody>
            <Histogram
              bins={HIST.map((count, i) => ({ label: BIN_LABELS[i]!, count, tip: { title: `${count} fills`, detail: i === 0 ? "better than alert" : i === 13 ? "12 bps or more" : `${BIN_LABELS[i]} to ${Number(BIN_LABELS[i]) + 1} bps worse` } }))}
              median={{ at: 5.1, label: "median 4.1" }}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Sparkline" />
          <CardBody className="col" style={{ gap: 12 }}>
            <Sparkline values={MED} wash aria-label="Median latency" />
            <Sparkline values={P95} tone="muted" />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Approval countdown and grade" />
          <CardBody className="col" style={{ gap: 16 }}>
            <div className="row between"><span className="xs muted">102 s left</span><Countdown remainingSec={102} totalSec={120} /></div>
            <div className="row between"><span className="xs muted">38 s left</span><Countdown remainingSec={38} totalSec={120} /></div>
            <div className="grade">
              <GradeBadge grade="B" />
              <div className="col hm-grow" style={{ gap: 8 }}>
                <span><span className="mono" style={{ fontSize: 18 }}>88.7</span> <span className="muted">/ 100</span></span>
                <GradeScale grade="B" />
              </div>
            </div>
            <div className="gal-row"><GradeBadge grade="A" size={40} /><GradeBadge grade="C" size={40} /><GradeBadge grade="F" size={40} /><GradeBadge grade={null} size={40} /></div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Risk checks, key values" />
          <ChecksList
            icons={{ pass: CircleCheck, fail: OctagonX, skip: CircleX }}
            items={[
              { state: "fail", name: "Max position size", detail: "Position after this order", value: "$29,458 / $25,000" },
              { state: "pass", name: "Strategy enabled", detail: "Breakout 15m", value: "On" },
              { state: "skip", name: "Approval threshold", detail: "Not evaluated", value: "n/a" },
            ]}
          />
          <div className="card-body" style={{ paddingTop: 0 }}>
            <KeyValue items={[["Fill tx", <ExplorerLink key="a" value="0x8f3ae21c00000000000000000000000000000000000000000000000000000000" />], ["Limit price", <span key="b" className="mono">111,707.9</span>]]} />
          </div>
        </Card>

        <Card className="span2">
          <CardHeader title="Market tiles and save bar" />
          <CardBody className="col" style={{ gap: 16 }}>
            <div className="mkt-tiles" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))" }}>
              <MarketTile market="BTC" checked={mkts.BTC} onChange={(v) => setMkts((m) => ({ ...m, BTC: v }))} price="112,051.3" note="Open $7,844" />
              <MarketTile market="ETH" checked={mkts.ETH} onChange={(v) => setMkts((m) => ({ ...m, ETH: v }))} price="4,104.10" note="No position" />
              <MarketTile market="ZEC" checked={mkts.ZEC} onChange={(v) => setMkts((m) => ({ ...m, ZEC: v }))} price="287.40" note="1 alert blocked today" />
            </div>
            {dirty && <SaveBar summary="1 unsaved change · Daily loss stop $400 to $500" onDiscard={() => setDirty(false)} onSave={() => { setDirty(false); toast.positive("Limits saved", "They apply from the next alert."); }} />}
            {!dirty && <Button variant="secondary" size="sm" onClick={() => setDirty(true)}>Show save bar</Button>}
          </CardBody>
        </Card>
      </div>

      <Drawer open={drawer} onClose={() => setDrawer(false)} title="New strategy" footer={<><Button variant="ghost" onClick={() => setDrawer(false)}>Cancel</Button><Button variant="primary">Create strategy</Button></>}>
        <div className="col" style={{ gap: 16 }}>
          <Input label="Name" placeholder="Breakout 15m" />
          <Select label="Market" value={market} onChange={setMarket} options={[{ value: "BTC", label: "BTC", market: "BTC" }, { value: "ETH", label: "ETH", market: "ETH" }]} />
          <NumberInput label="Leverage if the alert has none" unit="x" value={5} onValueChange={() => {}} />
        </div>
      </Drawer>
      <Modal open={modal} onClose={() => setModal(false)} title="Rotate secret?" footer={<><Button variant="ghost" onClick={() => setModal(false)}>Cancel</Button><Button variant="primary" onClick={() => setModal(false)}>Rotate</Button></>}>
        Alerts that still use the old secret will be ignored. Update your TradingView message right after.
      </Modal>
      <ConfirmModal open={confirm} onClose={() => setConfirm(false)} onConfirm={() => setConfirm(false)} title="Pause trading?" confirmLabel="Pause trading" confirmIcon={CirclePause} variant="danger">
        Hermes stops sending new orders from every strategy. Alerts still arrive and are logged as blocked. Open positions stay open.
      </ConfirmModal>
    </>
  );
}
