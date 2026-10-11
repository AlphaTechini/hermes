import type { ElementType, HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Skeleton } from "./Skeleton";

/** `bg-surface`, 1px subtle border, radius 8, shadow-1. */
export function Card({ as: As = "section", className, ...rest }: { as?: ElementType } & HTMLAttributes<HTMLElement>) {
  return <As className={cn("card", className)} {...rest} />;
}
/** Alias: a Card used as a layout panel. */
export const Panel = Card;

interface CardHeaderProps {
  title: ReactNode;
  /** 12px muted text right after the title (`Last changed 9 Oct`). */
  meta?: ReactNode;
  /** Right-aligned actions (buttons, segmented control). */
  actions?: ReactNode;
  /** No bottom hairline (when the body directly follows with its own spacing). */
  flush?: boolean;
  className?: string;
}

/** Min 44 high, padding 8/16, title 13/600 nowrap. Wraps on narrow widths. */
export function CardHeader({ title, meta, actions, flush, className }: CardHeaderProps) {
  return (
    <div className={cn("card-head", flush && "flush", className)}>
      <span className="card-title">{title}</span>
      {meta !== undefined && <span className="card-meta">{meta}</span>}
      {actions !== undefined && <div className="actions">{actions}</div>}
    </div>
  );
}

export const CardBody = ({ className, ...rest }: HTMLAttributes<HTMLDivElement>) => <div className={cn("card-body", className)} {...rest} />;
/** Min 40, padding 10/16, 12 muted, top hairline. */
export const CardFooter = ({ className, ...rest }: HTMLAttributes<HTMLDivElement>) => <div className={cn("card-foot", className)} {...rest} />;

// --- KPI ------------------------------------------------------------------------------

export interface KpiTileProps {
  label: ReactNode;
  /** The value. Strings render in Geist sans 24/500 with proportional figures. */
  value?: ReactNode;
  /** Muted 14px unit after the value: `ms`, `%`, `bps`. */
  unit?: ReactNode;
  /** Sub-line: 12 muted. Use <KpiDelta> for an arrow + mono delta. */
  sub?: ReactNode;
  /** `mono` sets the value in Geist Mono 22px (prices on alert detail). */
  mono?: boolean;
  /** `sm` is the 20/28 value used inside strategy detail. */
  size?: "md" | "sm";
  /** Semantic color for the value. */
  tone?: "positive" | "negative" | "warning";
  icon?: ReactNode;
  /** Show the skeleton instead (label 12, value 24, sub 12 high). Use with `useDelayedFlag`. */
  loading?: boolean;
  className?: string;
}

export function KpiTile({ label, value, unit, sub, mono, size = "md", tone, icon, loading, className }: KpiTileProps) {
  if (loading) {
    return (
      <div className={cn("kpi", className)}>
        <Skeleton w={72} h={12} />
        <Skeleton w={96} h={24} style={{ marginTop: 4 }} />
        <Skeleton w={120} h={12} />
      </div>
    );
  }
  const toneCls = tone === "positive" ? "pos" : tone === "negative" ? "neg" : tone === "warning" ? "warn" : undefined;
  return (
    <div className={cn("kpi", className)}>
      <div className="kpi-label">
        {icon}
        {label}
      </div>
      <div
        className={cn("kpi-value", toneCls, mono && "mono")}
        style={{ ...(size === "sm" ? { fontSize: 20, lineHeight: "28px" } : null), ...(mono ? { fontSize: 22, letterSpacing: 0 } : null) }}
      >
        {value}
        {unit !== undefined && <span className="u">{unit}</span>}
      </div>
      {sub !== undefined && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

/** Mono delta with an arrow for a KpiTile sub-line: `<KpiDelta tone="positive" icon={<ArrowDown/>}>38 ms faster</KpiDelta>`. */
export function KpiDelta({ tone = "neutral", icon, children }: { tone?: "positive" | "negative" | "warning" | "neutral"; icon?: ReactNode; children: ReactNode }) {
  const cls = tone === "positive" ? "pos" : tone === "negative" ? "neg" : tone === "warning" ? "warn" : "secondary";
  return (
    <span className={cn("row", cls)} style={{ gap: 4 }}>
      {icon}
      <span className="d">{children}</span>
    </span>
  );
}

/** One bordered strip holding the tiles, separated by 1px dividers. `cols` 4 (dashboard), 3 (report), 6. 2 per row on mobile. */
export function KpiRow({ cols = 4, className, children, ...rest }: { cols?: 3 | 4 | 6 } & HTMLAttributes<HTMLElement>) {
  return (
    <section className={cn("kpis", cols === 6 && "k6", cols === 3 && "k3", className)} {...rest}>
      {children}
    </section>
  );
}
