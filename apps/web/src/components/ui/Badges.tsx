import type { HTMLAttributes, ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, CircleCheck, CircleDot, CircleX, Copy, Hand, Hourglass, Minus, OctagonX, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import type { OutcomeKind, SideKind } from "../../lib/alert-view";

/** Small counter/label: `<Badge>3</Badge>`, `<Badge mono>mt 25</Badge>`, `<Badge variant="count">2</Badge>` (accent, nav badge). */
export function Badge({ children, mono, variant = "tag", className, ...rest }: { children: ReactNode; mono?: boolean; variant?: "tag" | "count" } & HTMLAttributes<HTMLElement>) {
  if (variant === "count") {
    return (
      <em className={cn("nav-count", className)} style={{ marginLeft: 0, fontStyle: "normal" }} {...rest}>
        {children}
      </em>
    );
  }
  return (
    <span className={cn("tag", mono && "mono", className)} {...rest}>
      {children}
    </span>
  );
}
/** Alias of Badge with the `.tag` look (counts in card titles, ids). */
export const Tag = Badge;

/** `BTC` text chip, 20 high, mono 11/600. `disabled` mutes the text (market not allowed). */
export function MarketChip({ market, disabled, className, ...rest }: { market: string; disabled?: boolean } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("mkt", className)} style={disabled ? { color: "var(--text-muted)" } : undefined} {...rest}>
      {market}
    </span>
  );
}

const SIDE: Record<SideKind, { cls: string; icon: LucideIcon; label: string }> = {
  long: { cls: "long", icon: ArrowUpRight, label: "Long" },
  short: { cls: "short", icon: ArrowDownRight, label: "Short" },
  "close-long": { cls: "secondary", icon: Minus, label: "Close long" },
  "close-short": { cls: "secondary", icon: Minus, label: "Close short" },
  close: { cls: "secondary", icon: Minus, label: "Close" },
};

/**
 * `↗ Long` (positive text), `↘ Short` (negative text), `− Close long` (secondary). Never color alone: always icon + word.
 * Pass `children` to replace the word (`Long 0.050`), `size="xs"` for 12px in tables.
 */
export function SideLabel({ side, children, size, className }: { side: SideKind; children?: ReactNode; size?: "xs"; className?: string }) {
  const s = SIDE[side];
  const Icon = s.icon;
  return (
    <span className={cn("side", s.cls, size === "xs" && "xs", className)}>
      <Icon aria-hidden />
      {children ?? s.label}
    </span>
  );
}

type PillTone = "accent" | "positive" | "negative" | "warning" | "neutral";

const PILL: Record<OutcomeKind, { tone: PillTone; icon: LucideIcon | "live"; label: string }> = {
  in_flight: { tone: "accent", icon: "live", label: "In flight" },
  needs_approval: { tone: "accent", icon: Hand, label: "Needs approval" },
  filled: { tone: "positive", icon: CircleCheck, label: "Filled" },
  partly_filled: { tone: "positive", icon: CircleDot, label: "Partly filled" },
  blocked: { tone: "warning", icon: OctagonX, label: "Blocked" },
  not_filled: { tone: "negative", icon: CircleX, label: "Not filled" },
  rejected: { tone: "negative", icon: CircleX, label: "Rejected by Perpl" },
  ignored: { tone: "neutral", icon: Copy, label: "Ignored" },
  expired: { tone: "neutral", icon: Hourglass, label: "Expired" },
  bad_secret: { tone: "negative", icon: CircleX, label: "Bad secret" },
  invalid: { tone: "negative", icon: CircleX, label: "Invalid message" },
};

export interface StatusPillProps {
  /** One of the alert outcome states. Use `alertOutcome(alert).kind` from lib/alert-view. */
  kind?: OutcomeKind;
  /** Custom pill (decisions, approvals): tone + icon + children. */
  tone?: PillTone;
  icon?: LucideIcon;
  /** Transparent with a border; used in dense tables. */
  outline?: boolean;
  children?: ReactNode;
  className?: string;
  title?: string;
}

/**
 * 22 high pill, subtle tone background, 12px icon + 12/500 text. Every outcome state in DESIGN.md:
 * In flight, Needs approval, Filled, Partly filled, Blocked, Not filled, Rejected by Perpl, Ignored, Expired.
 */
export function StatusPill({ kind, tone, icon, outline, children, className, title }: StatusPillProps) {
  const base = kind ? PILL[kind] : undefined;
  const t = tone ?? base?.tone ?? "neutral";
  const Icon = icon ?? (base && base.icon !== "live" ? base.icon : undefined);
  const live = !icon && base?.icon === "live";
  return (
    <span className={cn("pill", t !== "neutral" && t, outline && "outline", className)} title={title}>
      {live && <span className="hm-dot" data-tone="accent" data-live="true" />}
      {Icon && <Icon aria-hidden />}
      {children ?? base?.label}
    </span>
  );
}

export type ConnectionState = "connected" | "reconnecting" | "offline";
const CONN: Record<ConnectionState, { tone: "positive" | "warning" | "negative"; label: string; live?: boolean }> = {
  connected: { tone: "positive", label: "Connected" },
  reconnecting: { tone: "warning", label: "Reconnecting", live: true },
  offline: { tone: "negative", label: "Offline" },
};

/** Outline pill with a state dot: Connected, Reconnecting (pulsing), Offline. */
export function ConnectionPill({ state, children }: { state: ConnectionState; children?: ReactNode }) {
  const c = CONN[state];
  return (
    <span className="pill outline">
      <span className="hm-dot" data-tone={c.tone} data-live={c.live ? "true" : undefined} />
      {children ?? c.label}
    </span>
  );
}
