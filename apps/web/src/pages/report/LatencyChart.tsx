import { useState } from "react";
import type { ReportCard } from "@hermes/shared";
import { cn } from "../../lib/cn";
import { formatMs } from "../../lib/format";
import { useContainerWidth } from "../../components/ui";

type Buckets = ReportCard["latency"]["buckets"];
type MaxPoint = ReportCard["latency"]["maxPoint"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const pad = (n: number) => String(n).padStart(2, "0");
const dayLabel = (t: number) => `${new Date(t).getDate()} ${MONTHS[new Date(t).getMonth()]}`;
const hourLabel = (t: number) => `${pad(new Date(t).getHours())}:00`;

/** The y axis in ms: `500`, `1 s`, `1.5 s`. */
export const msAxis = (v: number) => (v >= 1000 ? `${Number((v / 1000).toFixed(2))} s` : String(v));

/** Y axis top and ticks: at least 1.5 s so one slow bucket does not flatten the rest, otherwise 1.2 x the worst p95. */
export function latencyAxis(buckets: Buckets): { max: number; ticks: number[] } {
  const worstP95 = buckets.reduce((m, b) => Math.max(m, b.p95Ms), 0);
  const want = Math.max(1500, worstP95 * 1.2);
  const steps = [250, 500, 1000, 2000, 2500, 5000, 10_000, 20_000, 50_000];
  const step = steps.find((s) => want / s <= 6) ?? 100_000;
  const max = Math.ceil(want / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= max; v += step) ticks.push(v);
  return { max, ticks };
}

/** Round x ticks on the local clock: whole hours for short ranges, local midnights for long ones. */
export function timeTicks(t0: number, t1: number, maxTicks: number): number[] {
  const span = t1 - t0;
  const steps = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];
  const step = steps.find((s) => span / s <= maxTicks) ?? 90 * DAY;
  const out: number[] = [];
  if (step < DAY) {
    const d = new Date(t0);
    d.setMinutes(0, 0, 0);
    d.setHours(Math.ceil((d.getHours() + (d.getTime() < t0 ? 1 : 0)) / (step / HOUR)) * (step / HOUR));
    for (let t = d.getTime(); t <= t1; t += step) if (t >= t0) out.push(t);
  } else {
    const d = new Date(t0);
    d.setHours(0, 0, 0, 0);
    if (d.getTime() < t0) d.setDate(d.getDate() + 1);
    const n = Math.round(step / DAY);
    for (let t = d.getTime(); t <= t1; ) {
      out.push(t);
      const nx = new Date(t);
      nx.setDate(nx.getDate() + n);
      t = nx.getTime();
    }
  }
  return out;
}

const bucketTitle = (b: { atMs: number }, bucketMs: number) => (bucketMs >= DAY ? dayLabel(b.atMs) : `${dayLabel(b.atMs)}, ${hourLabel(b.atMs)}`);

interface Props {
  buckets: Buckets;
  bucketMs: number;
  maxPoint: MaxPoint;
  /** Window start (epoch ms) or null for all time, and the window end. */
  since: number | null;
  until: number;
  height?: number;
}

/**
 * Median and p95 alert-to-fill per server bucket on a real time axis, so a quiet hour is a gap and not a squeezed step.
 * The y axis is 0 to max(1.5 s, 1.2 x the worst p95). The slowest alert is annotated; when it lies above the axis it is
 * drawn as a clipped point with an up chevron and its full value in the label.
 */
export function LatencyChart({ buckets, bucketMs, maxPoint, since, until, height = 220 }: Props) {
  const [ref, W] = useContainerWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const L = 40;
  const R = 12;
  const T = 16;
  const B = 28;
  const iw = Math.max(1, W - L - R);
  const ih = height - T - B;
  const { max, ticks } = latencyAxis(buckets);
  const first = buckets[0]?.atMs ?? until - DAY;
  const t0 = Math.min(since ?? first, first);
  const t1 = Math.max(until, (buckets[buckets.length - 1]?.atMs ?? until) + bucketMs);
  const X = (t: number) => L + ((t - t0) / Math.max(1, t1 - t0)) * iw;
  const Y = (v: number) => T + ih - (Math.min(v, max) / max) * ih;
  const cx = (b: { atMs: number }) => X(b.atMs + bucketMs / 2);

  // Break the line where more than 4 buckets in a row are empty, so a quiet stretch is not drawn as data.
  const groups: Buckets[] = [];
  for (const b of buckets) {
    const g = groups[groups.length - 1];
    const prev = g?.[g.length - 1];
    if (g && prev && b.atMs - prev.atMs <= 4 * bucketMs) g.push(b);
    else groups.push([b]);
  }
  const path = (key: "medianMs" | "p95Ms") => groups.map((g) => g.map((b, i) => `${i ? "L" : "M"}${cx(b).toFixed(1)},${Y(b[key]).toFixed(1)}`).join(" ")).join(" ");
  const wash = groups
    .filter((g) => g.length > 1)
    .map((g) => `${g.map((b, i) => `${i ? "L" : "M"}${cx(g[i]!).toFixed(1)},${Y(b.medianMs).toFixed(1)}`).join(" ")} L${cx(g[g.length - 1]!)},${Y(0)} L${cx(g[0]!)},${Y(0)} Z`)
    .join(" ");

  const xTicks = timeTicks(t0, t1, W < 560 ? 4 : 7);
  const shortSpan = t1 - t0 <= 2 * DAY;

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left + L;
    let best = 0;
    let bd = Infinity;
    buckets.forEach((b, i) => {
      const d = Math.abs(cx(b) - x);
      if (d < bd) (bd = d), (best = i);
    });
    setHover(best);
  };

  const mp = maxPoint;
  const clipped = mp !== null && mp.ms > max;
  const label = mp ? `${formatMs(mp.ms)}${mp.note ? ` · ${mp.note}` : " · slowest alert"}` : "";
  const mpX = mp ? Math.min(Math.max(X(mp.at), L), L + iw) : 0;
  const mpY = mp ? Y(mp.ms) : 0;
  const flip = mpX > L + iw * 0.55;
  const hb = hover !== null ? buckets[hover] : undefined;

  return (
    <div ref={ref} className={cn("chart-wrap")} style={{ position: "relative", padding: 0 }}>
      {W > 0 && (
        <svg className="chart" width={W} height={height} role="img" aria-label="Median and p95 alert to fill latency over time">
          <g className="chart-grid">
            {ticks.map((v) => (
              <line key={v} x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} />
            ))}
          </g>
          {ticks.map((v) => (
            <text key={`t${v}`} x={L - 8} y={Y(v) + 4} textAnchor="end">
              {msAxis(v)}
            </text>
          ))}
          {xTicks.map((t, k) => {
            const x = X(t);
            const anchor = x - L < 24 ? "start" : W - R - x < 24 ? "end" : "middle";
            const midnight = new Date(t).getHours() === 0;
            return (
              <text key={`x${k}`} x={x} y={height - 8} textAnchor={anchor}>
                {shortSpan && !midnight ? hourLabel(t) : dayLabel(t)}
              </text>
            );
          })}
          <g className="axis">
            <line x1={L} x2={W - R} y1={T + ih} y2={T + ih} />
          </g>
          {wash && <path className="wash" d={wash} />}
          <path className="line l2" d={path("p95Ms")} />
          <path className="line" d={path("medianMs")} />
          {buckets.length <= 40 &&
            buckets.map((b) => (
              <circle key={b.atMs} className="dot" cx={cx(b)} cy={Y(b.medianMs)} r={3} />
            ))}
          {mp && (
            <g>
              {clipped ? (
                <path d={`M${mpX - 4},${T + 4} L${mpX},${T - 1} L${mpX + 4},${T + 4}`} fill="none" stroke="var(--text-secondary)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
              ) : (
                <circle cx={mpX} cy={mpY} r={4} fill="var(--surface)" stroke="var(--text-secondary)" strokeWidth={1.5} />
              )}
              <text x={flip ? mpX - 10 : mpX + 10} y={clipped ? T + 4 : Math.max(T + 4, mpY + 4)} textAnchor={flip ? "end" : "start"} style={{ fill: "var(--text-secondary)" }}>
                {label}
              </text>
            </g>
          )}
          {hb && (
            <g>
              <line x1={cx(hb)} x2={cx(hb)} y1={T} y2={T + ih} stroke="var(--border-strong)" />
              <circle className="dot" cx={cx(hb)} cy={Y(hb.medianMs)} r={4} />
              <circle className="dot" cx={cx(hb)} cy={Y(hb.p95Ms)} r={4} style={{ fill: "var(--chart-2)" }} />
            </g>
          )}
          <rect x={L} y={T} width={iw} height={ih} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
      )}
      {hb && (
        <div className="chart-tip on" style={{ left: cx(hb), top: Y(hb.p95Ms) }}>
          <div className="tip">
            <b>{bucketTitle(hb, bucketMs)}</b>
            <span>
              Median {formatMs(hb.medianMs)} · p95 {formatMs(hb.p95Ms)}
            </span>
            <span>
              {hb.count} {hb.count === 1 ? "fill" : "fills"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
