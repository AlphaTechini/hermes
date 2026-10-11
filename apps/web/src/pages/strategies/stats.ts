import type { AlertRecord } from "@hermes/shared";
import { formatFraction } from "../../lib/format";

export interface StrategyStats {
  today: number;
  /** filled / terminal alerts today, 0..1, null when nothing finished yet. */
  filledRate: number | null;
  blocked: number;
}

const TERMINAL = new Set(["filled", "partially_filled", "blocked", "expired", "failed"]);

/** Per strategy numbers for the list, computed from the cached alert list (patched live by the SSE stream). */
export function strategyStats(alerts: AlertRecord[] | undefined, dayStart: number): Map<string, StrategyStats> {
  const out = new Map<string, { today: number; filled: number; terminal: number; blocked: number }>();
  for (const a of alerts ?? []) {
    if (a.receivedAt < dayStart) continue;
    const s = out.get(a.strategyId) ?? { today: 0, filled: 0, terminal: 0, blocked: 0 };
    s.today++;
    if (TERMINAL.has(a.status)) s.terminal++;
    if (a.status === "filled" || a.status === "partially_filled") s.filled++;
    if (a.status === "blocked") s.blocked++;
    out.set(a.strategyId, s);
  }
  const res = new Map<string, StrategyStats>();
  for (const [id, s] of out) res.set(id, { today: s.today, filledRate: s.terminal ? s.filled / s.terminal : null, blocked: s.blocked });
  return res;
}

export const formatRate = (r: number | null): string => (r === null ? "n/a" : r === 1 ? "100%" : formatFraction(r));
