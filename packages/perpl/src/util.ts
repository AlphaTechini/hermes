/** Small shared utilities: typed emitter, logger, token bucket, backoff, deferred. */

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Adapter for pino-style loggers (`log.info(obj, msg)`) and console-like ones. */
export function consoleLogger(prefix = "perpl"): Logger {
  const fmt = (level: string, msg: string, meta?: Record<string, unknown>): void => {
    const line = `[${prefix}] ${msg}${meta ? " " + JSON.stringify(meta) : ""}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m, x) => fmt("debug", m, x),
    info: (m, x) => fmt("info", m, x),
    warn: (m, x) => fmt("warn", m, x),
    error: (m, x) => fmt("error", m, x),
  };
}

type Handler<T> = (payload: T) => void;

/** Minimal typed event emitter. A throwing listener never breaks the emitter. */
export class TypedEmitter<E extends { [K in keyof E]: unknown }> {
  private readonly listeners = new Map<keyof E, Set<Handler<never>>>();
  /** Override to observe exceptions thrown by listeners. */
  protected onListenerError(_event: keyof E, _err: unknown): void {}

  on<K extends keyof E>(event: K, fn: Handler<E[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Handler<never>);
    return () => this.off(event, fn);
  }

  once<K extends keyof E>(event: K, fn: Handler<E[K]>): () => void {
    const off = this.on(event, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  off<K extends keyof E>(event: K, fn: Handler<E[K]>): void {
    this.listeners.get(event)?.delete(fn as Handler<never>);
  }

  protected emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as Handler<E[K]>)(payload);
      } catch (err) {
        this.onListenerError(event, err);
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }

  listenerCount(event: keyof E): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

/**
 * Token bucket for the per-connection request budget (trading: 60/min, market data: 10/min). Starts full.
 * `now` is injectable for tests.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  constructor(capacity: number, windowMs = 60_000, now: () => number = Date.now) {
    if (!(capacity > 0)) throw new RangeError("capacity must be > 0");
    this.capacity = capacity;
    this.refillPerMs = capacity / windowMs;
    this.now = now;
    this.tokens = capacity;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    if (t > this.last) {
      this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.refillPerMs);
      this.last = t;
    } else if (t < this.last) {
      this.last = t; // clock moved backwards
    }
  }

  /** Take one token if available. */
  tryTake(n = 1): boolean {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /** Milliseconds until `n` tokens are available (0 if now). */
  msUntil(n = 1): number {
    this.refill();
    if (this.tokens >= n) return 0;
    return Math.ceil((n - this.tokens) / this.refillPerMs);
  }

  get available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

/** Exponential back-off over a schedule (last entry repeats) with additive jitter of up to `jitter` x delay. */
export function backoffDelay(attempt: number, schedule: readonly number[], jitter: number, random: () => number = Math.random): number {
  const idx = Math.max(0, Math.min(attempt, schedule.length - 1));
  const base = schedule[idx] ?? 1000;
  return Math.round(base + base * jitter * random());
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Bounded insertion-ordered set (oldest evicted first). */
export class BoundedSet<T> {
  private readonly set = new Set<T>();
  constructor(private readonly max: number) {}
  /** Returns true if newly added, false if already present. */
  add(v: T): boolean {
    if (this.set.has(v)) return false;
    this.set.add(v);
    if (this.set.size > this.max) {
      const first = this.set.values().next();
      if (!first.done) this.set.delete(first.value);
    }
    return true;
  }
  has(v: T): boolean {
    return this.set.has(v);
  }
  clear(): void {
    this.set.clear();
  }
}
