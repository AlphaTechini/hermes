import {
  Check,
  ChevronDown,
  CircleCheck,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PerplConnectionDTO, PolicyDemoResponse, PolicySummaryDTO, SignerConfigDTO, WalletActionDTO } from "@hermes/shared";
import { useAddHermesSigner } from "../../auth/hooks";
import { Button, ButtonAnchor, IconButton } from "../../components/ui/Button";
import { Callout } from "../../components/ui/Feedback";
import { Input } from "../../components/ui/Input";
import { ExplorerLink, KeyValue } from "../../components/ui/Misc";
import { SegmentedControl } from "../../components/ui/Segmented";
import { StatusPill } from "../../components/ui/Badges";
import { useCopy } from "../../components/ui/hooks";
import { Skeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/api";
import { explorerAddressUrl, formatDateTime, formatNumber } from "../../lib/format";
import { usePolicyDemo, usePutPerplConnection, useRunWalletAction } from "../../lib/queries";
import { useTxBlock, type WalletBalances } from "./hooks";
import { describeKeyError } from "./key-errors";

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

/** A balance that could not be read: `n/a` at body size (not the 24px KPI size), the reason and a retry. */
function BalanceUnavailable({ onRetry }: { onRetry?: () => void }) {
  return (
    <>
      <span className="faint" style={{ fontSize: 13, lineHeight: "20px" }}>
        n/a
      </span>
      <span className="xs muted row g2" style={{ flexWrap: "wrap" }}>
        Could not read the balance
        {onRetry && (
          <Button variant="ghost" size="sm" icon={RefreshCw} onClick={onRetry}>
            Retry
          </Button>
        )}
      </span>
    </>
  );
}

/**
 * The two balance tiles (`.bal`). `null` balances render a small `n/a`, a short reason and a retry. `minDeposit` is the
 * amount Perpl asks for to open an account (from `GET /api/perpl/context`); `symbol` is the collateral token.
 */
export function Balances({
  balances,
  loading,
  minDeposit = null,
  symbol = "AUSD",
  onRetry,
}: {
  balances: WalletBalances | undefined;
  loading: boolean;
  minDeposit?: number | null;
  symbol?: string;
  onRetry?: () => void;
}) {
  const mon = balances?.mon ?? null;
  const ausd = balances?.ausd ?? null;
  const pending = loading && !balances;
  return (
    <div className="bal">
      <div>
        <span className="l">MON for gas</span>
        {pending ? (
          <>
            <Skeleton w={96} h={24} />
            <Skeleton w={110} h={12} />
          </>
        ) : mon === null ? (
          <BalanceUnavailable onRetry={onRetry} />
        ) : (
          <>
            <span className="v">
              {formatNumber(mon, 3)}
              <span className="u">MON</span>
            </span>
            {mon >= MON_ENOUGH ? (
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
          </>
        )}
      </div>
      <div>
        <span className="l">Test {symbol}</span>
        {pending ? (
          <>
            <Skeleton w={96} h={24} />
            <Skeleton w={110} h={12} />
          </>
        ) : ausd === null ? (
          <BalanceUnavailable onRetry={onRetry} />
        ) : (
          <>
            <span className="v">
              {formatNumber(ausd, 2)}
              <span className="u">{symbol}</span>
            </span>
            {minDeposit === null ? null : ausd >= minDeposit ? (
              <span className="xs pos row g1">
                <CircleCheck className="i-12" aria-hidden />
                Ready to deposit
              </span>
            ) : (
              <span className="xs muted">
                Below the {formatNumber(minDeposit, 0)} {symbol} Perpl asks for to open an account
              </span>
            )}
          </>
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

export type PolicyVariant = "native_transfer" | "approve_other_spender";

/** The bounty proof: sends a forbidden transaction and shows Privy's refusal inline. `onResult` lets a parent mark which checks ran. */
export function PolicyDemo({ disabled, onResult }: { disabled?: boolean; onResult?: (variant: PolicyVariant, res: PolicyDemoResponse) => void }) {
  const demo = usePolicyDemo();
  const [variant, setVariant] = useState<PolicyVariant>("native_transfer");
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
        <Button
          variant="secondary"
          icon={ShieldCheck}
          onClick={() => demo.mutate({ variant }, { onSuccess: (r) => onResult?.(variant, r) })}
          loading={demo.isPending}
          loadingLabel="Checking"
          disabled={disabled}
        >
          Run policy check
        </Button>
      </div>
      {demo.isError && (
        <Callout tone="negative">
          <b>The policy check did not run.</b> {errorMessage(demo.error)}
        </Callout>
      )}
      {res && res.blocked && (
        <Callout tone="positive" icon={ShieldCheck} aria-live="polite">
          <b>Refused by your wallet policy:</b> {res.action.error ?? "The transaction was refused before it was signed."}
          <div className="xs muted" style={{ marginTop: 4 }}>
            {res.enforcedBy === "privy" ? "Refused by Privy before signing." : "Refused by the local policy mirror (simulated wallet)."} Nothing was sent.
          </div>
        </Callout>
      )}
      {res && !res.blocked && (
        <Callout tone="negative" aria-live="polite">
          <b>The policy did not refuse this transaction.</b> Status {res.action.status.replace(/_/g, " ")}. Check the Hermes policy rules in Privy before adding funds.
        </Callout>
      )}
    </div>
  );
}

// --- transaction hash ---------------------------------------------------------------------

/**
 * A transaction hash. Real hashes link to the explorer. Simulated ones (the dev wallet, the Perpl simulator) never reached
 * a chain, so they show the hash with a "Simulated" tag and no link instead of a dead explorer page.
 */
export function TxHash({ hash, simulated }: { hash: string; simulated?: boolean }) {
  return <ExplorerLink value={hash} simulated={simulated} />;
}

// --- wallet action rows -------------------------------------------------------------------

export type TxState = "idle" | "waiting" | "pending" | "done" | "failed" | "denied";

const IC_STYLE: Partial<Record<TxState, React.CSSProperties>> = {
  failed: { background: "var(--negative-subtle)", borderColor: "var(--negative-border)", color: "var(--negative-text)" },
  denied: { background: "var(--warning-subtle)", borderColor: "var(--warning-border)", color: "var(--warning-text)" },
};

/** One `.tx` row: status circle, title, meta line, status pill, and (for the next step only) the action button. */
export function TxRow({ n, title, state, meta, pill, action }: { n: number; title: ReactNode; state: TxState; meta?: ReactNode; pill?: ReactNode; action?: ReactNode }) {
  const Icon: LucideIcon | null = state === "done" ? Check : state === "waiting" || state === "pending" ? LoaderCircle : state === "failed" ? X : state === "denied" ? ShieldAlert : null;
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

/** A wallet-policy refusal is not a Hermes limit block: its own label, a shield icon and a neutral tone (blocks are warning with a stop sign). */
const REFUSED_PILL = (
  <StatusPill tone="neutral" icon={ShieldAlert}>
    Refused by policy
  </StatusPill>
);

export const ACTION_PILL: Record<WalletActionDTO["status"], ReactNode> = {
  submitted: (
    <span className="pill accent">
      <span className="hm-dot" data-tone="accent" data-live="true" />
      Pending
    </span>
  ),
  confirmed: <StatusPill tone="positive">Confirmed</StatusPill>,
  failed: <StatusPill tone="negative">Failed</StatusPill>,
  denied_by_policy: REFUSED_PILL,
};

/** The status pill every transaction row carries: Not started, Waiting for signature, Pending, Confirmed, Failed, Refused by policy. */
export function txPill(state: TxState, optional = false): ReactNode {
  switch (state) {
    case "idle":
      return <StatusPill tone="neutral">{optional ? "Optional" : "Not started"}</StatusPill>;
    case "waiting":
      return (
        <span className="pill accent">
          <span className="hm-dot" data-tone="accent" data-live="true" />
          Waiting for signature
        </span>
      );
    case "pending":
      return ACTION_PILL.submitted;
    case "done":
      return ACTION_PILL.confirmed;
    case "failed":
      return ACTION_PILL.failed;
    case "denied":
      return REFUSED_PILL;
  }
}

export function txState(a: WalletActionDTO | undefined, running: boolean): TxState {
  if (running) return a?.status === "submitted" && a.txHash ? "pending" : "waiting";
  if (!a) return "idle";
  return a.status === "confirmed" ? "done" : a.status === "submitted" ? "pending" : a.status === "failed" ? "failed" : "denied";
}

const NoWrap = ({ children }: { children: ReactNode }) => <span style={{ whiteSpace: "nowrap" }}>{children}</span>;

/** Joins meta parts with ` · `. The separator trails the part before it (nowrap), so a wrapped line never starts with one. */
export function MetaParts({ parts }: { parts: ReactNode[] }) {
  const list = parts.filter(Boolean);
  return (
    <>
      {list.map((p, i) => (
        <span key={i}>
          {i > 0 && " "}
          <NoWrap>
            {p}
            {i < list.length - 1 && "\u00a0·"}
          </NoWrap>
        </span>
      ))}
    </>
  );
}

function TxMeta({ a, state, idleText, localError }: { a: WalletActionDTO | undefined; state: TxState; idleText: string; localError?: string | null }) {
  const block = useTxBlock(a?.txHash, a?.simulated);
  const hash = a?.txHash ? <TxHash key="h" hash={a.txHash} simulated={a.simulated} /> : null;
  if (state === "waiting") return <>Waiting for Privy to sign</>;
  if (state === "pending") return a?.txHash ? <MetaParts parts={["Sent, waiting for a block", hash]} /> : <>Waiting for Privy to sign</>;
  if (state === "done") {
    const n = block.data;
    return <MetaParts parts={[n ? `Confirmed in block ${formatNumber(n, 0)}` : "Confirmed", hash]} />;
  }
  if (state === "failed") return <span style={{ color: "var(--negative-text)" }}>{a?.error ?? localError ?? "The transaction failed."}</span>;
  if (state === "denied") return <span style={{ color: "var(--warning-text)" }}>Privy refused this transaction. {a?.error ?? ""}</span>;
  if (localError) return <span style={{ color: "var(--negative-text)" }}>{localError}</span>;
  return <>{idleText}</>;
}

/** Meta line for an action row. `idleText` shows while it has not been started. */
export function txMeta(a: WalletActionDTO | undefined, state: TxState, idleText: string, localError?: string | null): ReactNode {
  return <TxMeta a={a} state={state} idleText={idleText} localError={localError} />;
}

// --- disclosure ---------------------------------------------------------------------------

/** Ghost sm toggle that expands its content inline ("See the policy", "More options", "Advanced: account ID"). */
export function Disclosure({ label, children, open: openProp, onOpenChange, id }: { label: ReactNode; children: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void; id: string }) {
  const [inner, setInner] = useState(false);
  const open = openProp ?? inner;
  const set = (v: boolean) => (onOpenChange ? onOpenChange(v) : setInner(v));
  return (
    <div className="col g3">
      <div>
        <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={id} onClick={() => set(!open)}>
          {label}
          <ChevronDown aria-hidden style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform 120ms" }} />
        </Button>
      </div>
      <div id={id} hidden={!open}>
        {open ? children : null}
      </div>
    </div>
  );
}

// --- Perpl API key form -------------------------------------------------------------------

export interface KeyFormProps {
  /** The connected account, when there is one. Shown as a hint in Advanced, never sent unless typed. */
  accountId?: string | null;
  submitLabel?: string;
  /** Called with the saved connection. */
  onSaved?: (c: PerplConnectionDTO) => void;
  onCancel?: () => void;
  cancelLabel?: string;
  /** Offered when Perpl has no account for this wallet yet. */
  onBackToAccount?: () => void;
}

type KeyBody = { apiKeyPublic: string; apiKeyPrivate: string; accountId?: string };

/**
 * Perpl trade-only key: key ID (public part) and private key. The account ID is optional and tucked under "Advanced":
 * when it is left out the server finds the account from the key, then from the wallet. Saves with `PUT /api/perpl/connection`.
 * Every server failure code has its own copy (see `describeKeyError`); a switched-off order forwarding offers the action that fixes it.
 */
export function ApiKeyForm({ accountId, submitLabel = "Verify and continue", onSaved, onCancel, cancelLabel = "Cancel", onBackToAccount }: KeyFormProps) {
  const put = usePutPerplConnection();
  const allow = useRunWalletAction();
  const [account, setAccount] = useState("");
  const [pub, setPub] = useState("");
  const [priv, setPriv] = useState("");
  const [show, setShow] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [touched, setTouched] = useState(false);
  const [serverField, setServerField] = useState<"privateKey" | "keyId" | "accountId" | null>(null);
  const [allowNote, setAllowNote] = useState<string | null>(null);
  const sent = useRef<KeyBody | null>(null);

  const accountErr = account.trim() && !/^\d+$/.test(account.trim()) ? "Digits only, as Perpl shows it." : serverField === "accountId" ? "Check the account ID." : undefined;
  const pubErr = touched && !pub.trim() ? "Paste the key ID." : undefined;
  const privErr = touched && !priv.trim() ? "Paste the private key." : serverField === "privateKey" ? "Check the private key." : undefined;

  const copy = put.isError ? describeKeyError(put.error, { accountSupplied: Boolean(sent.current?.accountId) }) : null;
  useEffect(() => {
    if (!copy) return;
    setServerField(copy.field ?? null);
    if (copy.openAccountId) setAdvanced(true);
  }, [copy?.code, put.failureCount, put.submittedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (body: KeyBody) => {
    sent.current = body;
    setAllowNote(null);
    put.mutate(body, {
      onSuccess: (c) => {
        setPriv("");
        setPub("");
        onSaved?.(c);
      },
    });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!pub.trim() || !priv.trim() || (account.trim() && !/^\d+$/.test(account.trim()))) {
      if (account.trim() && !/^\d+$/.test(account.trim())) setAdvanced(true);
      return;
    }
    save({ apiKeyPublic: pub.trim(), apiKeyPrivate: priv.trim(), ...(account.trim() ? { accountId: account.trim() } : {}) });
  };

  const allowForwarding = () => {
    setAllowNote(null);
    allow.mutate(
      { kind: "allow_forwarding" },
      {
        onSuccess: (a) => {
          if (a.status === "confirmed" && sent.current) save(sent.current);
          else if (a.status === "denied_by_policy") setAllowNote("Privy refused this transaction. Open the Wallet page to see the policy.");
          else if (a.status === "failed") setAllowNote(a.error ?? "The transaction failed. Try again.");
          else setAllowNote("Sent. Verify the key again once the transaction confirms.");
        },
      },
    );
  };

  return (
    <form className="col g4" onSubmit={submit} noValidate>
      <Input
        size="lg"
        mono
        label="Key ID"
        value={pub}
        onChange={(e) => setPub(e.target.value)}
        placeholder="ak_..."
        autoComplete="off"
        spellCheck={false}
        error={pubErr}
      />
      <Input
        size="lg"
        mono
        label="Private key"
        icon={KeyRound}
        type={show ? "text" : "password"}
        value={priv}
        onChange={(e) => {
          setPriv(e.target.value);
          if (serverField === "privateKey") setServerField(null);
        }}
        autoComplete="off"
        spellCheck={false}
        error={privErr}
        hint="Stored encrypted on the Hermes server. Never shown again after you save."
        trailing={<IconButton size="sm" icon={show ? EyeOff : Eye} label={show ? "Hide key" : "Show key"} onClick={() => setShow((s) => !s)} />}
      />
      <Disclosure id="perpl-account-id" label="Advanced: account ID" open={advanced} onOpenChange={setAdvanced}>
        <Input
          size="lg"
          mono
          label="Perpl account ID"
          value={account}
          onChange={(e) => {
            setAccount(e.target.value);
            if (serverField === "accountId") setServerField(null);
          }}
          placeholder={accountId ?? "4821"}
          inputMode="numeric"
          autoComplete="off"
          error={accountErr}
          hint={`Optional. Leave it empty and Hermes finds your account from the key and your wallet.${accountId ? ` Connected now: #${accountId}.` : ""}`}
        />
      </Disclosure>
      <Callout tone="positive" icon={ShieldCheck}>
        <b>Trade-only keys can open and close positions. They can never withdraw or transfer funds.</b> Perpl enforces this, not Hermes.
      </Callout>
      {copy && (
        <Callout tone={copy.tone} aria-live="polite">
          <b>{copy.title}</b> {copy.body}
          {copy.action === "allow_forwarding" && (
            <div style={{ marginTop: 8 }}>
              <Button variant="secondary" size="sm" icon={KeyRound} onClick={allowForwarding} loading={allow.isPending} loadingLabel="Waiting for Privy">
                Allow order forwarding
              </Button>
            </div>
          )}
          {copy.action === "back_to_account" && onBackToAccount && (
            <div style={{ marginTop: 8 }}>
              <Button variant="secondary" size="sm" onClick={onBackToAccount}>
                Open your Perpl account
              </Button>
            </div>
          )}
          {allow.isError && (
            <div className="xs" style={{ marginTop: 8, color: "var(--negative-text)" }}>
              Could not send the transaction. {errorMessage(allow.error)}
            </div>
          )}
          {allowNote && (
            <div className="xs muted" style={{ marginTop: 8 }}>
              {allowNote}
            </div>
          )}
        </Callout>
      )}
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
