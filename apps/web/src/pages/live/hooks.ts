import { useEffect, useRef, useState } from "react";

/** Epoch ms that re-renders its caller every `intervalMs` (default 1 s). Drives relative times and countdowns. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/**
 * `hm-flash-up` / `hm-flash-down` for one tick when a live number changes direction (DESIGN.md section 6.3).
 * The digits themselves never animate. Returns a class name or undefined.
 */
export function useFlash(value: number | null | undefined): string | undefined {
  const prev = useRef<number | null>(null);
  const [cls, setCls] = useState<string | undefined>();
  useEffect(() => {
    if (value === null || value === undefined) return;
    const before = prev.current;
    prev.current = value;
    if (before === null || before === value) return;
    setCls(undefined);
    const raf = requestAnimationFrame(() => setCls(value > before ? "hm-flash-up" : "hm-flash-down"));
    const t = setTimeout(() => setCls(undefined), 950);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [value]);
  return cls;
}
