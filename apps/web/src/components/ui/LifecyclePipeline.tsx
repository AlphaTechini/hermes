import { useEffect, useRef, useState } from "react";
import { STAGE_NAMES, type PipelineStage, type StageState } from "../../lib/alert-view";
import { cn } from "../../lib/cn";

export interface PipelineStageInput {
  state: StageState;
  /** Text under the segment: `0 ms`, `+184 ms`, `…`, `waiting`. */
  label?: string;
}

export interface LifecyclePipelineProps {
  /** Exactly six stages in order: Received, Verified, Checked, Sent, Accepted, Filled. `alertPipeline(alert).stages` fits. */
  stages: (PipelineStage | PipelineStageInput)[];
  /** `row` is the 4px stream form (no stage names; the column header carries them). `lg` is 6px with names. */
  size?: "row" | "lg";
  /** Show stage names under the segments (default: true for `lg`). Names hide below 768px except on the landing card. */
  showLabels?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * The signature six-stage bar. Segment colors: pending `--border`, active accent with a moving sheen, done `--pipe-done`,
 * final (Filled) positive, blocked amber, failed red, skipped faint. Per-stage ms is the delta from the previous stage.
 *
 * Drive `stages` from server events only (see `alertPipeline` in lib/alert-view.ts). When a stage flips from `active` to
 * done/final between renders it fills left to right once (`data-animate="fill"`, 180 ms). The group is `role="img"` with
 * an aria-label listing every stage and state.
 */
export function LifecyclePipeline({ stages, size = "row", showLabels, className, style }: LifecyclePipelineProps) {
  const labels = showLabels ?? size === "lg";
  const prev = useRef<StageState[] | null>(null);
  const [filled, setFilled] = useState<Record<number, true>>({});

  useEffect(() => {
    const before = prev.current;
    const next = stages.map((s) => s.state);
    if (before) {
      const add: Record<number, true> = {};
      next.forEach((st, i) => {
        if (before[i] === "active" && (st === "done" || st === "final")) add[i] = true;
      });
      if (Object.keys(add).length) setFilled((f) => ({ ...f, ...add }));
    }
    prev.current = next;
  }, [stages]);

  return (
    <div
      className={cn("hm-pipe", className)}
      style={style}
      data-size={size}
      role="img"
      aria-label={stages.map((s, k) => `${STAGE_NAMES[k]} ${s.state}${s.label && s.label !== "…" ? ` ${s.label}` : ""}`).join(", ")}
    >
      {stages.map((s, k) => (
        <div key={k} className="hm-pipe__stage" data-state={s.state} data-animate={filled[k] ? "fill" : undefined}>
          <span className="hm-pipe__seg" />
          {labels && <span className="hm-pipe__label">{STAGE_NAMES[k]}</span>}
          <span className="hm-pipe__ms">{s.label ?? ""}</span>
        </div>
      ))}
    </div>
  );
}

/** Compact dot form for very narrow spaces: six 6px nodes joined by hairlines. */
export function PipelineDots({ stages, className }: { stages: (PipelineStage | PipelineStageInput)[]; className?: string }) {
  return (
    <div className={cn("hm-pipe-dots", className)} role="img" aria-label={stages.map((s, k) => `${STAGE_NAMES[k]} ${s.state}`).join(", ")}>
      {stages.map((s, k) => (
        <span key={k} style={{ display: "contents" }}>
          {k > 0 && <b />}
          <i data-state={s.state} />
        </span>
      ))}
    </div>
  );
}

/** Header row for a stream column: the six stage names in the same 6-column grid. */
export function PipelineStageNames({ className }: { className?: string }) {
  return (
    <span className={cn("stages", className)}>
      {STAGE_NAMES.map((n) => (
        <span key={n}>{n}</span>
      ))}
    </span>
  );
}
