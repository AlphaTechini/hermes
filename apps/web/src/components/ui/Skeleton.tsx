import type { CSSProperties } from "react";
import { cn } from "../../lib/cn";

/** Shimmering placeholder bar. Reproduce the final layout exactly; show only after 200 ms (`useDelayedFlag`). */
export function Skeleton({ w, h = 12, r, className, style }: { w?: number | string; h?: number | string; r?: number | string; className?: string; style?: CSSProperties }) {
  return <span className={cn("hm-skeleton", className)} aria-hidden style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

/** Skeleton for alert stream rows: time, six pipeline stubs and a pill stub. */
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="stream" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="stream-row" style={{ cursor: "default", gridTemplateColumns: "96px 1fr 120px" }}>
          <span className="col" style={{ gap: 4 }}>
            <Skeleton w={84} h={12} />
            <Skeleton w={40} h={10} />
          </span>
          <span className="hm-pipe">
            {Array.from({ length: 6 }, (_, k) => (
              <span key={k} className="hm-pipe__stage">
                <Skeleton h={4} />
              </span>
            ))}
          </span>
          <Skeleton w={72} h={20} r={999} style={{ justifySelf: "end" }} />
        </div>
      ))}
    </div>
  );
}
