/** Deterministic PRNG + geometric Brownian motion price engine for the simulator. */

/** mulberry32: tiny seedable PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller. */
export function gaussian(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

export interface PriceSeriesOptions {
  start: number;
  /** Annualised volatility, 0.5 = 50%. */
  annualVol: number;
  /** Annualised drift. Default 0. */
  drift?: number;
}

/** One GBM series. `step(dtSeconds)` advances and returns the new price. */
export class GbmSeries {
  price: number;
  private readonly sigma: number;
  private readonly mu: number;
  /** Price 24 h ago stand-in: the starting price. */
  readonly open: number;

  constructor(
    private readonly rand: () => number,
    o: PriceSeriesOptions,
    volMultiplier = 1,
  ) {
    this.price = o.start;
    this.open = o.start;
    this.sigma = o.annualVol * volMultiplier;
    this.mu = o.drift ?? 0;
  }

  step(dtSeconds: number): number {
    const dt = dtSeconds / SECONDS_PER_YEAR;
    const z = gaussian(this.rand);
    this.price *= Math.exp((this.mu - 0.5 * this.sigma * this.sigma) * dt + this.sigma * Math.sqrt(dt) * z);
    return this.price;
  }

  set(price: number): void {
    this.price = price;
  }
}
