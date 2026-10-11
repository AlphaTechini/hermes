import { Check, Copy, Eye, EyeOff, ExternalLink, LockKeyhole, type LucideIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { maskSecret } from "../../lib/format";
import { cn } from "../../lib/cn";
import { Button, ButtonAnchor, IconButton } from "./Button";
import { Field } from "./Field";
import { useCopy } from "./hooks";

export interface CopyFieldProps {
  /** The full value. Copy always copies this, never the truncated or masked display. */
  value?: string;
  /** Async source of the value (e.g. the reveal-secret endpoint). Used on reveal and copy when `value` is missing. */
  loadValue?: () => Promise<string>;
  label?: ReactNode;
  hint?: ReactNode;
  /** Secret field: lock icon, masked with the last 4 characters visible, reveal and copy icon buttons. */
  secret?: boolean;
  /** Masked text to show while hidden. Default: bullets + last 4 of `value`. Pass it when `value` is not loaded yet. */
  maskedPreview?: string;
  /** Leading icon for non-secret fields. */
  icon?: LucideIcon;
  /** Labeled ghost `Copy` button (turns into `Copied` for 1.4 s). Otherwise an icon button. Default: labeled for URLs. */
  labeledCopy?: boolean;
  /** Adds an explorer link button (opens in a new tab). */
  href?: string;
  size?: "md" | "lg";
  /** Rendered after the box, e.g. a `Rotate` button. */
  after?: ReactNode;
  /** Called after a successful copy. */
  onCopied?: () => void;
  /** Show the value text in sans instead of mono. */
  sans?: boolean;
  className?: string;
}

/**
 * Read-only value with copy. Truncates with an ellipsis. Secret mode masks it and offers reveal + copy.
 *   <CopyField label="Webhook URL" value={s.webhookUrl} labeledCopy />
 *   <CopyField secret label="Secret" loadValue={() => reveal(s.id)} maskedPreview="••••••••••••••••••••hx2K" after={<Button>Rotate</Button>} />
 */
export function CopyField({ value, loadValue, label, hint, secret, maskedPreview, icon, labeledCopy, href, size = "md", after, onCopied, sans, className }: CopyFieldProps) {
  const id = useId();
  const { copied, copy } = useCopy();
  const [shown, setShown] = useState(false);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const full = value ?? loaded ?? undefined;
  const masked = maskedPreview ?? (full ? maskSecret(full) : "•".repeat(24));
  const display = secret && !shown ? masked : (full ?? masked);

  const resolve = async (): Promise<string | undefined> => {
    if (full !== undefined) return full;
    if (!loadValue) return undefined;
    setBusy(true);
    try {
      const v = await loadValue();
      setLoaded(v);
      return v;
    } finally {
      setBusy(false);
    }
  };

  const doCopy = async () => {
    const v = await resolve();
    if (v === undefined) return;
    await copy(v);
    onCopied?.();
  };
  const toggle = async () => {
    if (!shown) await resolve();
    setShown((s) => !s);
  };

  const Lead = secret ? LockKeyhole : icon;
  const useLabel = labeledCopy ?? (!secret && !icon);

  return (
    <Field label={label} hint={hint} className={className}>
      <div className="row" style={{ gap: 8 }}>
        <div className={cn("input mono-input", size === "lg" && "input-lg")} style={{ flex: "1 1 auto" }}>
          {Lead && <Lead aria-hidden />}
          <span className="val" id={id} style={sans ? { fontFamily: "var(--font-ui)", fontSize: "inherit" } : undefined} title={secret && !shown ? undefined : full}>
            {display}
          </span>
          {secret && <IconButton size="sm" icon={shown ? EyeOff : Eye} label={shown ? "Hide secret" : "Show secret"} onClick={toggle} disabled={busy} />}
          {href && <ButtonAnchor variant="ghost" size="sm" href={href} target="_blank" rel="noopener" aria-label="Open in explorer" icon={ExternalLink} />}
          {useLabel ? (
            <Button variant="ghost" size="sm" icon={copied ? Check : Copy} onClick={doCopy} disabled={busy}>
              {copied ? "Copied" : "Copy"}
            </Button>
          ) : (
            <IconButton size="sm" icon={copied ? Check : Copy} label={copied ? "Copied" : secret ? "Copy secret" : "Copy"} onClick={doCopy} disabled={busy} />
          )}
        </div>
        {after}
      </div>
    </Field>
  );
}
