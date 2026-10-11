/** High-resolution wall clock in epoch milliseconds with 3 decimals. */
export function hiresNowMs(): number {
  const g = globalThis as { performance?: { timeOrigin: number; now(): number } };
  const p = g.performance;
  if (!p) return Date.now();
  return Math.round((p.timeOrigin + p.now()) * 1000) / 1000;
}
