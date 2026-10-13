import { ArrowRight, Check, ChevronLeft, CircleX } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card, CardBody } from "../../components/ui/Card";
import { StatusPill } from "../../components/ui/Badges";
import { Callout } from "../../components/ui/Feedback";
import { usePerplConnection } from "../../lib/queries";
import { formatNumber } from "../../lib/format";
import { PERPL_API_KEYS_URL } from "../wallet/hooks";
import { ApiKeyForm, MetaParts } from "../wallet/parts";
import { ArrowUpRight } from "lucide-react";
import type { StepProps } from "./types";
import { CreateKeyCard } from "./CreateKeyCard";

/** Step 3: paste the Perpl trade-only API key. The server validates it against Perpl before saving. */
export function StepKey({ go, keyDone }: StepProps) {
  const perpl = usePerplConnection();
  const c = perpl.data;
  const [replacing, setReplacing] = useState(false);
  const showForm = !keyDone || replacing;
  const health = c?.health;

  return (
    <>
      <div>
        <h2>Add a trade-only API key</h2>
        <p className="lead">Hermes signs in to Perpl's trading socket with this key to place your orders.</p>
      </div>

      {showForm && c?.mode === "live" && <CreateKeyCard onSaved={() => setReplacing(false)} />}

      <Card>
        <CardBody>
          {c?.mode === "live" && <p className="m" style={{ marginTop: 0 }}>Or create one on Perpl and paste it:</p>}
          <ol className="steps-list">
            <li>
              <span>
                Open{" "}
                <a className="ext" href={PERPL_API_KEYS_URL} target="_blank" rel="noopener">
                  testnet.perpl.xyz/apikeys
                  <ArrowUpRight aria-hidden />
                </a>{" "}
                and sign once with this wallet.
              </span>
            </li>
            <li>
              <span>
                Choose the <b>Trade</b> scope. Add an expiry if you want one.
              </span>
            </li>
            <li>
              <span>Copy the key ID and the private key, then paste them below.</span>
            </li>
          </ol>
        </CardBody>
      </Card>

      {keyDone && c && (
        <Card>
          <div className="tx-list">
            <div className="tx" data-state={c.status === "connected" ? "done" : undefined}>
              <span className="ic" style={c.status === "connected" ? undefined : { color: "var(--negative-text)", borderColor: "var(--negative-border)" }}>
                {c.status === "connected" ? <Check aria-hidden /> : <CircleX aria-hidden />}
              </span>
              <div className="col" style={{ minWidth: 0 }}>
                <span className="n">{c.status === "connected" ? "Signed in to Perpl" : "Key saved, Perpl is not connected"}</span>
                <span className="m">
                  <MetaParts
                    parts={[
                      <>
                        Account <span className="mono">#{c.accountId ?? "n/a"}</span>
                      </>,
                      c.mode === "sim" ? "Simulated" : null,
                      c.collateral !== null ? (
                        <>
                          Collateral <span className="mono">${formatNumber(c.collateral, 2)}</span>
                        </>
                      ) : null,
                      <>
                        Key <span className="mono">{c.apiKeyPublic ?? "n/a"}</span>
                      </>,
                    ]}
                  />
                </span>
                {c.status !== "connected" && (health?.lastError ?? null) && <span className="m" style={{ color: "var(--negative-text)" }}>{health?.lastError}</span>}
              </div>
              {c.status === "connected" ? (
                <StatusPill tone="positive">Verified</StatusPill>
              ) : (
                <StatusPill tone={c.status === "reconnecting" ? "warning" : "negative"}>{c.status === "reconnecting" ? "Reconnecting" : "Disconnected"}</StatusPill>
              )}
            </div>
          </div>
        </Card>
      )}

      {showForm ? (
        <ApiKeyForm
          accountId={c?.accountId}
          onBackToAccount={() => go(2)}
          submitLabel={keyDone ? "Verify and replace" : "Verify and continue"}
          onSaved={() => setReplacing(false)}
          onCancel={keyDone ? () => setReplacing(false) : undefined}
        />
      ) : (
        <Callout tone="positive">
          <b>Trade-only keys can open and close positions. They can never withdraw or transfer funds.</b> Perpl enforces this, not Hermes.{" "}
          <button type="button" className="link" style={{ background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit" }} onClick={() => setReplacing(true)}>
            Replace the key
          </button>
        </Callout>
      )}

      <div className="ob-foot">
        <Button variant="ghost" icon={ChevronLeft} onClick={() => go(2)}>
          Back
        </Button>
        <Button variant="primary" size="lg" disabled={!keyDone || replacing} onClick={() => go(4)}>
          Continue
          <ArrowRight aria-hidden />
        </Button>
      </div>
    </>
  );
}
