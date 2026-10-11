import { cn } from "../../lib/cn";

export type MeterTone = "ok" | "accent" | "warning" | "negative" | "positive";

export interface MeterProps {
  /** Current usage. */
  value: number;
  /** Limit (default 100). */
  max?: number;
  /** Fixed tone. Omit to derive: under 80% neutral, 80 to 99% warning, 100% negative. */
  tone?: MeterTone;
  /** A 1px tick at this fraction of max (0..1), e.g. 0.8 for the warning threshold. */
  threshold?: number;
  /** 6px instead of 4px. */
  size?: "md" | "lg";
  className?: string;
  "aria-label"?: string;
  width?: number | string;
}

export const meterToneFor = (value: number, max: number): MeterTone => {
  const r = max > 0 ? value / max : 0;
  return r >= 1 ? "negative" : r >= 0.8 ? "warning" : "ok";
};

/**
 * Track `--border`, fill by tone. Always pair it with numbers (`$137.20 / $500`).
 * Countdown meters use `tone="accent"` and switch to warning under 60 s.
 */
export function Meter({ value, max = 100, tone, threshold, size = "md", className, width, ...aria }: MeterProps) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const t = tone ?? meterToneFor(value, max);
  return (
    <span
      className={cn("meter", size === "lg" && "meter-lg", className)}
      data-tone={t}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
      aria-label={aria["aria-label"]}
      style={width !== undefined ? { width } : undefined}
    >
      <i style={{ width: `${pct}%` }} />
      {threshold !== undefined && <span className="tick" style={{ left: `${threshold * 100}%` }} />}
    </span>
  );
}
