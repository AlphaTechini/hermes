import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface TimelineItem {
  key?: string;
  /** Absolute time, mono: `14:32:07.412`. */
  time: string;
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned delta: `+184 ms`. */
  delta?: string;
  /** Node fill: `final` positive, `blocked` warning, `failed` negative, `skipped` hollow/faint. */
  state?: "done" | "final" | "blocked" | "failed" | "skipped";
  /** Gantt bar as percentages of the total (0 to 100). Omit to draw no bar. */
  bar?: { left: number; width: number };
}

/**
 * Alert timeline: time 104 | node 20 | title + description | delta 72 | gantt 168. On mobile the time moves under the
 * description and the gantt disappears. Pass `axisTotal` (e.g. `612 ms`) for the 0 ... total axis row.
 */
export function Timeline({ items, axisTotal, axisMid, className }: { items: TimelineItem[]; axisTotal?: string; axisMid?: string[]; className?: string }) {
  return (
    <>
      <div className={cn("tl", className)}>
        {items.map((it, i) => (
          <div key={it.key ?? i} className="tl-row" data-state={it.state ?? "done"}>
            <span className="tl-time">{it.time}</span>
            <span className="tl-node">
              <i />
            </span>
            <div className="tl-body">
              <div className="tl-title">{it.title}</div>
              {it.description && <div className="tl-desc">{it.description}</div>}
              <span className="tl-time-m">{it.time}</span>
            </div>
            <span className="tl-delta">{it.delta ?? ""}</span>
            <span className="tl-gantt">{it.bar && <b style={{ left: `${it.bar.left}%`, width: `max(2px, ${it.bar.width}%)` }} />}</span>
          </div>
        ))}
      </div>
      {axisTotal && (
        <div className="tl-gantt-axis">
          <span />
          <span />
          <span />
          <span />
          <span className="ax">
            <span>0</span>
            {axisMid?.map((m) => <span key={m}>{m}</span>)}
            <span>{axisTotal}</span>
          </span>
        </div>
      )}
    </>
  );
}
