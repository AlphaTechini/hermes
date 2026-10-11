import { useId, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useContainerWidth } from "./hooks";

/**
 * Hand-rolled SVG charts. Each one measures its container with a ResizeObserver and draws at that exact pixel width
 * (no viewBox scaling), so 11px labels stay 11px. One y axis, hairline solid grid, 2px lines, bars at most 24px wide
 * with 3px rounded tops, text in text tokens (see DESIGN.md section 10.8 and the dataviz rules).
 */

const niceMax = (v: number, steps = 4): { max: number; ticks: number[] } => {
  if (v <= 0) return { max: steps, ticks: Array.from({ length: steps + 1 }, (_, i) => i) };
  const raw = v / steps;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const max = Math.ceil(v / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= max + step / 2; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return { max, ticks };
};

// --- Sparkline ---------------------------------------------------------------------------

export interface SparklineProps {
  values: number[];
  height?: number;
  /** `primary` accent (the one data series), `muted` for de-emphasis. */
  tone?: "primary" | "muted";
  /** Soft wash under the line. */
  wash?: boolean;
  className?: string;
  "aria-label"?: string;
}

/** Axis-free trend line that fills its container's width. Last point is marked with a dot. */
export function Sparkline({ values, height = 28, tone = "primary", wash, className, ...aria }: SparklineProps) {
  const [ref, w] = useContainerWidth<HTMLDivElement>();
  const pad = 3;
  const n = values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const X = (i: number) => pad + (n <= 1 ? 0 : (i / (n - 1)) * Math.max(0, w - pad * 2));
  const Y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const d = values.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  return (
    <div ref={ref} className={className} style={{ width: "100%", height }}>
      {w > 0 && n > 0 && (
        <svg className="chart" width={w} height={height} role="img" aria-label={aria["aria-label"] ?? "Trend"}>
          {wash && <path className="wash" d={`${d} L${X(n - 1)},${height} L${X(0)},${height} Z`} />}
          <path className={cn("line", tone === "muted" && "l2")} d={d} />
          <circle className="dot" cx={X(n - 1)} cy={Y(values[n - 1] ?? 0)} r={3} />
        </svg>
      )}
    </div>
  );
}

// --- LineChart ---------------------------------------------------------------------------

export interface LineSeries {
  key: string;
  label: string;
  values: number[];
  /** `primary` = accent 2px with a 10% wash (the headline series). `secondary` = `--chart-2` 1.5px (p95). */
  tone?: "primary" | "secondary";
}

export interface LineChartProps {
  series: LineSeries[];
  /** y axis tick values, e.g. `[0, 500, 1000, 1500]`. Default: nice ticks up to the data max. */
  yTicks?: number[];
  /** y axis label formatter: `v => v >= 1000 ? `${v / 1000} s` : String(v)`. */
  formatY?: (v: number) => string;
  /** Labeled x ticks: `{ index, label }`. Thinned automatically on narrow widths. */
  xTicks?: { index: number; label: string }[];
  /** Tooltip content for the hovered index (crosshair + dots on every series). */
  tooltip?: (index: number) => ReactNode;
  /** One annotation on the worst point: `{ index, text }`. */
  annotation?: { index: number; seriesKey?: string; text: string };
  height?: number;
  className?: string;
  "aria-label"?: string;
}

/** Multi-series line chart with a single y axis, hairline grid, crosshair tooltip and optional annotation. */
export function LineChart({ series, yTicks, formatY = String, xTicks, tooltip, annotation, height = 220, className, ...aria }: LineChartProps) {
  const [ref, W] = useContainerWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const uid = useId();
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const dataMax = Math.max(0, ...series.flatMap((s) => s.values));
  const nice = niceMax(dataMax);
  const ticks = yTicks ?? nice.ticks;
  const max = Math.max(ticks[ticks.length - 1] ?? 1, 1);
  const L = Math.max(32, Math.max(...ticks.map((t) => formatY(t).length)) * 6.6 + 14);
  const R = 12;
  const T = 12;
  const B = 28;
  const iw = Math.max(1, W - L - R);
  const ih = height - T - B;
  const X = (i: number) => L + (n <= 1 ? 0 : (i / (n - 1)) * iw);
  const Y = (v: number) => T + ih - (v / max) * ih;
  const path = (arr: number[]) => arr.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const primary = series.find((s) => s.tone !== "secondary") ?? series[0];

  const thin = W < 560 ? 2 : 1;
  const shownXTicks = (xTicks ?? []).filter((_, k) => k % thin === 0);

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1))));
    setHover(i);
  };

  return (
    <div ref={ref} className={cn("chart-wrap", className)} style={{ position: "relative", padding: 0 }}>
      {W > 0 && n > 0 && (
        <svg className="chart" width={W} height={height} role="img" aria-label={aria["aria-label"] ?? series.map((s) => s.label).join(", ")}>
          <g className="chart-grid">
            {ticks.map((v) => (
              <line key={v} x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} />
            ))}
          </g>
          {ticks.map((v) => (
            <text key={`t${v}`} x={L - 8} y={Y(v) + 4} textAnchor="end">
              {formatY(v)}
            </text>
          ))}
          {shownXTicks.map((t, k) => (
            <text key={`x${k}`} x={X(t.index)} y={height - 8} textAnchor={t.index === 0 ? "start" : t.index >= n - 1 ? "end" : "middle"}>
              {t.label}
            </text>
          ))}
          <g className="axis">
            <line x1={L} x2={W - R} y1={T + ih} y2={T + ih} />
          </g>
          {primary && <path className="wash" d={`${path(primary.values)} L${X(primary.values.length - 1)},${Y(0)} L${X(0)},${Y(0)} Z`} />}
          {[...series].sort((a, b) => (a.tone === "secondary" ? -1 : 0) - (b.tone === "secondary" ? -1 : 0)).map((s) => (
            <path key={s.key} className={cn("line", s.tone === "secondary" && "l2")} d={path(s.values)} />
          ))}
          {primary && <circle className="dot" cx={X(primary.values.length - 1)} cy={Y(primary.values[primary.values.length - 1] ?? 0)} r={4} />}
          {annotation && (() => {
            const s = series.find((x) => x.key === annotation.seriesKey) ?? series.find((x) => x.tone === "secondary") ?? series[0];
            const v = s?.values[annotation.index];
            if (v === undefined) return null;
            const x = X(annotation.index);
            const flip = x > W * 0.6;
            return (
              <text x={flip ? x - 8 : x + 8} y={Y(v) + 4} textAnchor={flip ? "end" : "start"} style={{ fill: "var(--text-secondary)" }}>
                {annotation.text}
              </text>
            );
          })()}
          {hover !== null && (
            <g>
              <line x1={X(hover)} x2={X(hover)} y1={T} y2={T + ih} stroke="var(--border-strong)" />
              {series.map((s) => (
                <circle key={s.key} className="dot" cx={X(hover)} cy={Y(s.values[hover] ?? 0)} r={4} style={s.tone === "secondary" ? { fill: "var(--chart-2)" } : undefined} />
              ))}
            </g>
          )}
          <rect id={`${uid}-hit`} x={L} y={T} width={iw} height={ih} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
      )}
      {tooltip && hover !== null && (
        <div className="chart-tip on" style={{ left: X(hover), top: Y(Math.max(...series.map((s) => s.values[hover] ?? 0))) }}>
          <div className="tip">{tooltip(hover)}</div>
        </div>
      )}
    </div>
  );
}

/** Legend for the card head: `<ChartLegend items={[{ label: "Median" }, { label: "p95", tone: "secondary" }]} />` */
export function ChartLegend({ items }: { items: { label: string; tone?: "primary" | "secondary" | "ref" }[] }) {
  return (
    <div className="chart-legend">
      {items.map((it) => (
        <span key={it.label}>
          <i className={it.tone === "secondary" ? "l2" : it.tone === "ref" ? "ref" : undefined} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

// --- Histogram ---------------------------------------------------------------------------

export interface HistogramBin {
  label: string;
  count: number;
  /** Tooltip: `19 fills` over `3 to 4 bps worse`. */
  tip?: { title: string; detail: string };
}

export interface HistogramProps {
  bins: HistogramBin[];
  /** Median marker, position in bins (e.g. 5.1 = 0.1 into the sixth bin) and label (`median 4.1`). */
  median?: { at: number; label: string };
  height?: number;
  className?: string;
  "aria-label"?: string;
}

/** Single-series histogram, bars at most 24px wide with 3px rounded tops, one hue, optional median line. */
export function Histogram({ bins, median, height = 220, className, ...aria }: HistogramProps) {
  const [ref, W] = useContainerWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const L = 32;
  const R = 8;
  const T = 12;
  const B = 28;
  const { max, ticks } = niceMax(Math.max(...bins.map((b) => b.count), 1));
  const iw = Math.max(1, W - L - R);
  const ih = height - T - B;
  const bw = iw / Math.max(1, bins.length);
  const barW = Math.min(24, bw - 6);
  const Y = (v: number) => T + ih - (v / max) * ih;
  const r = 3;

  return (
    <div ref={ref} className={cn("chart-wrap", className)} style={{ position: "relative", padding: 0 }}>
      {W > 0 && (
        <svg className="chart" width={W} height={height} role="img" aria-label={aria["aria-label"] ?? "Histogram"} onMouseLeave={() => setHover(null)}>
          <g className="chart-grid">
            {ticks.map((v) => (
              <line key={v} x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} />
            ))}
          </g>
          {ticks.map((v) => (
            <text key={`t${v}`} x={L - 8} y={Y(v) + 4} textAnchor="end">
              {v}
            </text>
          ))}
          {bins.map((b, i) => {
            const h = (b.count / max) * ih;
            const x = L + i * bw + (bw - barW) / 2;
            const y = T + ih - h;
            const d = h <= r ? `M${x},${T + ih} V${y} H${x + barW} V${T + ih} Z` : `M${x},${T + ih} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${T + ih} Z`;
            return (
              <g key={i}>
                <path className="bar" d={d} style={hover === i ? { fill: "var(--accent-hover)" } : undefined} />
                <rect x={L + i * bw} y={T} width={bw} height={ih} fill="transparent" onMouseEnter={() => setHover(i)} />
                {(bw >= 26 || i % 2 === 0) && (
                  <text x={L + i * bw + bw / 2} y={height - 10} textAnchor="middle">
                    {b.label}
                  </text>
                )}
              </g>
            );
          })}
          {median && (
            <>
              <line x1={L + median.at * bw} x2={L + median.at * bw} y1={T} y2={T + ih} stroke="var(--text-secondary)" strokeWidth={1} />
              <text x={L + median.at * bw + 6} y={T + 10} style={{ fill: "var(--text-secondary)" }}>
                {median.label}
              </text>
            </>
          )}
          <line x1={L} x2={W - R} y1={T + ih} y2={T + ih} stroke="var(--chart-axis)" />
        </svg>
      )}
      {hover !== null && bins[hover]?.tip && (
        <div className="chart-tip on" style={{ left: L + hover * bw + bw / 2, top: Y(bins[hover]!.count) }}>
          <div className="tip">
            <b>{bins[hover]!.tip!.title}</b>
            <span>{bins[hover]!.tip!.detail}</span>
          </div>
        </div>
      )}
    </div>
  );
}
