import { createHash } from "node:crypto";
import {
  Ed25519Signer,
  PerplChain,
  PerplHttpError,
  PerplClient as RawPerplClient,
  PerplRest,
  toServerClient,
  type PerplPosition,
  type PerplSimulator,
  type ServerPerplClient,
  type ServerPerplEvent,
} from "@hermes/perpl";
import { MARKETS, isMarketSymbol, type AccountSummary, type PerplContextDTO, type PerplHealthDTO, type PerplLinkStatus, type Position } from "@hermes/shared";
import type { Config } from "../config";
import type { Repos } from "../db/repos";
import { withTodayPnl } from "../risk/today";
import { OrderFrameRecorder } from "./frame-recorder";
import type { EventBus } from "../events/bus";
import { HermesError } from "../errors";
import { silentLogger, type Logger } from "../logger";
import { loadPerplCredentials } from "./credentials";
import { classifyPerplError, toHermesError, type ClassifiedPerplError, type PerplCredentialsInput, type PerplRuntime } from "./runtime";
import { SIM_START_BALANCE_AUSD, generateSimCredentials } from "./sim-keys";
import type { PerplClient, PerplEventListener } from "./types";

export interface RegistryOptions {
  config: Config;
  repos: Repos;
  bus: EventBus;
  log?: Logger;
  /** The in-process simulator (PERPL_MODE=sim). Stored keys are (re-)enrolled with it before every connect. */
  simulator?: PerplSimulator | undefined;
  /** Reconnect schedule for a client whose connect() failed or whose socket gave up. Default 1, 2, 5, 10, 30 s. */
  backoffMs?: readonly number[];
  /** Health / account / positions push interval while connected. Default 5000. 0 disables. */
  tickMs?: number;
  /** connect() deadline when validating a key. Default 10000. */
  validateTimeoutMs?: number;
  /** Per attempt deadline for background connects. Default 20000. */
  connectTimeoutMs?: number;
  /** Simulator only: re-open positions that exist in the stored snapshot but not on a fresh sim account. Default true. */
  restoreSimPositions?: boolean;
}

/** The raw, full-featured client of a user (what the executor needs: `placeMarketOrder`). */
export interface RawClientProvider {
  raw(userId: string): RawPerplClient | undefined;
  /** The executor placed Hermes order `orderId` under (rq, sn): lets the frame recorder file the raw Perpl frames under it. */
  bindOrderFrames?(userId: string, orderId: string, ids: { rq?: number | undefined; sn?: number | undefined }): void;
}

const DEFAULT_BACKOFF = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
/** Monad block time, used until the heartbeats give a measured one. */
const DEFAULT_BLOCK_TIME_MS = 400;

interface Entry {
  userId: string;
  fingerprint: string;
  creds: PerplCredentialsInput;
  /** Stable object handed to the pipeline; delegates to whatever raw client is current. */
  facade: PerplClient;
  raw?: RawPerplClient;
  adapter?: ServerPerplClient;
  link: PerplLinkStatus;
  disposed: boolean;
  everConnected: boolean;
  reconnects: number;
  lastHeartbeatAt: number | null;
  head: number | null;
  latencyMs: number | null;
  /** Moving average of mt:22 send -> mt:3 receive, ms, and when it was last updated. */
  orderRttMs: number | null;
  orderRttAt: number;
  /** Block time estimate from heartbeat head deltas (window baseline + smoothed result). */
  blockTimeMs: number | null;
  hbBase: { head: number; at: number } | null;
  error: { code: string; message: string } | null;
  offs: Array<() => void>;
  statusListeners: Set<PerplEventListener>;
  wake?: (() => void) | undefined;
  accountTimer?: NodeJS.Timeout | undefined;
  restored: boolean;
  tickCount: number;
  loopRunning: boolean;
}

const fingerprintOf = (c: PerplCredentialsInput): string =>
  createHash("sha256").update(`${c.accountId}\n${c.apiKeyPublic}\n${c.apiKeyPrivate}`).digest("hex");

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

const toSharedPosition = (p: PerplPosition): Omit<Position, "notionalUsd"> => ({
  market: p.market,
  side: p.side,
  size: p.size,
  entryPrice: p.entryPrice,
  markPrice: p.markPrice,
  upnl: p.upnl,
  updatedAt: p.updatedAtMs,
});

/**
 * One {@link RawPerplClient} per user that has a stored perpl_connection. Implements the server's
 * `PerplClientProvider` (`get`, `refresh`) plus the {@link PerplRuntime} extras (health, key validation, sim connect).
 *
 *  - Clients are created lazily: at boot for stored connections and whenever a connection is saved.
 *  - `onRqAdvance` persists `last_rq` synchronously before the frame is sent; `lastRq` is read from the DB.
 *  - A failed connect, or a socket that gave up, is retried with back-off. A pasted key that is not even a valid key
 *    is not retried (the user has to fix it).
 *  - State changes are pushed on the event bus: `perpl_status`, `perpl`, `positions`, `account`.
 */
export class PerplClientRegistry implements PerplRuntime, RawClientProvider {
  private readonly o: RegistryOptions;
  private readonly log: Logger;
  private readonly entries = new Map<string, Entry>();
  /** Clients that passed validate() and wait for the connection row to be saved (refresh adopts them). */
  private readonly validated = new Map<string, { fingerprint: string; raw: RawPerplClient; timer: NodeJS.Timeout }>();
  private ticker: NodeJS.Timeout | undefined;
  private stopped = false;
  private lastSimAccountId = 1000;
  private contextCache: { at: number; value: PerplContextDTO } | undefined;
  /** Raw Perpl frames per order (mt:22 sent, mt:3 / mt:24 / mt:25 received) for the alert detail page. */
  readonly frames: OrderFrameRecorder;

  constructor(opts: RegistryOptions) {
    this.o = opts;
    this.log = opts.log ?? silentLogger;
    this.frames = new OrderFrameRecorder(opts.repos, (userId, ms) => this.noteOrderRtt(userId, ms));
  }

  bindOrderFrames(userId: string, orderId: string, ids: { rq?: number | undefined; sn?: number | undefined }): void {
    this.frames.bindOrder(userId, orderId, ids);
  }

  private noteOrderRtt(userId: string, ms: number): void {
    const e = this.entries.get(userId);
    if (!e) return;
    e.orderRttMs = e.orderRttMs === null ? ms : e.orderRttMs * 0.7 + ms * 0.3;
    e.orderRttAt = Date.now();
  }

  // ---- PerplClientProvider ----------------------------------------------------------------------------------------

  get(userId: string): PerplClient | undefined {
    return this.entries.get(userId)?.facade;
  }

  raw(userId: string): RawPerplClient | undefined {
    const e = this.entries.get(userId);
    return e?.raw && e.link === "connected" ? e.raw : undefined;
  }

  /** The stored connection of `userId` was created, replaced or deleted: bring the live client in line. */
  async refresh(userId: string): Promise<void> {
    const row = this.o.repos.connections.get(userId);
    const old = this.entries.get(userId);
    if (!row) {
      if (old) {
        this.entries.delete(userId);
        await this.dispose(old);
      }
      this.dropValidated(userId);
      return;
    }
    let creds: PerplCredentialsInput;
    try {
      const c = loadPerplCredentials(this.o.repos, this.o.config, userId);
      if (!c) return;
      creds = { accountId: c.accountId, apiKeyPublic: c.apiKeyPublic, apiKeyPrivate: c.apiKeyPrivate };
    } catch (err) {
      this.log.error({ err, userId }, "could not decrypt the stored Perpl API key (wrong HERMES_MASTER_KEY?)");
      if (old) {
        this.entries.delete(userId);
        await this.dispose(old);
      }
      const entry = this.makeEntry(userId, { accountId: row.accountId, apiKeyPublic: row.apiKeyPublic, apiKeyPrivate: "" });
      entry.error = { code: "perpl_key_unreadable", message: "The stored API key cannot be decrypted (HERMES_MASTER_KEY changed?). Connect Perpl again." };
      this.entries.set(userId, entry);
      this.publish(entry);
      return;
    }
    const fp = fingerprintOf(creds);
    if (old && old.fingerprint === fp && !old.disposed) return;
    if (old) {
      this.entries.delete(userId);
      await this.dispose(old);
    }
    const entry = this.makeEntry(userId, creds);
    this.entries.set(userId, entry);
    const pre = this.validated.get(userId);
    if (pre && pre.fingerprint === fp) {
      clearTimeout(pre.timer);
      this.validated.delete(userId);
      this.adopt(entry, pre.raw);
      // head block and round trip right away, so the response to PUT /api/perpl/connection already carries them
      await this.probeLatency(entry);
      this.publish(entry);
      return;
    }
    this.dropValidated(userId);
    this.publish(entry);
    void this.connectLoop(entry);
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------------

  /** Boot: log the Perpl context, start a client for every stored connection (in the background) and the push timer. */
  async start(): Promise<void> {
    this.stopped = false;
    void this.logContext(); // network call with its own timeout: never hold up boot
    for (const userId of this.o.repos.connections.allUserIds()) {
      try {
        await this.refresh(userId);
      } catch (err) {
        this.log.error({ err, userId }, "could not start the Perpl client");
      }
    }
    const tickMs = this.o.tickMs ?? 5_000;
    if (tickMs > 0) {
      this.ticker = setInterval(() => void this.tick(), tickMs);
      this.ticker.unref();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map((e) => this.dispose(e)));
    for (const userId of [...this.validated.keys()]) this.dropValidated(userId);
  }

  /** `pub/context` is public: log the collateral token, minimum deposits and geo-block list once at boot. */
  private async logContext(): Promise<void> {
    try {
      const rest = new PerplRest({ baseUrl: this.restUrl(), chainId: this.chainId(), timeoutMs: 8_000, maxRetries: 1 });
      const ctx = await rest.getContext();
      const dec = ctx.collateral.decimals;
      const fmt = (v: bigint) => Number(v) / 10 ** dec;
      this.log.info(
        {
          mode: this.o.config.perplMode,
          rest: this.restUrl(),
          chainId: ctx.chainId,
          collateral: `${ctx.collateral.symbol} ${ctx.collateral.address}`,
          minAccountOpen: `${fmt(ctx.minAccountOpenAmount)} ${ctx.collateral.symbol}`,
          minDeposit: `${fmt(ctx.minDepositAmount)} ${ctx.collateral.symbol}`,
          geoBlock: ctx.geoBlock,
          markets: ctx.markets.map((m) => `${m.symbol}#${m.id}`).join(","),
        },
        "Perpl context",
      );
    } catch (err) {
      const c = classifyPerplError(err);
      this.log.warn({ code: c.code }, `could not read Perpl pub/context at ${this.restUrl()}: ${c.message}`);
    }
  }

  private restUrl(): string {
    return this.o.simulator ? this.o.simulator.url : this.o.config.perplApiBase;
  }
  private wsUrl(): string {
    return this.o.simulator ? this.o.simulator.wsUrl : this.o.config.perplWsBase;
  }
  private chainId(): number {
    return this.o.simulator ? this.o.simulator.chainId : 10143;
  }

  // ---- validation (PUT /api/perpl/connection) ---------------------------------------------------------------------

  async validate(userId: string, creds: PerplCredentialsInput): Promise<void> {
    const fp = fingerprintOf(creds);
    const existing = this.entries.get(userId);
    if (existing && existing.fingerprint === fp && existing.link === "connected") return;
    const timeoutMs = this.o.validateTimeoutMs ?? 10_000;
    let raw: RawPerplClient | undefined;
    try {
      this.enrollInSim(creds);
      raw = this.createRaw(userId, creds);
      await withTimeout(raw.connect(), timeoutMs, "connecting to Perpl");
      const acc = await withTimeout(raw.getAccount(), timeoutMs, "reading the Perpl account");
      if (acc.accountId === null) {
        const found = raw.getAccounts().map((a) => a.id);
        throw new HermesError(
          400,
          "perpl_account_not_found",
          found.length
            ? `Perpl has no account ${creds.accountId} for this key. The wallet has account(s): ${found.join(", ")}.`
            : "This key's wallet has no Perpl exchange account yet. Create it (approve, createAccount) before connecting.",
        );
      }
      if (!acc.forwardingEnabled) {
        throw new HermesError(
          409,
          "perpl_forwarding_disabled",
          "Order forwarding is switched off on this Perpl account, so API keys cannot trade. Call allowOrderForwarding(true) from the wallet, then connect again.",
        );
      }
      if (acc.frozen) throw new HermesError(409, "perpl_account_frozen", "The Perpl account is frozen.");
    } catch (err) {
      await raw?.close().catch(() => {});
      throw err instanceof HermesError ? err : toHermesError(classifyPerplError(err));
    }
    this.dropValidated(userId);
    const timer = setTimeout(() => this.dropValidated(userId), 60_000);
    timer.unref();
    this.validated.set(userId, { fingerprint: fp, raw, timer });
  }

  private dropValidated(userId: string): void {
    const v = this.validated.get(userId);
    if (!v) return;
    clearTimeout(v.timer);
    this.validated.delete(userId);
    void v.raw.close().catch(() => {});
  }

  // ---- simulator helpers ------------------------------------------------------------------------------------------

  /** Simulator only: new key pair and account id for `userId`; the account is created with 10,000 AUSD. */
  provisionSim(_userId: string): PerplCredentialsInput & { collateralUsd: number } {
    const sim = this.o.simulator;
    if (!sim) throw new HermesError(404, "not_available", "The Perpl simulator is not running (PERPL_MODE=live).");
    const used = this.o.repos.connections
      .allUserIds()
      .map((u) => Number(this.o.repos.connections.get(u)?.accountId))
      .filter((n) => Number.isInteger(n));
    const accountId = Math.max(1000, this.lastSimAccountId, ...used) + 1;
    this.lastSimAccountId = accountId;
    const creds = generateSimCredentials(accountId);
    this.enrollInSim(creds);
    return { ...creds, collateralUsd: SIM_START_BALANCE_AUSD };
  }

  /** Make the simulator know this key and account (idempotent). Real Perpl enrolment happens on perpl.xyz. */
  private enrollInSim(creds: PerplCredentialsInput): void {
    const sim = this.o.simulator;
    if (!sim) return;
    const signer = Ed25519Signer.fromSecret(creds.apiKeyPrivate); // KeyParseError -> perpl_invalid_key_format
    const id = Number(creds.accountId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HermesError(400, "perpl_account_not_found", "The simulated Perpl accepts numeric account ids only.");
    }
    this.lastSimAccountId = Math.max(this.lastSimAccountId, id);
    sim.createAccount({ accountId: id, balanceAusd: SIM_START_BALANCE_AUSD });
    sim.enrollKey(signer.publicKey, id, { apiKey: creds.apiKeyPublic });
  }

  // ---- context and account lookup ---------------------------------------------------------------------------------

  /** `GET /v1/pub/context` (the simulator's in sim mode), reduced to what onboarding needs. Cached for a minute. */
  async context(): Promise<PerplContextDTO> {
    const cached = this.contextCache;
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    let c;
    try {
      const rest = new PerplRest({ baseUrl: this.restUrl(), chainId: this.chainId(), timeoutMs: 8_000, maxRetries: 1 });
      c = await rest.getContext();
    } catch (err) {
      throw toHermesError(classifyPerplError(err));
    }
    const scale = 10 ** c.collateral.decimals;
    const value: PerplContextDTO = {
      mode: this.o.config.perplMode,
      collateralToken: c.collateral.symbol,
      collateralAddress: c.collateral.address,
      collateralDecimals: c.collateral.decimals,
      minAccountOpenAusd: Number(c.minAccountOpenAmount) / scale,
      minDepositAusd: Number(c.minDepositAmount) / scale,
      markets: c.markets.map((m) => ({ symbol: m.symbol, id: m.id, priceDecimals: m.priceDecimals, sizeDecimals: m.sizeDecimals })),
      geoBlock: c.geoBlock,
    };
    this.contextCache = { at: Date.now(), value };
    return value;
  }

  /**
   * Find the Perpl exchange account for an API key without being told its id.
   *  1. Ask Perpl who the key belongs to (signed `GET /v1/trading/wallet`; the simulator answers for the account the key
   *     is enrolled with). Prefer the account whose instance matches the market instance.
   *  2. Sim: fall back to the account of the user's stored connection when it uses the same key (the simulator forgets
   *     enrolled keys on restart).
   *  3. Live: read the Exchange contract (`getAccountByAddr`) for the user's wallet address.
   * Throws `perpl_account_not_found` when none of these finds one.
   */
  async lookupAccount(userId: string, key: { apiKeyPublic: string; apiKeyPrivate: string }, walletAddress: string | null): Promise<string> {
    let signer: Ed25519Signer;
    try {
      signer = Ed25519Signer.fromSecret(key.apiKeyPrivate);
    } catch (err) {
      throw toHermesError(classifyPerplError(err));
    }
    const stored = this.o.repos.connections.get(userId);
    const storedSameKey = stored && stored.apiKeyPublic === key.apiKeyPublic ? stored.accountId : undefined;
    try {
      const rest = new PerplRest({ baseUrl: this.restUrl(), chainId: this.chainId(), apiKey: key.apiKeyPublic, apiSecret: signer, timeoutMs: 8_000, maxRetries: 1 });
      const [ctx, wallet] = await Promise.all([rest.getContext(), rest.getWalletOrNull()]);
      const accounts = wallet?.as ?? [];
      const mine = accounts.find((a) => a.in === ctx.instance.id) ?? accounts[0];
      if (mine) return String(mine.id);
    } catch (err) {
      // The simulator answers 401 for a key it does not know (it keeps no state across restarts): that is "no account",
      // not "bad key", and the stored connection (if any) still names the account.
      const unknownToSim = this.o.simulator && err instanceof PerplHttpError && (err.status === 401 || err.status === 403);
      if (!unknownToSim) throw toHermesError(classifyPerplError(err));
    }
    if (storedSameKey && this.o.simulator) return storedSameKey;
    if (!this.o.simulator && walletAddress) {
      try {
        const chain = new PerplChain({ rpcUrl: this.o.config.monadRpcUrl, addresses: { exchange: this.o.config.perplExchangeAddress as `0x${string}` } });
        const acc = await withTimeout(chain.getAccountByAddress(walletAddress as `0x${string}`), 8_000, "reading the Exchange contract");
        if (acc) return String(acc.accountId);
      } catch (err) {
        this.log.warn({ userId, err: (err as Error).message }, "on-chain account lookup failed");
      }
    }
    throw new HermesError(
      400,
      "perpl_account_not_found",
      this.o.simulator
        ? "The simulator has no account enrolled for this API key. Use Connect simulated Perpl account, or pass an accountId."
        : walletAddress
          ? `Perpl has no exchange account for this API key or for your wallet ${walletAddress}. Create the account (approve, createAccount) first, or enter the account id.`
          : "Perpl has no exchange account for this API key. Create the account (approve, createAccount) first, or enter the account id.",
    );
  }

  // ---- health -----------------------------------------------------------------------------------------------------

  health(userId: string): PerplHealthDTO | undefined {
    const e = this.entries.get(userId);
    return e ? this.healthOf(e) : undefined;
  }

  private healthOf(e: Entry): PerplHealthDTO {
    const now = Date.now();
    // Perpl round trip: recent order round trips win, the timed public REST call is the fallback.
    const orderFresh = e.orderRttMs !== null && now - e.orderRttAt < 10 * 60_000;
    const latency = orderFresh ? e.orderRttMs : e.latencyMs;
    // Head block: heartbeat first (both modes), then whatever the trading socket knows right now.
    const head = e.head ?? e.raw?.tradingSocket.head ?? null;
    return {
      status: e.link,
      connected: e.link === "connected",
      mode: this.o.config.perplMode,
      accountId: e.creds.accountId,
      lastHeartbeatAt: e.lastHeartbeatAt,
      heartbeatAgeMs: e.lastHeartbeatAt === null ? null : Math.max(0, now - e.lastHeartbeatAt),
      latencyMs: latency === null ? null : Math.round(latency * 10) / 10,
      latencySource: latency === null ? null : orderFresh ? "order" : "probe",
      headBlock: head,
      blockTimeMs: e.blockTimeMs !== null ? Math.round(e.blockTimeMs) : e.link === "connected" ? DEFAULT_BLOCK_TIME_MS : null,
      reconnects: e.reconnects,
      lastError: e.error?.message ?? null,
      lastErrorCode: e.error?.code ?? null,
      at: now,
    };
  }

  /** Health snapshot only (errors, periodic refresh). */
  private publishHealth(e: Entry): void {
    this.o.bus.publish(e.userId, { type: "perpl_status", health: this.healthOf(e) });
  }

  /** Link state changed: health snapshot plus the plain `perpl` status event older clients listen to. */
  private publish(e: Entry): void {
    this.publishHealth(e);
    this.o.bus.publish(e.userId, { type: "perpl", status: e.link });
  }

  private setLink(e: Entry, link: PerplLinkStatus): void {
    if (e.link === link) return;
    e.link = link;
    this.publish(e);
  }

  private setError(e: Entry, err: ClassifiedPerplError | { code: string; message: string } | null): void {
    const next = err ? { code: err.code, message: err.message } : null;
    if (e.error?.code === next?.code && e.error?.message === next?.message) return;
    e.error = next;
    this.publishHealth(e);
  }

  // ---- entries and connecting -------------------------------------------------------------------------------------

  private makeEntry(userId: string, creds: PerplCredentialsInput): Entry {
    const entry: Entry = {
      userId,
      fingerprint: fingerprintOf(creds),
      creds,
      facade: undefined as unknown as PerplClient,
      link: "reconnecting",
      disposed: false,
      everConnected: false,
      reconnects: 0,
      lastHeartbeatAt: null,
      head: null,
      latencyMs: null,
      orderRttMs: null,
      orderRttAt: 0,
      blockTimeMs: null,
      hbBase: null,
      error: null,
      offs: [],
      statusListeners: new Set(),
      restored: false,
      tickCount: 0,
      loopRunning: false,
    };
    entry.facade = this.makeFacade(entry);
    return entry;
  }

  private makeFacade(e: Entry): PerplClient {
    const need = (): ServerPerplClient => {
      if (!e.adapter || e.link !== "connected") throw new Error("Perpl is not connected");
      return e.adapter;
    };
    return {
      connect: async () => {}, // the registry owns the lifecycle
      close: async () => {},
      isConnected: () => e.link === "connected" && e.raw?.isConnected() === true,
      onStatus: (cb) => {
        e.statusListeners.add(cb);
        return () => e.statusListeners.delete(cb);
      },
      getAccount: () => this.accountSummary(e),
      getPositions: () => need().getPositions(),
      getMarkPrice: (marketId) => need().getMarkPrice(marketId),
      placeOrder: (p) => need().placeOrder(p),
      cancel: (p) => need().cancel(p),
      headBlock: () => need().headBlock(),
    };
  }

  private createRaw(userId: string, creds: PerplCredentialsInput): RawPerplClient {
    const row = this.o.repos.connections.get(userId);
    const lastRq = row && row.accountId === creds.accountId ? row.lastRq : 0;
    const accountId = Number(creds.accountId);
    const log = this.log;
    return new RawPerplClient({
      restUrl: this.restUrl(),
      wsUrl: this.wsUrl(),
      chainId: this.chainId(),
      apiKey: creds.apiKeyPublic,
      apiSecret: creds.apiKeyPrivate,
      ...(Number.isInteger(accountId) && accountId > 0 ? { accountId } : {}),
      lastRq,
      // Persisted synchronously, BEFORE the frame leaves: a crash can never lead to a reused rq.
      onRqAdvance: (rq) => {
        this.o.repos.connections.setLastRq(userId, rq);
      },
      logger: {
        debug() {},
        info: (m, x) => log.info(x ?? {}, m),
        warn: (m, x) => log.warn(x ?? {}, m),
        error: (m, x) => log.error(x ?? {}, m),
      },
      defaultMaxSlippageBps: 50,
    });
  }

  /** Background connect with back-off until it works, the entry is disposed or the failure is not retryable. */
  private async connectLoop(e: Entry): Promise<void> {
    if (e.loopRunning) return;
    e.loopRunning = true;
    const schedule = this.o.backoffMs ?? DEFAULT_BACKOFF;
    let attempt = 0;
    try {
      while (!e.disposed && !this.stopped) {
        this.setLink(e, "reconnecting");
        let raw: RawPerplClient | undefined;
        try {
          this.enrollInSim(e.creds);
          raw = this.createRaw(e.userId, e.creds);
          await withTimeout(raw.connect(), this.o.connectTimeoutMs ?? 20_000, "connecting to Perpl");
          if (e.disposed) {
            await raw.close().catch(() => {});
            return;
          }
          this.adopt(e, raw);
          return;
        } catch (err) {
          await raw?.close().catch(() => {});
          const c = err instanceof HermesError ? { code: err.code, message: err.message, permanent: true } : classifyPerplError(err);
          this.log.warn({ userId: e.userId, code: c.code, attempt }, `Perpl connect failed: ${c.message}`);
          this.setError(e, c);
          if (c.code === "perpl_invalid_key_format" || c.code === "perpl_account_not_found") {
            // retrying cannot help, but keep the entry so the UI shows why; a new PUT replaces it
            this.setLink(e, "disconnected");
            return;
          }
          const delay = schedule[Math.min(attempt, schedule.length - 1)] ?? 30_000;
          attempt++;
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, delay);
            e.wake = () => {
              clearTimeout(t);
              resolve();
            };
          });
          e.wake = undefined;
        }
      }
    } finally {
      e.loopRunning = false;
    }
  }

  /** Wire a connected raw client into the entry: events, DB snapshots, SSE pushes. */
  private adopt(e: Entry, raw: RawPerplClient): void {
    for (const off of e.offs) off();
    e.offs = [];
    e.raw = raw;
    e.adapter = toServerClient(raw);
    void e.adapter.connect(); // already connected: only wires the adapter's own event forwarding
    e.offs.push(
      e.adapter.onStatus((ev: ServerPerplEvent) => {
        for (const l of [...e.statusListeners]) {
          try {
            l(ev);
          } catch {
            /* a faulty listener must never break the client */
          }
        }
      }),
      raw.on("heartbeat", (h) => {
        e.lastHeartbeatAt = Date.now();
        e.head = h.head;
        this.noteHeartbeat(e, h.head);
      }),
      raw.on("connected", () => {
        if (e.disposed) return;
        if (e.everConnected) e.reconnects++;
        e.everConnected = true;
        this.setError(e, null);
        this.setLink(e, "connected");
        void this.syncAll(e);
      }),
      raw.on("disconnected", (d) => {
        if (e.disposed) return;
        this.log.warn({ userId: e.userId, code: d.code, reason: d.reason, willReconnect: d.willReconnect }, "Perpl socket disconnected");
        this.setLink(e, "reconnecting");
        if (!d.willReconnect) {
          // the socket gave up (for example repeated 3401): build a fresh client with back-off
          const dead = e.raw;
          e.raw = undefined;
          e.adapter = undefined;
          for (const off of e.offs) off();
          e.offs = [];
          void dead?.close().catch(() => {});
          void this.connectLoop(e);
        }
      }),
      raw.on("positions", (ps) => this.persistPositions(e, ps)),
      raw.on("account", (a) => {
        if (a.fw === false) {
          this.setError(e, { code: "perpl_forwarding_disabled", message: "Order forwarding is switched off on the Perpl account: orders will fail until allowOrderForwarding(true) is sent from the wallet." });
        } else if (e.error?.code === "perpl_forwarding_disabled") {
          this.setError(e, null);
        }
        this.scheduleAccountPublish(e);
      }),
      raw.on("fill", () => this.scheduleAccountPublish(e)),
      raw.on("warning", (w) => this.log.warn({ userId: e.userId, code: w.code, detail: w.detail }, "Perpl client warning")),
      raw.on("error", (err) => this.log.warn({ userId: e.userId, err: err.message }, "Perpl client error")),
    );
    // record the raw Perpl frames of every order (mt:22 out, mt:3 / mt:24 / mt:25 in)
    e.offs.push(this.frames.attach(e.userId, raw.tradingSocket));
    e.everConnected = true;
    e.link = "connected";
    e.error = null;
    e.lastHeartbeatAt = Date.now();
    e.hbBase = null;
    const head0 = raw.tradingSocket.head;
    if (head0 !== undefined) e.head = head0;
    this.publish(e);
    const stored = this.o.repos.positions.list(e.userId); // read before the first sync overwrites it with live state
    void this.syncAll(e).then(() => this.maybeRestoreSimPositions(e, stored));
    void this.probeLatency(e).then(() => this.publishHealth(e));
  }

  private async dispose(e: Entry): Promise<void> {
    e.disposed = true;
    e.wake?.();
    if (e.accountTimer) clearTimeout(e.accountTimer);
    for (const off of e.offs) off();
    e.offs = [];
    const raw = e.raw;
    e.raw = undefined;
    e.adapter = undefined;
    e.link = "disconnected";
    e.statusListeners.clear();
    await raw?.close().catch(() => {});
  }

  // ---- snapshots and pushes ---------------------------------------------------------------------------------------

  private persistPositions(e: Entry, ps: PerplPosition[]): void {
    if (e.disposed) return;
    this.o.repos.positions.replaceAll(e.userId, ps.map(toSharedPosition));
    this.o.bus.publish(e.userId, { type: "positions", positions: this.o.repos.positions.list(e.userId) });
    this.scheduleAccountPublish(e);
  }

  private async syncAll(e: Entry): Promise<void> {
    const raw = e.raw;
    if (!raw || e.disposed) return;
    try {
      this.persistPositions(e, await raw.getPositions()); // also schedules the account push
    } catch (err) {
      this.log.warn({ userId: e.userId, err: (err as Error).message }, "Perpl snapshot sync failed");
    }
  }

  private scheduleAccountPublish(e: Entry): void {
    if (e.accountTimer || e.disposed) return;
    e.accountTimer = setTimeout(() => {
      e.accountTimer = undefined;
      void this.publishAccount(e);
    }, 25);
    e.accountTimer.unref();
  }

  private async publishAccount(e: Entry): Promise<void> {
    if (e.disposed || !e.raw) return;
    try {
      const account = await this.accountSummary(e);
      if (account.collateralUsd > 0) this.o.repos.connections.setCollateral(e.userId, account.collateralUsd);
      this.o.bus.publish(e.userId, { type: "account", account });
    } catch {
      /* not connected right now */
    }
  }

  /** Live account summary: equity, free collateral, margin used, uPnL; realised PnL today comes from the DB. */
  private async accountSummary(e: Entry): Promise<AccountSummary> {
    const raw = e.raw;
    if (!raw || e.link !== "connected") throw new Error("Perpl is not connected");
    const a = await raw.getAccount();
    return withTodayPnl(this.o.repos, e.userId, {
      connected: a.connected,
      accountId: a.accountId === null ? null : String(a.accountId),
      collateralUsd: a.balanceUsd + a.positionCollateralUsd,
      equityUsd: a.equityUsd,
      availableUsd: a.availableUsd,
      openNotionalUsd: a.openNotionalUsd,
      unrealizedPnlUsd: a.unrealizedPnlUsd,
      realizedPnlTodayUsd: 0, // replaced by withTodayPnl (database value)
      updatedAt: a.updatedAtMs,
      live: a.live,
      marginUsedUsd: a.positionCollateralUsd,
    });
  }

  /** Timed public REST call: a smoothed round-trip estimate to Perpl, plus a head block fallback. */
  private async probeLatency(e: Entry): Promise<void> {
    const raw = e.raw;
    if (!raw || e.disposed) return;
    try {
      const t0 = performance.now();
      const head = await withTimeout(raw.rest.getHeadBlock(), 4_000, "latency probe");
      const rtt = performance.now() - t0;
      e.latencyMs = e.latencyMs === null ? rtt : e.latencyMs * 0.6 + rtt * 0.4;
      if (head !== undefined && (e.head === null || head > e.head)) e.head = head;
    } catch {
      /* a failed probe just leaves the old estimate */
    }
  }

  /** Block time = elapsed time / head advance over a sliding window of at least 5 s (heartbeats are about 1 s apart). */
  private noteHeartbeat(e: Entry, head: number): void {
    const t = performance.now();
    if (!e.hbBase || head < e.hbBase.head) {
      e.hbBase = { head, at: t };
      return;
    }
    const dBlocks = head - e.hbBase.head;
    const dMs = t - e.hbBase.at;
    if (dBlocks >= 3 && dMs >= 2_000) {
      const bt = dMs / dBlocks;
      if (bt >= 20 && bt <= 20_000) e.blockTimeMs = e.blockTimeMs === null ? bt : e.blockTimeMs * 0.6 + bt * 0.4;
      if (dMs >= 30_000) e.hbBase = { head, at: t };
    }
  }

  /** Periodic push so marks, head block and latency keep moving on the dashboard. */
  private async tick(): Promise<void> {
    if (this.stopped) return;
    for (const e of this.entries.values()) {
      if (e.disposed || e.link !== "connected" || !e.raw) continue;
      e.tickCount++;
      if (e.tickCount % 3 === 1) await this.probeLatency(e);
      if (this.o.bus.listenerCount > 0) {
        this.publishHealth(e);
        await this.syncAll(e);
      }
    }
  }

  // ---- simulator only: keep demo positions across simulator restarts ----------------------------------------------

  /**
   * The simulator keeps no state on disk, so after a server restart a fresh simulated account has no positions while
   * the stored snapshot (the seeded demo, or yesterday's session) still lists some. Re-open them at the current
   * simulated price so the dashboard and the next close alert match what the history says. Never runs against live Perpl.
   */
  private async maybeRestoreSimPositions(e: Entry, stored: Position[]): Promise<void> {
    if (!this.o.simulator || this.o.restoreSimPositions === false || e.restored || e.disposed || !e.raw) return;
    e.restored = true;
    try {
      const live = await e.raw.getPositions();
      if (live.length > 0) return;
      for (const p of stored) {
        if (!isMarketSymbol(p.market) || !(p.size > 0) || e.disposed || !e.raw) continue;
        const out = await e.raw.placeMarketOrder({
          market: MARKETS[p.market].symbol,
          side: p.side,
          kind: "open",
          sizeBase: p.size,
          leverage: 3,
          maxSlippageBps: 100,
          tag: "sim-restore",
        });
        this.log.info(
          { userId: e.userId, market: p.market, side: p.side, size: p.size, status: out.status },
          "restored a stored position into the fresh simulated account",
        );
      }
    } catch (err) {
      this.log.warn({ userId: e.userId, err: (err as Error).message }, "could not restore simulated positions");
    }
  }
}
