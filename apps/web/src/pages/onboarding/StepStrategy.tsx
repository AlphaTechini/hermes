import { ArrowRight, ChevronLeft, LoaderCircle, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { StrategyDTO, StrategySecretDTO } from "@hermes/shared";
import { Button } from "../../components/ui/Button";
import { MarketChip, Tag } from "../../components/ui/Badges";
import { CodeBlock } from "../../components/ui/CodeBlock";
import { CopyField } from "../../components/ui/CopyField";
import { Callout } from "../../components/ui/Feedback";
import { Input } from "../../components/ui/Input";
import { NumberInput } from "../../components/ui/NumberInput";
import { SegmentedControl } from "../../components/ui/Segmented";
import { Select } from "../../components/ui/Select";
import { Skeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/api";
import { alertOutcome, alertPipeline } from "../../lib/alert-view";
import { formatBps, formatMs, formatPrice, formatSize, maskSecret } from "../../lib/format";
import { useAlert, useCreateStrategy, useRevealSecret, useSendTestAlert, useStrategies } from "../../lib/queries";
import { SECRET_PLACEHOLDER } from "@hermes/shared";
import type { StepProps } from "./types";

const MARKETS = [
  { value: "BTC", label: "Bitcoin perpetual", market: "BTC" },
  { value: "ETH", label: "Ethereum perpetual", market: "ETH" },
  { value: "SOL", label: "Solana perpetual", market: "SOL" },
  { value: "MON", label: "Monad perpetual", market: "MON" },
  { value: "ZEC", label: "Zcash perpetual", market: "ZEC" },
];

/** Plaintext secret of a strategy, kept in component state only (revealed once, dropped on unmount). */
function useSecret(strategy: StrategyDTO | undefined, created: StrategySecretDTO | null): string | null {
  const reveal = useRevealSecret();
  const [secret, setSecret] = useState<string | null>(created && created.id === strategy?.id ? created.secret : null);
  const id = strategy?.id;
  useEffect(() => {
    if (!id || secret) return;
    let live = true;
    reveal.mutate(id, { onSuccess: (s) => live && setSecret(s.secret) });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return secret;
}

function TestResult({ alertId }: { alertId: string }) {
  const alert = useAlert(alertId);
  const a = alert.data;
  if (!a) {
    return (
      <Callout tone="accent" icon={LoaderCircle}>
        <b>Test alert sent.</b> Waiting for the first result.
      </Callout>
    );
  }
  const out = alertOutcome(a);
  const { totalMs } = alertPipeline(a);
  const fill = a.fills[0];
  const side = a.side === "short" ? "Short" : "Long";
  const see = (
    <>
      {" "}
      <Link className="link" to={`/alerts/${a.id}`}>
        See every step
      </Link>
    </>
  );
  if (out.kind === "filled" || out.kind === "partly_filled") {
    return (
      <Callout tone="positive">
        <b>Test alert filled in {formatMs(totalMs ?? a.latencyMs)}.</b> {side} {a.market} {fill ? formatSize(fill.size, a.market) : ""}
        {fill && (
          <>
            {" "}
            at <span className="mono">{formatPrice(fill.price, a.market)}</span>
          </>
        )}
        {a.slippageBps !== null && (
          <>
            , <span className="mono">{formatBps(a.slippageBps)}</span> from the alert price
          </>
        )}
        .{see}
      </Callout>
    );
  }
  if (out.kind === "in_flight" || out.kind === "needs_approval") {
    return (
      <Callout tone="accent" icon={LoaderCircle}>
        <b>Test alert is on its way.</b> {out.why}.{see}
      </Callout>
    );
  }
  if (out.kind === "blocked") {
    return (
      <Callout tone="warning">
        <b>Test alert blocked by your limits.</b> {out.why}. Nothing was sent to Perpl.{see}
      </Callout>
    );
  }
  return (
    <Callout tone="negative">
      <b>Test alert {out.label.toLowerCase()}.</b> {out.why}.{see}
    </Callout>
  );
}

/** Step 4: create the first strategy, then show the webhook URL, secret and TradingView message, with a test alert. */
export function StepStrategy({ go }: StepProps) {
  const navigate = useNavigate();
  const strategies = useStrategies();
  const create = useCreateStrategy();
  const test = useSendTestAlert();

  const [name, setName] = useState("");
  const [market, setMarket] = useState("BTC");
  const [leverage, setLeverage] = useState<number | null>(5);
  const [size, setSize] = useState<number | null>(100);
  const [touched, setTouched] = useState(false);
  const [created, setCreated] = useState<StrategySecretDTO | null>(null);
  const [alertId, setAlertId] = useState<string | null>(null);
  const [kind, setKind] = useState<"strategy" | "indicator">("strategy");

  const existing = useMemo(() => (strategies.data ?? []).slice().sort((a, b) => b.createdAt - a.createdAt)[0], [strategies.data]);
  const strategy: StrategyDTO | undefined = created ?? existing;
  const secret = useSecret(strategy, created);

  const nameError = touched && !name.trim() ? "Give the strategy a name." : undefined;
  const levError = leverage !== null && leverage <= 0 ? "Leverage must be above 0." : undefined;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!name.trim() || levError) return;
    create.mutate(
      { name: name.trim(), defaultMarket: market, defaultLeverage: leverage, defaultSizeUsd: size && size > 0 ? size : null },
      { onSuccess: (s) => setCreated(s) },
    );
  };

  const sendTest = () => test.mutate({ id: strategy!.id, action: "buy", market: strategy!.defaultMarket ?? market }, { onSuccess: (r) => setAlertId(r.alertId) });

  const template = strategy ? (kind === "strategy" ? strategy.templates.strategy : strategy.templates.indicator) : "";
  const shown = secret ? template.replace(SECRET_PLACEHOLDER, maskSecret(secret)) : template;
  const real = secret ? template.replace(SECRET_PLACEHOLDER, secret) : template;

  return (
    <>
      <div>
        <h2>Create your first strategy</h2>
        <p className="lead">A strategy is one TradingView alert. Name it, then paste its webhook URL and message into the alert.</p>
      </div>

      {strategies.isLoading ? (
        <div className="col g4">
          <Skeleton h={40} />
          <Skeleton h={40} />
          <Skeleton h={160} />
        </div>
      ) : strategy ? (
        <>
          <div className="row g3" style={{ flexWrap: "wrap" }}>
            <MarketChip market={strategy.defaultMarket ?? "BTC"} />
            <span style={{ fontSize: 15, fontWeight: 500 }}>{strategy.name}</span>
            <Tag mono>{strategy.id}</Tag>
            {created && <span className="xs muted">Created just now</span>}
          </div>
          <div className="col g3">
            <CopyField label="Webhook URL" value={strategy.webhookUrl} labeledCopy hint="In the alert's Notifications tab, turn on Webhook URL and paste this." />
            <CopyField
              secret
              label="Secret"
              value={secret ?? undefined}
              maskedPreview={secret ? undefined : "•".repeat(20) + "••••"}
              hint="It goes inside the message below. Hermes ignores any alert without it."
            />
            <span className="label" style={{ marginTop: 4 }}>
              Message
            </span>
            <CodeBlock
              headerLeft={
                <>
                  <SegmentedControl
                    size="sm"
                    aria-label="Alert type"
                    value={kind}
                    onChange={setKind}
                    options={[
                      { value: "strategy", label: "Strategy alert" },
                      { value: "indicator", label: "Indicator alert" },
                    ]}
                  />
                  <span className="m">includes your secret</span>
                </>
              }
              code={shown}
              copyValue={real}
              copyLabel="Copy message"
            />
          </div>
          {alertId && <TestResult alertId={alertId} />}
          {test.isError && (
            <Callout tone="negative">
              <b>Could not send the test alert.</b> {errorMessage(test.error)}
            </Callout>
          )}
          <div className="ob-foot">
            <Button variant="secondary" size="lg" icon={Send} onClick={sendTest} loading={test.isPending} loadingLabel="Sending">
              Send test alert
            </Button>
            <Button variant="primary" size="lg" onClick={() => navigate("/live")}>
              Go to Live
              <ArrowRight aria-hidden />
            </Button>
          </div>
        </>
      ) : (
        <form className="col g4" onSubmit={submit} noValidate>
          <div className="form-grid">
            <div style={{ gridColumn: "1 / -1" }}>
              <Input size="lg" label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Breakout 15m" error={nameError} maxLength={80} autoFocus />
            </div>
            <Select size="lg" label="Market" value={market} onChange={setMarket} options={MARKETS} />
            <NumberInput size="lg" label="Leverage if the alert has none" unit="x" value={leverage} onValueChange={setLeverage} min={1} max={50} error={levError} />
            <div style={{ gridColumn: "1 / -1" }}>
              <NumberInput size="lg" label="Size if the alert has none" prefix="$" unit="per alert" value={size} onValueChange={setSize} min={0} decimals={2} hint="Used for test alerts and for alerts that carry no size." />
            </div>
          </div>
          {create.isError && (
            <Callout tone="negative">
              <b>Could not create the strategy.</b> {errorMessage(create.error)}
            </Callout>
          )}
          <div className="ob-foot">
            <Button variant="ghost" icon={ChevronLeft} onClick={() => go(3)}>
              Back
            </Button>
            <Button type="submit" variant="primary" size="lg" loading={create.isPending} loadingLabel="Creating">
              Create strategy
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
