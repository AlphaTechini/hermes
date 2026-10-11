import { CircleCheck, CircleX, Info, LoaderCircle, TriangleAlert, type LucideIcon } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export type Tone = "neutral" | "accent" | "positive" | "warning" | "negative";

const CALLOUT_ICON: Record<Tone, LucideIcon> = { neutral: Info, accent: Info, positive: CircleCheck, warning: TriangleAlert, negative: CircleX };

/**
 * Padding 12/14, radius 8. Put the key sentence in `<b>`: `<Callout tone="warning"><b>Daily loss stop reached.</b> New orders...</Callout>`.
 * Tones: neutral, accent (info), positive (safety, success), warning (a limit acted), negative (errors).
 */
export function Callout({ tone = "neutral", icon, children, className, ...rest }: { tone?: Tone; icon?: LucideIcon | null; children: ReactNode } & Omit<HTMLAttributes<HTMLDivElement>, "children">) {
  const Icon = icon === null ? null : (icon ?? CALLOUT_ICON[tone]);
  return (
    <div className={cn("callout", tone !== "neutral" && tone, className)} role={tone === "negative" ? "alert" : undefined} {...rest}>
      {Icon && <Icon aria-hidden />}
      <div>{children}</div>
    </div>
  );
}

/**
 * Full-width system banner under the top bar: Perpl socket reconnecting, daily loss stop, trading paused.
 * `tone="warning"` (default) or `"negative"`. `action` is usually a ghost sm Button.
 */
export function Banner({ tone = "warning", icon, children, action, className }: { tone?: "warning" | "negative"; icon?: LucideIcon; children: ReactNode; action?: ReactNode; className?: string }) {
  const Icon = icon ?? TriangleAlert;
  return (
    <div className={cn("banner", tone === "negative" && "negative", className)} role="status">
      <Icon aria-hidden />
      <span>{children}</span>
      {action && <span style={{ marginLeft: "auto" }}>{action}</span>}
    </div>
  );
}

/** Centered empty or error state: 40px icon tile, title 14/600, body 13/20 (max 380), up to two actions. */
export function EmptyState({ icon: Icon, title, children, actions, tone, className, compact }: { icon: LucideIcon; title: ReactNode; children?: ReactNode; actions?: ReactNode; tone?: "negative"; className?: string; compact?: boolean }) {
  return (
    <div className={cn("empty", className)} style={compact ? { padding: "24px 12px" } : undefined}>
      <div className="empty-icon" style={tone === "negative" ? { color: "var(--negative-text)" } : undefined}>
        <Icon aria-hidden />
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

/** Spinning `loader-circle`. Inherits `currentColor`. */
export function Spinner({ size = 16, className, label }: { size?: number; className?: string; label?: string }) {
  return <LoaderCircle className={cn("hm-spin", className)} width={size} height={size} role={label ? "status" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}
