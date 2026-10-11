import { useRef, useState } from "react";

const MIN = 1;
const MAX = 20;
const pos = (v: number) => ((Math.min(MAX, Math.max(MIN, v)) - MIN) / (MAX - MIN)) * 100;

/** Draggable 1x to 20x scale under the leverage input (the prototype's `.lev-scale`), keyboard accessible. */
export function LeverageScale({ value, onChange }: { value: number | null; onChange: (v: number) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [focus, setFocus] = useState(false);
  const v = value ?? MIN;
  const latest = useRef(v);
  latest.current = v;
  const emit = (n: number) => {
    latest.current = n;
    onChange(n);
  };
  const p = pos(v);

  const fromX = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    emit(Math.round(MIN + f * (MAX - MIN)));
  };

  return (
    <div
      ref={ref}
      className="lev-scale"
      role="slider"
      tabIndex={0}
      aria-label="Max leverage"
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      aria-valuenow={Math.round(v)}
      aria-valuetext={`${Math.round(v)}x`}
      style={{ touchAction: "none", cursor: "pointer", outline: "none" }}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        fromX(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) fromX(e.clientX);
      }}
      onKeyDown={(e) => {
        const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
        if (e.key === "Home") emit(MIN);
        else if (e.key === "End") emit(MAX);
        else if (step) emit(Math.min(MAX, Math.max(MIN, Math.round(latest.current) + step)));
        else return;
        e.preventDefault();
      }}
    >
      <span className="track" />
      <span className="fill" style={{ width: `${p}%` }} />
      <span className="knob" style={{ left: `${p}%`, ...(focus ? { boxShadow: "var(--focus-ring)" } : null) }} />
      <span className="ticks" aria-hidden>
        <span style={{ left: 0, transform: "none" }}>1x</span>
        <span style={{ left: `${pos(5)}%` }}>5x</span>
        <span style={{ left: `${pos(10)}%` }}>10x</span>
        <span style={{ left: "100%", transform: "translateX(-100%)" }}>20x</span>
      </span>
    </div>
  );
}
