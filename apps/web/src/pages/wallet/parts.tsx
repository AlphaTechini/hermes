import {
  Check,
  CircleCheck,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  OctagonX,
  ShieldCheck,
  TriangleAlert,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import type { PerplConnectionDTO, PolicySummaryDTO, SignerConfigDTO, WalletActionDTO } from "@hermes/shared";
import { useAddHermesSigner } from "../../auth/hooks";
import { Button, ButtonAnchor, IconButton } from "../../components/ui/Button";
import { Callout } from "../../components/ui/Feedback";
import { Input } from "../../components/ui/Input";
import { ExplorerLink, KeyValue } from "../../components/ui/Misc";
import { SegmentedControl } from "../../components/ui/Segmented";
import { StatusPill } from "../../components/ui/Badges";
import { useCopy } from "../../components/ui/hooks";
import { Skeleton } from "../../components/ui/Skeleton";
import { errorMessage, isApiError } from "../../lib/api";
import { explorerAddressUrl, formatDateTime, formatNumber } from "../../lib/format";
import { usePolicyDemo, usePutPerplConnection } from "../../lib/queries";
import { MIN_DEPOSIT_AUSD, type WalletBalances } from "./hooks";

// --- address + balances -------------------------------------------------------------------

export function AddressField({ address }: { address: string | null }) {
  const { copied, copy } = useCopy();
  return (
    <div className="field">
      <span className="label">Wallet address</span>
      {address ? (
        <div className="input mono-input input-lg">
          <Wallet aria-hidden />
          <span className="val" title={address}>
            {address}
          </span>
          <IconButton size="sm" icon={copied ? Check : Copy} label={copied ? "Copied" : "Copy address"} onClick={() => void copy(address)} />
          <ButtonAnchor variant="ghost" size="sm" href={explorerAddressUrl(address)} target="_blank" rel="noopener" aria-label="Open in explorer" icon={ExternalLink} />
        </div>
      ) : (
        <Skeleton h={40} />
      )}
      <span className="hint">Monad testnet · chain 10143</span>
    </div>
  );
}

const MON_ENOUGH = 0.05;

/** The two balance tiles (`.bal`). `null` balances render `n/a` and a short reason. */
export function Balances({ balances, loading }: { balances: WalletBalances | undefined; loading: boolean }) {
  const mon = balances?.mon ?? null;
  const ausd = balances?.ausd ?? null;
  const pending = loading && !balances;
  return (
    <div className="bal">
      <div>
        <span className="l">MON for gas</span>
        {pending ? (
          <Skeleton w={96} h={24} />
        ) : (
          <span className="v">
            {mon === null ? <span className="faint">n/a</span> : formatNumber(mon, 3)}
            <span className="u">MON</span>
          </span>
        )}
        {pending ? (
          <Skeleton w={110} h={12} />
        ) : mon === null ? (
          <span className="xs muted">Could not read the balance</span>
        ) : mon >= MON_ENOUGH ? (
          <span className="xs pos row g1">
            <CircleCheck className="i-12" aria-hidden />
            Enough for setup
          </span>
        ) : (
          <span className="xs row g1" style={{ color: "var(--warning-text)" }}>
            <TriangleAlert className="i-12" aria-hidden />
            Not enough for gas yet
          </span>
        )}
      </div>
      <div>
        <span className="l">Test AUSD</span>
        {pending ? (
          <Skeleton w={96} h={24} />
        ) : (
          <span className="v">
            {ausd === null ? <span className="faint">n/a</span> : formatNumber(ausd, 2)}
            <span className="u">AUSD</span>
          </span>
        )}
        {pending ? (
          <Skeleton w={110} h={12} />
        ) : ausd === null ? (
          <span className="xs muted">Could not read the balance</span>
        ) : ausd >= MIN_DEPOSIT_AUSD ? (
          <span className="xs pos row g1">
            <CircleCheck className="i-12" aria-hidden />
            Ready to deposit
          </span>
        ) : (
          <span className="xs muted">Below the {MIN_DEPOSIT_AUSD} AUSD first deposit</span>
        )}
      </div>
    </div>
  );
}

// --- policy -------------------------------------------------------------------------------

/** What the Privy policy lets the Hermes signer do: chain, allowed contracts, approve cap, expiry. */
export function PolicySummary({ policy, mode, extra = [] }: { policy: PolicySummaryDTO; mode: SignerConfigDTO["mode"]; extra?: [ReactNode, ReactNode][] }) {
  const expires = policy.expiresAt ? formatDateTime(policy.expiresAt * 1000) : null;
  return (
    <KeyValue
      className="gap-x-0"
      items={[
        ["Chain", <span key="c" className="mono">Monad testnet · {policy.chainId}</span>],
        ["Perpl exchange", <ExplorerLink key="x" kind="address" value={policy.exchange} />],
        ["AUSD token", <ExplorerLink key="a" kind="address" value={policy.collateralToken} />],
        ["Test AUSD faucet", <ExplorerLink key="f" kind="address" value={policy.faucet} />],
        ["Approve cap", <span key="p" className="mono">{formatNumber(Number(policy.approveCapAusd), 2)} AUSD per approval</span>],
        ["Expires", expires ? <span key="e" className="mono">{expires}</span> : <span key="e">No expiry</span>],
        ["Enforced by", mode === "privy" ? "Privy policy engine" : "Local policy mirror (simulated wallet)"],
        ...extra,
      ]}
    />
  );
}

/** Signer state + the one-click "Allow Hermes to send Perpl setup transactions" (adds the Privy server signer under the policy). */
export function SignerAction({
  config,
  added,
  addressReady,
  onAdded,
  size = "md",
}: {
  config: SignerConfigDTO | undefined;
  added: boolean;
  addressReady: boolean;
  onAdded?: () => void;
  size?: "md" | "lg";
}) {
  const add = useAddHermesSigner();
  const notConfigured = config ? !config.configured : false;
  const run = () => add.mutate(undefined, { onSuccess: () => onAdded?.() });
  return (
    <div className="col g3">
      {added ? (
        <Callout tone="positive">
          <b>Hermes can send Perpl setup transactions.</b> Every one of them goes through the wallet policy below.
        </Callout>
      ) : (
        <>
          {notConfigured && (
            <Callout tone="warning">
              <b>The Hermes signer is not set up on the server.</b> Wallet transactions are unavailable until the server has its Privy key and policy.
            </Callout>
          )}
          {add.isError && (
            <Callout tone="negative">
              <b>Could not add the Hermes signer.</b> {errorMessage(add.error)}
            </Callout>
          )}
          <div>
            <Button variant="secondary" size={size} icon={KeyRound} onClick={run} loading={add.isPending} loadingLabel="Waiting for Privy" disabled={!addressReady || notConfigured || !config}>
              Allow Hermes to send Perpl setup transactions
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// --- policy demo --------------------------------------------------------------------------

/** The bounty proof: sends a forbidden transaction and shows Privy's refusal inline. */
export function PolicyDemo({ disabled }: { disabled?: boolean }) {
  const demo = usePolicyDemo();
  const [variant, setVariant] = useState<"native_transfer" | "approve_other_spender">("native_transfer");
  const res = demo.data;
  return (
    <div className="col g3">
      <div className="row g3" style={{ flexWrap: "wrap" }}>
        <SegmentedControl
          aria-label="Forbidden transaction to try"
          value={variant}
          onChange={setVariant}
          options={[
            { value: "native_transfer", label: "Send MON elsewhere" },
            { value: "approve_other_spender", label: "Approve another spender" },
          ]}
        />
        <Button variant="secondary" icon={ShieldCheck} onClick={() => demo.mutate({ variant })} loading={demo.isPending} loadingLabel="Checking" disabled={disabled}>
          Policy check
        </Button>
      </div>
      {demo.isError && (
        <Callout tone="negative">
          <b>The policy check did not run.</b> {errorMessage(demo.error)}
        </Callout>
      )}
      {res && res.blocked && (
        <Callout tone="warning" icon={OctagonX} aria-live="polite">
          <b>Blocked by your wallet policy:</b> {res.action.error ?? "The transaction was refused before it was signed."}
          <div className="xs muted" style={{ marginTop: 4 }}>
            {res.enforcedBy === "privy" ? "Refused by Privy before signing." : "Refused by the local policy mirror (simulated wallet)."} Nothing was sent.
          </div>
        </Callout>
      )}
      {res && !res.blocked && (
        <Callout tone="negative" aria-live="polite">
          <b>The policy did not block this transaction.</b> Status {res.action.status.replace(/_/g, " ")}. Check the Hermes policy rules in Privy before adding funds.
        </Callout>
      )}
    </div>
  );
}

// --- wallet action rows -------------------------------------------------------------------

export type TxState = "idle" | "waiting" | "pending" | "done" | "failed" | "denied";

const IC_STYLE: Partial<Record<TxState, React.CSSProperties>> = {
  failed: { background: "var(--negative-subtle)", borderColor: "var(--negative-border)", color: "var(--negative-text)" },
  denied: { background: "var(--warning-subtle)", borderColor: "var(--warning-border)", color: "var(--warning-text)" },
};

/** One `.tx` row: status circle, title, meta line, status pill or action button. */
export function TxRow({ n, title, state, meta, pill, action }: { n: number; title: ReactNode; state: TxState; meta?: ReactNode; pill?: ReactNode; action?: ReactNode }) {
  const Icon: LucideIcon | null = state === "done" ? Check : state === "waiting" || state === "pending" ? LoaderCircle : state === "failed" ? X : state === "denied" ? OctagonX : null;
  return (
    <div className="tx" data-state={state === "done" ? "done" : state === "pending" || state === "waiting" ? "pending" : undefined}>
      <span className="ic" style={IC_STYLE[state]}>
        {Icon ? <Icon aria-hidden /> : n}
      </span>
      <div className="col" style={{ minWidth: 0 }}>
        <span className="n">{title}</span>
        {meta && <span className="m">{meta}</span>}
      </div>
      <div className="row g2" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
        {pill}
        {action}
      </div>
    </div>
  );
}

export const ACTION_PILL: Record<WalletActionDTO["status"], ReactNode> = {
  submitted: (
    <span className="pill accent">
      <span className="hm-dot" data-tone="accent" data-live="true" />
      Pending
    </span>
  ),
  confirmed: <StatusPill tone="positive">Confirmed</StatusPill>,
  failed: <StatusPill tone="negative">Failed</StatusPill>,
  denied_by_policy: <StatusPill tone="warning">Refused by policy</StatusPill>,
};

export function txState(a: WalletActionDTO | undefined, running: boolean): TxState {
  if (running) return a?.status === "submitted" && a.txHash ? "pending" : "waiting";
  if (!a) return "idle";
  return a.status === "confirmed" ? "done" : a.status === "submitted" ? "pending" : a.status === "failed" ? "failed" : "denied";
}

/** Meta line for an action row. `idleText` shows while it has not been started. */
export function txMeta(a: WalletActionDTO | undefined, state: TxState, idleText: string, localError?: string | null): ReactNode {
  if (state === "waiting") return "Waiting for Privy to sign";
  if (state === "pending") return a?.txHash ? <>Sent, waiting for a block<ExplorerLink value={a.txHash} /></> : "Waiting for Privy to sign";
  if (state === "done") return <>Confirmed{a?.txHash && <ExplorerLink value={a.txHash} />}</>;
  if (state === "failed") return <span style={{ color: "var(--negative-text)" }}>{a?.error ?? localError ?? "The transaction failed."}</span>;
  if (state === "denied") return <span style={{ color: "var(--warning-text)" }}>Privy refused this transaction. {a?.error ?? ""}</span>;
  if (localError) return <span style={{ color: "var(--negative-text)" }}>{localError}</span>;
  return idleText;
}

// --- Perpl API key form -------------------------------------------------------------------

const KEY_ERRORS: Record<string, string> = {
  perpl_key_rejected: "Perpl rejected this key.",
  perpl_invalid_key_format: "This key is not in the right format.",
  perpl_geo_blocked: "Perpl is not available from this location.",
  perpl_account_not_found: "Perpl does not know this account.",
  perpl_unreachable: "Hermes could not reach Perpl.",
  perpl_timeout: "Perpl did not answer in time.",
};

/** Error callout copy for a failed key save: what happened first, then the server's reason. */
export function KeyError({ error }: { error: unknown }) {
  const code = isApiError(error) ? error.code : "";
  const title = KEY_ERRORS[code] ?? "Could not verify this key.";
  const detail = errorMessage(error);
  const extra = code === "perpl_key_rejected" ? "Check that you copied both parts. It may have expired or been revoked." : null;
  return (
    <Callout tone="negative">
      <b>{title}</b> {detail !== title ? detail : ""} {extra}
    </Callout>
  );
}

export interface KeyFormProps {
  /** Prefill (the account id Perpl showed, or the connected one). */
  accountId?: string | null;
  submitLabel?: string;
  /** Called with the saved connection. */
  onSaved?: (c: PerplConnectionDTO) => void;
  onCancel?: () => void;
  cancelLabel?: string;
}

/** Perpl trade-only key: account id, key id (public part) and private key. Saves with `PUT /api/perpl/connection`. */
export function ApiKeyForm({ accountId, submitLabel = "Verify and continue", onSaved, onCancel, cancelLabel = "Cancel" }: KeyFormProps) {
  const put = usePutPerplConnection();
  const [account, setAccount] = useState(accountId ?? "");
  const [pub, setPub] = useState("");
  const [priv, setPriv] = useState("");
  const [show, setShow] = useState(false);
  const [touched, setTouched] = useState(false);

  const accountErr = touched && !/^\d+$/.test(account.trim()) ? "Enter the account number Perpl shows, digits only." : undefined;
  const pubErr = touched && !pub.trim() ? "Paste the key ID." : undefined;
  const privErr = touched && !priv.trim() ? "Paste the private key." : undefined;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!/^\d+$/.test(account.trim()) || !pub.trim() || !priv.trim()) return;
    put.mutate(
      { accountId: account.trim(), apiKeyPublic: pub.trim(), apiKeyPrivate: priv.trim() },
      {
        onSuccess: (c) => {
          setPriv("");
          setPub("");
          onSaved?.(c);
        },
      },
    );
  };

  return (
    <form className="col g4" onSubmit={submit} noValidate>
      <Input size="lg" mono label="Perpl account ID" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="4821" inputMode="numeric" autoComplete="off" error={accountErr} hint="Shown on Perpl once your account exists." />
      <Input size="lg" mono label="Key ID" value={pub} onChange={(e) => setPub(e.target.value)} placeholder="ak_..." autoComplete="off" spellCheck={false} error={pubErr} />
      <Input
        size="lg"
        mono
        label="Private key"
        icon={KeyRound}
        type={show ? "text" : "password"}
        value={priv}
        onChange={(e) => setPriv(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        error={privErr}
        hint="Stored encrypted on the Hermes server. Never shown again after you save."
        trailing={<IconButton size="sm" icon={show ? EyeOff : Eye} label={show ? "Hide key" : "Show key"} onClick={() => setShow((s) => !s)} />}
      />
      <Callout tone="positive" icon={ShieldCheck}>
        <b>Trade-only keys can open and close positions. They can never withdraw or transfer funds.</b> Perpl enforces this, not Hermes.
      </Callout>
      {put.isError && <KeyError error={put.error} />}
      <div className="row g3" style={{ justifyContent: "flex-end" }}>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={put.isPending}>
            {cancelLabel}
          </Button>
        )}
        <Button type="submit" variant="secondary" size="lg" loading={put.isPending} loadingLabel="Verifying with Perpl">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
