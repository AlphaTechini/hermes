import { Check, Copy, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { StrategyDTO, StrategySecretDTO } from "@hermes/shared";
import { errorMessage } from "../../lib/api";
import { useRevealSecret, useRotateSecret } from "../../lib/queries";
import { Button, CodeBlock, ConfirmModal, CopyField, SectionNum, SegmentedControl, useCopy, useToast } from "../../components/ui";

type Kind = "strategy" | "indicator";
const MASK = "••••••••••••";

/**
 * The three "paste into TradingView" fields: webhook URL, secret (masked, reveal, rotate) and the alert message
 * template. The plaintext secret lives only in this component's state (never in the query cache).
 */
export function ConnectBody({ strategy, initial }: { strategy: StrategyDTO; initial?: StrategySecretDTO }) {
  const toast = useToast();
  const reveal = useRevealSecret();
  const rotate = useRotateSecret();
  const [secret, setSecret] = useState<StrategySecretDTO | null>(initial ?? null);
  const [kind, setKind] = useState<Kind>("strategy");
  const [confirm, setConfirm] = useState(false);
  const { copied, copy } = useCopy();
  const requested = useRef<string | null>(initial ? strategy.id : null);

  // Load the secret once per strategy so the masked field can show its last 4 characters.
  useEffect(() => {
    if (requested.current === strategy.id) return;
    requested.current = strategy.id;
    setSecret(null);
    reveal.mutate(strategy.id, { onSuccess: (r) => setSecret(r) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy.id]);

  const loadSecret = async (): Promise<StrategySecretDTO> => {
    if (secret && secret.id === strategy.id) return secret;
    const r = await reveal.mutateAsync(strategy.id);
    setSecret(r);
    return r;
  };

  const masked = secret ? MASK + secret.secret.slice(-4) : MASK;
  const template = strategy.templates[kind];
  const display = template.replace("YOUR_SECRET", masked);

  const copyMessage = async () => {
    try {
      const s = await loadSecret();
      await copy(s.templatesWithSecret[kind]);
    } catch (e) {
      toast.negative("Could not copy the message", errorMessage(e));
    }
  };

  const doRotate = () =>
    rotate.mutate(strategy.id, {
      onSuccess: (r) => {
        setSecret(r);
        setConfirm(false);
        toast.positive("Secret rotated", "Update your TradingView message right after.");
      },
      onError: (e) => toast.negative("Could not rotate the secret", errorMessage(e)),
    });

  return (
    <>
      <SectionNum n={1} title="Webhook URL">
        <CopyField value={strategy.webhookUrl} labeledCopy hint="In the alert's Notifications tab, turn on Webhook URL and paste this. Webhooks need a paid TradingView plan with two-factor authentication." />
      </SectionNum>

      <SectionNum n={2} title="Secret">
        <CopyField
          secret
          value={secret?.secret}
          maskedPreview={secret ? undefined : MASK + "••••••••"}
          loadValue={async () => (await loadSecret()).secret}
          hint="It goes inside the message below. Hermes ignores any alert without it. Rotating stops alerts that still use the old secret."
          after={
            <Button icon={RefreshCw} onClick={() => setConfirm(true)}>
              Rotate
            </Button>
          }
        />
      </SectionNum>

      <SectionNum n={3} title="Message">
        <CodeBlock
          headerLeft={
            <SegmentedControl<Kind>
              size="sm"
              aria-label="Alert type"
              value={kind}
              onChange={setKind}
              options={[
                { value: "strategy", label: "Strategy alert" },
                { value: "indicator", label: "Indicator alert" },
              ]}
            />
          }
          code={display}
          noCopy
          actions={
            <Button size="sm" variant="secondary" icon={copied ? Check : Copy} onClick={copyMessage}>
              {copied ? "Copied" : "Copy message"}
            </Button>
          }
        />
        <p className="hint">
          The copied message includes your real secret. Values in <span className="mono acc">{"{{ }}"}</span> are filled in by TradingView when the alert fires.
          {kind === "strategy" ? (
            <>
              {" "}
              <span className="mono">id</span> must be unique per alert so Hermes can drop repeats.
            </>
          ) : (
            <> Change action to buy, sell or close for each alert.</>
          )}
        </p>
      </SectionNum>

      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Rotate secret?"
        confirmLabel="Rotate"
        confirmIcon={RefreshCw}
        variant="danger"
        loading={rotate.isPending}
        loadingLabel="Rotating"
        onConfirm={doRotate}
      >
        Alerts that still use the old secret will be ignored. Update your TradingView message right after.
      </ConfirmModal>
    </>
  );
}
