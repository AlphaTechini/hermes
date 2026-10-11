import { CircleCheck, Link2Off, OctagonX, RefreshCw, Wallet } from "lucide-react";
import { useState } from "react";
import type { PerplLinkStatus, WalletActionDTO } from "@hermes/shared";
import { useAuth } from "../../auth/context";
import { useEmbeddedWallet } from "../../auth/hooks";
import { PageHeader } from "../../components/shell/PageHeader";
import { Tag } from "../../components/ui/Badges";
import { Button, ButtonLink } from "../../components/ui/Button";
import { Card, CardBody, CardFooter, CardHeader } from "../../components/ui/Card";
import { DataTable } from "../../components/ui/DataTable";
import { Callout, EmptyState } from "../../components/ui/Feedback";
import { ChecksList, ExplorerLink, KeyValue } from "../../components/ui/Misc";
import { ConfirmModal, Drawer } from "../../components/ui/Overlay";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useDelayedFlag } from "../../components/ui/hooks";
import { errorMessage } from "../../lib/api";
import { formatDateTime, formatTableTime, formatUsd } from "../../lib/format";
import { PAGE } from "../../lib/routes";
import { useDeletePerplConnection, usePerplConnection, usePrivyWallet, useSignerConfig, useWalletActions } from "../../lib/queries";
import { MON_FAUCET_URL, useWalletBalances } from "./hooks";
import { ACTION_PILL, AddressField, ApiKeyForm, Balances, PolicyDemo, PolicySummary, SignerAction } from "./parts";

const LINK_PILL: Record<PerplLinkStatus, { tone: "positive" | "warning" | "negative" | "neutral"; label: string; live?: boolean }> = {
  connected: { tone: "positive", label: "Connected" },
  reconnecting: { tone: "warning", label: "Reconnecting", live: true },
  disconnected: { tone: "negative", label: "Disconnected" },
  not_configured: { tone: "neutral", label: "Not connected" },
};

function LinkPill({ status }: { status: PerplLinkStatus }) {
  const p = LINK_PILL[status];
  return (
    <span className="pill outline">
      <span className="hm-dot" data-tone={p.tone === "neutral" ? undefined : p.tone} data-live={p.live ? "true" : undefined} />
      {p.label}
    </span>
  );
}

function WalletCard() {
  const { user } = useAuth();
  const wallet = useEmbeddedWallet();
  const address = wallet.address ?? user?.walletAddress ?? null;
  const privy = usePrivyWallet();
  const cfg = useSignerConfig();
  const bal = useWalletBalances(address, cfg.data?.policy.collateralToken);
  return (
    <Card className="span-7">
      <CardHeader title="Embedded wallet" meta="Created by Privy at sign in" actions={privy.data?.simulated ? <Tag>Simulated</Tag> : undefined} />
      <CardBody>
        <AddressField address={address} />
      </CardBody>
      <Balances balances={bal.data} loading={bal.isLoading} />
      <CardFooter>
        <span>Balances refresh every block.</span>
        <a className="ext xs" href={MON_FAUCET_URL} target="_blank" rel="noopener" style={{ marginLeft: "auto" }}>
          Get MON at faucet.monad.xyz
        </a>
      </CardFooter>
    </Card>
  );
}

function PerplCard() {
  const perpl = usePerplConnection();
  const del = useDeletePerplConnection();
  const toast = useToast();
  const [replace, setReplace] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const c = perpl.data;
  const loading = useDelayedFlag(perpl.isLoading);
  const health = c?.health;

  return (
    <Card className="span-5">
      <CardHeader title="Perpl connection" actions={c ? <LinkPill status={c.status} /> : undefined} />
      {perpl.isError ? (
        <EmptyState icon={Link2Off} tone="negative" title="Could not load the connection" compact actions={<Button size="sm" variant="primary" onClick={() => void perpl.refetch()}>Retry</Button>}>
          Hermes did not respond.
        </EmptyState>
      ) : perpl.isLoading ? (
        loading ? (
          <CardBody className="col g3">
            <Skeleton h={16} />
            <Skeleton h={16} />
            <Skeleton h={16} />
          </CardBody>
        ) : null
      ) : !c?.configured ? (
        <EmptyState icon={Link2Off} title="No Perpl connection" compact actions={<ButtonLink to="/onboarding?step=3" size="sm" variant="primary">Connect Perpl</ButtonLink>}>
          Add a trade-only API key so Hermes can place orders.
        </EmptyState>
      ) : (
        <>
          <CardBody className="col g3">
            <KeyValue
              className="gap-x-0"
              items={[
                ["Account ID", <span key="a" className="mono">#{c.accountId ?? "n/a"}</span>],
                ["API key ID", <span key="k" className="mono" title={c.apiKeyPublic ?? undefined}>{c.apiKeyPublic ?? "n/a"}</span>],
                ["Scope", "Trade only. Cannot withdraw."],
                ["Collateral", c.collateral === null ? <span key="c" className="faint">n/a</span> : <span key="c" className="mono">{formatUsd(c.collateral)}</span>],
                ["Mode", c.mode === "sim" ? "Simulated Perpl" : "Perpl testnet"],
                ["Connected since", <span key="s" className="mono">{formatDateTime(c.createdAt)}</span>],
              ]}
            />
            {c.status !== "connected" && health?.lastError && (
              <Callout tone={c.status === "reconnecting" ? "warning" : "negative"}>
                <b>{c.status === "reconnecting" ? "Reconnecting to Perpl." : "Perpl is not connected."}</b> {health.lastError}
              </Callout>
            )}
          </CardBody>
          <CardFooter>
            <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => setReplace(true)}>
              Replace key
            </Button>
            <Button size="sm" variant="danger" icon={Link2Off} onClick={() => setConfirm(true)}>
              Disconnect
            </Button>
          </CardFooter>
        </>
      )}

      <Drawer open={replace} onClose={() => setReplace(false)} title="Replace the Perpl API key">
        <div className="col g4">
          <p className="secondary" style={{ fontSize: 13, lineHeight: "20px" }}>
            Create a new trade-only key at{" "}
            <a className="link" href="https://testnet.perpl.xyz/apikeys" target="_blank" rel="noopener">
              testnet.perpl.xyz/apikeys
            </a>
            , then paste it here. Hermes checks it with Perpl before it replaces the old one.
          </p>
          <ApiKeyForm
            accountId={c?.accountId}
            submitLabel="Verify and replace"
            onCancel={() => setReplace(false)}
            onSaved={() => {
              setReplace(false);
              toast.positive("API key replaced", "Hermes signed in to Perpl with the new key.");
            }}
          />
        </div>
      </Drawer>
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Disconnect Perpl?"
        confirmLabel="Disconnect"
        variant="danger"
        loading={del.isPending}
        loadingLabel="Disconnecting"
        onConfirm={() =>
          del.mutate(undefined, {
            onSuccess: () => {
              setConfirm(false);
              toast.positive("Perpl disconnected", "The stored API key was deleted. New alerts are blocked until you connect again.");
            },
            onError: (e) => toast.negative("Could not disconnect", errorMessage(e)),
          })
        }
      >
        Hermes deletes the stored API key and stops placing orders. Open positions stay open on Perpl. New alerts are logged as blocked until you connect again.
      </ConfirmModal>
    </Card>
  );
}

function SignerCard() {
  const cfg = useSignerConfig();
  const privy = usePrivyWallet();
  const actions = useWalletActions();
  const { user } = useAuth();
  const wallet = useEmbeddedWallet();
  const address = wallet.address ?? user?.walletAddress ?? null;
  const added = Boolean(privy.data?.signerAddedAt);
  const denied = actions.data?.filter((a) => a.status === "denied_by_policy") ?? [];
  const last = denied[0];
  const week = Date.now() - 7 * 86_400_000;
  const recent = denied.filter((a) => a.createdAt >= week).length;

  return (
    <Card className="span-7">
      <CardHeader
        title="Hermes signer and policy"
        meta="Enforced by Privy on every transaction"
        actions={
          <span className={`pill ${added ? "positive" : "warning"}`}>
            {added ? "Signer added" : "Signer not added"}
          </span>
        }
      />
      <CardBody className="col g4">
        {!added && (
          <>
            <p className="secondary" style={{ fontSize: 13, lineHeight: "20px" }}>
              Hermes needs your permission to send Perpl setup transactions from its server. Privy only lets it do what the policy below allows.
            </p>
            <SignerAction config={cfg.data} added={added} addressReady={Boolean(address)} />
          </>
        )}
        {cfg.isError ? (
          <Callout tone="negative">
            <b>Could not load the policy.</b> {errorMessage(cfg.error)}
          </Callout>
        ) : cfg.data ? (
          <PolicySummary
            policy={cfg.data.policy}
            mode={cfg.data.mode}
            extra={
              added && privy.data
                ? [
                    ["Signer added", <span key="a" className="mono">{formatDateTime(privy.data.signerAddedAt)}</span>],
                    ["Policy", <span key="p" className="mono" title={privy.data.policyId ?? undefined}>{privy.data.policyId ?? "n/a"}</span>],
                    [
                      "Last refusal",
                      last ? (
                        <span key="l">
                          <span className="mono">{formatDateTime(last.createdAt)}</span> · {recent} in 7 days
                        </span>
                      ) : (
                        <span key="l" className="muted">None yet</span>
                      ),
                    ],
                  ]
                : []
            }
          />
        ) : (
          <Skeleton h={140} />
        )}
      </CardBody>
    </Card>
  );
}

function PolicyCheckCard() {
  return (
    <Card className="span-5">
      <CardHeader title="Policy check" meta="Proof, not a setting" />
      <CardBody className="col g4">
        <p className="secondary" style={{ fontSize: 13, lineHeight: "20px" }}>
          Hermes sends a transaction the policy must refuse, such as moving MON to another address. If Privy blocks it, no one can move your funds that way.
        </p>
        <PolicyDemo />
      </CardBody>
      <ChecksList
        icons={{ pass: CircleCheck, fail: OctagonX, skip: CircleCheck }}
        items={[
          { state: "pass", name: "Sending MON to any address", detail: "Refused. Native transfers are never allowed.", value: "Blocked" },
          { state: "pass", name: "Approving AUSD to any other spender", detail: "Refused. Only the Perpl exchange may be approved.", value: "Blocked" },
          { state: "pass", name: "Calling any other contract", detail: "Refused. Only the exchange, AUSD and the faucet are allowed.", value: "Blocked" },
          { state: "pass", name: "Any transaction after the policy expires", detail: "Refused by Privy before it is signed.", value: "Blocked" },
        ]}
      />
    </Card>
  );
}

function ActionsTable() {
  const actions = useWalletActions(50);
  const loading = useDelayedFlag(actions.isLoading);
  return (
    <Card>
      <CardHeader title="Wallet actions" meta={actions.data ? <Tag>{actions.data.length}</Tag> : undefined} />
      {actions.isError ? (
        <EmptyState icon={Wallet} tone="negative" title="Could not load wallet actions" actions={<Button size="sm" variant="primary" onClick={() => void actions.refetch()}>Retry</Button>}>
          Hermes did not respond.
        </EmptyState>
      ) : (
        <DataTable<WalletActionDTO>
          aria-label="Wallet actions"
          rows={actions.data ?? []}
          rowKey={(a) => a.id}
          loading={loading && actions.isLoading}
          density="two-line"
          empty={
            actions.isLoading ? null : (
              <EmptyState icon={Wallet} title="No wallet actions yet" actions={<ButtonLink to="/onboarding" size="sm" variant="primary">Open setup</ButtonLink>}>
                Faucet requests, approvals and account creation show up here with a link to the explorer.
              </EmptyState>
            )
          }
          columns={[
            { key: "t", header: "Time", mono: true, hideSm: true, cell: (a) => formatTableTime(a.createdAt) },
            {
              key: "d",
              header: "Action",
              wrap: true,
              cell: (a) => (
                <div className="col" style={{ gap: 2, overflowWrap: "anywhere", minWidth: 200 }}>
                  <span>
                    {a.description}
                    {a.simulated && (
                      <>
                        {" "}
                        <Tag>Simulated</Tag>
                      </>
                    )}
                  </span>
                  <span className="row g2 md:hidden" style={{ flexWrap: "wrap" }}>
                    {ACTION_PILL[a.status]}
                    {a.txHash && <ExplorerLink value={a.txHash} />}
                  </span>
                  {a.error && (
                    <span style={{ fontSize: 11, lineHeight: "16px", color: a.status === "denied_by_policy" ? "var(--warning-text)" : "var(--negative-text)" }}>{a.error}</span>
                  )}
                </div>
              ),
            },
            { key: "s", header: "Status", hideSm: true, cell: (a) => ACTION_PILL[a.status] },
            { key: "h", header: "Transaction", hideSm: true, cell: (a) => (a.txHash ? <ExplorerLink value={a.txHash} /> : <span className="faint">n/a</span>) },
          ]}
        />
      )}
      <CardFooter>
        <span>Every action goes through your wallet policy. Times in your local zone.</span>
      </CardFooter>
    </Card>
  );
}

/** Wallet and keys: the embedded wallet, the Hermes signer under its Privy policy, the Perpl API key and every wallet action. */
export function WalletPage() {
  return (
    <>
      <PageHeader {...PAGE.wallet} />
      <div className="grid-12" style={{ gap: 16, marginBottom: 16 }}>
        <WalletCard />
        <PerplCard />
      </div>
      <div className="grid-12" style={{ gap: 16, marginBottom: 16 }}>
        <SignerCard />
        <PolicyCheckCard />
      </div>
      <ActionsTable />
    </>
  );
}
