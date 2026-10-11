import { ArrowRight, ChevronLeft, FlaskConical, ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";
import type { WalletActionKind } from "@hermes/shared";
import { useAuth } from "../../auth/context";
import { useEmbeddedWallet } from "../../auth/hooks";
import { Button } from "../../components/ui/Button";
import { Card, CardBody, CardHeader } from "../../components/ui/Card";
import { Callout } from "../../components/ui/Feedback";
import { ExplorerLink } from "../../components/ui/Misc";
import { NumberInput } from "../../components/ui/NumberInput";
import { useToast } from "../../components/ui/Toast";
import { errorMessage } from "../../lib/api";
import { formatNumber } from "../../lib/format";
import { useMe, usePerplConnection, useRunWalletAction, useSignerConfig, useWalletActions } from "../../lib/queries";
import { Skeleton } from "../../components/ui/Skeleton";
import { latestAction, useDepositInfo, useSimConnect, useWalletBalances } from "../wallet/hooks";
import { Disclosure, PolicyDemo, TxRow, txMeta, txPill, txState } from "../wallet/parts";
import type { StepProps } from "./types";

/** `Approve 250 AUSD to the Perpl Exchange` -> 250. Lets a refresh keep the amount that was approved. */
const approvedAmount = (description: string | undefined): number | null => {
  const m = description?.match(/Approve ([\d.]+) AUSD/);
  return m ? Number(m[1]) : null;
};

const idleText = (symbol: string): Record<WalletActionKind, string> => ({
  faucet: `Optional. Skip it if your wallet already holds ${symbol}.`,
  approve_collateral: "Lets the exchange take the deposit from your wallet.",
  create_account: "Opens your Perpl account with the first deposit.",
  allow_forwarding: "Lets your trade-only API key place orders for this account.",
  deposit: "",
  policy_demo: "",
});

/** Step 2: fund the wallet, approve AUSD, create the Perpl account, allow order forwarding. Every row is a server-signed wallet action. */
export function StepAccount({ go, accountDone }: StepProps) {
  const toast = useToast();
  const { user } = useAuth();
  const wallet = useEmbeddedWallet();
  const address = wallet.address ?? user?.walletAddress ?? null;
  const me = useMe();
  const cfg = useSignerConfig();
  const actions = useWalletActions();
  const perpl = usePerplConnection();
  const bal = useWalletBalances(address, cfg.data?.policy.collateralToken);
  const run = useRunWalletAction();
  const sim = useSimConnect();

  const startedAt = useRef(0);
  const [errors, setErrors] = useState<Partial<Record<WalletActionKind, string>>>({});

  const list = actions.data;
  const approve = latestAction(list, "approve_collateral");
  const create = latestAction(list, "create_account");
  const forward = latestAction(list, "allow_forwarding");
  const faucet = latestAction(list, "faucet");

  const dep = useDepositInfo();
  const symbol = dep.symbol;
  // Opening the account needs Perpl's account minimum; once it exists, deposits only need the (lower) deposit minimum.
  const accountExists = Boolean(perpl.data?.configured) || create?.status === "confirmed";
  const minimum = accountExists ? dep.minDeposit : dep.minOpen;
  const cap = cfg.data ? Number(cfg.data.policy.approveCapAusd) : null;
  const [amountDraft, setAmount] = useState<number | null>(null);
  const amount = amountDraft ?? approvedAmount(approve?.description) ?? minimum;
  const approveLocked = approve?.status === "confirmed" || approve?.status === "submitted";

  const amountError =
    amount === null || amount <= 0
      ? dep.loading && amountDraft === null
        ? undefined
        : "Enter an amount."
      : minimum !== null && amount < minimum
        ? `Perpl needs at least ${formatNumber(minimum, 0)} ${symbol} to ${accountExists ? "deposit" : "open an account"}.`
        : cap !== null && amount > cap
          ? `Your wallet policy caps one approval at ${formatNumber(cap, 2)} ${symbol}.`
          : undefined;
  const amountOk = !amountError && amount !== null && amount > 0;

  const runKind = run.isPending ? run.variables?.kind : undefined;
  const rowAction = (kind: WalletActionKind, a: typeof faucet) => {
    const running = runKind === kind;
    // While running, ignore results from earlier attempts.
    const current = running && a && a.createdAt < startedAt.current - 1000 ? undefined : a;
    return { running, a: current, state: txState(current, running) };
  };

  const start = (kind: "faucet" | "approve_collateral" | "create_account" | "allow_forwarding") => {
    startedAt.current = Date.now();
    setErrors((e) => ({ ...e, [kind]: undefined }));
    const body = kind === "approve_collateral" || kind === "create_account" ? { kind, amount: String(amount) } : { kind };
    run.mutate(body, { onError: (err) => setErrors((e) => ({ ...e, [kind]: errorMessage(err) })) });
  };

  const amountLabel = amount === null ? "" : ` ${formatNumber(amount, 2)} ${symbol}`;
  const rows = [
    { kind: "faucet" as const, a: faucet, title: `Get test ${symbol}`, can: true, label: `Get ${symbol}`, optional: true },
    { kind: "approve_collateral" as const, a: approve, title: `Approve${amountLabel || ` ${symbol}`}`, can: amountOk, label: "Approve", optional: false },
    { kind: "create_account" as const, a: create, title: `Create account and deposit${amountLabel || ` ${symbol}`}`, can: amountOk && approve?.status === "confirmed", label: "Create account", optional: false },
    { kind: "allow_forwarding" as const, a: forward, title: "Allow order forwarding", can: create?.status === "confirmed", label: "Allow forwarding", optional: false },
  ].map((r) => {
    const x = rowAction(r.kind, r.a);
    const err = errors[r.kind];
    return { ...r, ...x, err, rowState: err && !x.running && x.state === "idle" ? ("failed" as const) : x.state };
  });
  // Only the next step gets a button. Everything after it shows its status pill (Not started) and waits.
  const next = rows.find((r) => !r.optional && r.rowState !== "done");
  const faucetOffered = next?.kind === "approve_collateral" && next.rowState === "idle";

  const simConnect = () =>
    sim.mutate(undefined, {
      onSuccess: () => {
        toast.positive("Simulated Perpl account connected", "It has test funds. Setup moves on to your first strategy.");
        go(4);
      },
    });

  const accountId = perpl.data?.accountId;
  const showSim = me.data?.perplMode === "sim";
  const busy = run.isPending;

  return (
    <>
      <div>
        <h2>Open your Perpl account</h2>
        <p className="lead">
          Perpl trades from an exchange account funded with AUSD. Hermes signs the transactions from your wallet under its policy: one lets the exchange take the deposit, the other creates the account with it, and a last one lets your API key place orders.
        </p>
      </div>

      {perpl.data?.configured && (
        <Callout tone="positive">
          <b>A Perpl account is already connected{accountId ? ` (#${accountId})` : ""}.</b> You can continue, or add more funds below.
        </Callout>
      )}

      <NumberInput
        size="lg"
        label={accountExists ? "Deposit" : "First deposit"}
        unit={symbol}
        value={amount}
        onValueChange={setAmount}
        decimals={2}
        min={0}
        disabled={approveLocked}
        error={amountError}
        hint={
          <>
            {dep.loading ? (
              <Skeleton w={160} h={12} />
            ) : minimum !== null ? (
              <>
                Minimum set by Perpl: <span className="mono">{formatNumber(minimum, 0)} {symbol}</span>.
              </>
            ) : (
              <>Could not read Perpl's minimum. Hermes checks the amount before it sends.</>
            )}{" "}
            Wallet balance:{" "}
            {bal.data?.ausd == null ? <span className="faint">n/a</span> : <span className="mono">{formatNumber(bal.data.ausd, 2)} {symbol}</span>}.
            {approveLocked && " Locked because the approval is sent."}
          </>
        }
        trailing={
          <Button
            variant="ghost"
            size="sm"
            disabled={approveLocked || bal.data?.ausd == null}
            onClick={() => setAmount(Math.floor(Math.min(bal.data?.ausd ?? 0, cap ?? Infinity) * 100) / 100)}
          >
            Max
          </Button>
        }
      />

      <Card>
        <div className="tx-list">
          {rows.map((r, i) => {
            const { running, a, rowState, err } = r;
            const isNext = next?.kind === r.kind;
            const offered = isNext || (r.optional && faucetOffered);
            const idle = rowState === "idle";
            const retry = rowState === "failed" || rowState === "denied";
            const canStart = r.can && !busy && rowState !== "pending" && rowState !== "waiting" && rowState !== "done";
            return (
              <TxRow
                key={r.kind}
                n={i + 1}
                title={r.title}
                state={rowState}
                meta={txMeta(a, rowState, idleText(symbol)[r.kind], err)}
                pill={txPill(rowState, r.optional)}
                action={
                  offered && (idle || retry) && !running ? (
                    <Button size="sm" variant={isNext ? "primary" : "secondary"} disabled={!canStart} onClick={() => start(r.kind)}>
                      {idle ? r.label : "Try again"}
                    </Button>
                  ) : null
                }
              />
            );
          })}
        </div>
      </Card>

      <Callout tone="neutral" icon={ShieldCheck}>
        <b>This wallet can only interact with the Perpl exchange contract.</b> Privy refuses any other transaction before it is signed, so funds cannot be sent anywhere else.
        {cfg.data && (
          <>
            {" "}
            Contract <ExplorerLink kind="address" value={cfg.data.policy.exchange} />
          </>
        )}
      </Callout>

      <Disclosure id="ob-more" label="More options">
        <div className="col g4">
          <Card>
            <CardHeader title="Policy check" meta="Optional" />
            <CardBody className="col g3">
              <p className="secondary" style={{ fontSize: 13, lineHeight: "20px" }}>
                Try a transaction the policy must refuse. Hermes sends it through Privy and shows the answer here.
              </p>
              <PolicyDemo disabled={!address} />
            </CardBody>
          </Card>
          {showSim && (
            <Card>
              <CardHeader title="Use a simulated Perpl account" meta="Test mode only" />
              <CardBody className="col g3">
                <p className="secondary" style={{ fontSize: 13, lineHeight: "20px" }}>
                  Skip the wallet transactions and the API key. Hermes connects an in-process Perpl simulator with a funded account, so you can see alerts fill without leaving your browser.
                </p>
                {sim.isError && (
                  <Callout tone="negative">
                    <b>Could not connect the simulated account.</b> {errorMessage(sim.error)}
                  </Callout>
                )}
                <div>
                  <Button variant="secondary" icon={FlaskConical} onClick={simConnect} loading={sim.isPending} loadingLabel="Connecting">
                    Use a simulated Perpl account
                  </Button>
                </div>
              </CardBody>
            </Card>
          )}
        </div>
      </Disclosure>

      <div className="ob-foot">
        <Button variant="ghost" icon={ChevronLeft} onClick={() => go(1)}>
          Back
        </Button>
        {accountDone ? (
          <Button variant="primary" size="lg" onClick={() => go(3)}>
            Continue
            <ArrowRight aria-hidden />
          </Button>
        ) : (
          <Button variant="primary" size="lg" disabled>
            Waiting for confirmation
          </Button>
        )}
      </div>
    </>
  );
}
