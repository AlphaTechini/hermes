import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, getAddress, toFunctionSelector } from "viem";
import { PerplRest, PerplGeoBlockedError, PerplHttpError, PerplNetworkError, parseContext } from "../src/rest";
import { PerplTradingSocket, HeartbeatGapError, NotConnectedError, RateLimitedError } from "../src/trading-ws";
import { PerplMarketData } from "../src/market-data";
import { TokenBucket, backoffDelay } from "../src/util";
import { startPerplSimulator, SIM_MARKETS, type PerplSimulator } from "../src/sim";
import { Ed25519Signer, canonicalRest, verifySignature } from "../src/signing";
import { RECONNECT_DELAYS_MS } from "../src/protocol";
import { BTC } from "./fake-socket";
import {
  PERPL_TESTNET,
  PerplChain,
  buildAllowOrderForwardingTx,
  buildApproveTx,
  buildCreateAccountTx,
  buildDepositTx,
  buildFaucetRequestTx,
  buildIncreasePositionCollateralTx,
  buildSetupPlan,
  monadTestnet,
} from "../src/chain";
import { exchangeAbi } from "../src/abi/exchange";
import { erc20Abi } from "../src/abi/erc20";
import { agoraFaucetAbi } from "../src/abi/faucet";
import { waitFor } from "./helpers";

let sim: PerplSimulator | undefined;
afterEach(async () => {
  await sim?.stop();
  sim = undefined;
  vi.useRealTimers();
});

describe("TokenBucket and backoff", () => {
  it("60 per minute, starts full, refills continuously", () => {
    let now = 0;
    const b = new TokenBucket(60, 60_000, () => now);
    for (let i = 0; i < 60; i++) expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    expect(b.msUntil()).toBe(1000);
    now += 999;
    expect(b.tryTake()).toBe(false);
    now += 1;
    expect(b.tryTake()).toBe(true);
    now += 120_000;
    expect(b.available).toBe(60);
  });
  it("exponential schedule with jitter", () => {
    const d = RECONNECT_DELAYS_MS;
    expect(backoffDelay(0, d, 0)).toBe(1000);
    expect(backoffDelay(3, d, 0)).toBe(8000);
    expect(backoffDelay(6, d, 0)).toBe(60000);
    expect(backoffDelay(99, d, 0)).toBe(60000);
    expect(backoffDelay(2, d, 0.25, () => 1)).toBe(5000);
    expect(backoffDelay(2, d, 0.25, () => 0)).toBe(4000);
  });
});

describe("PerplRest with a mocked fetch", () => {
  const ctx = {
    chain: { chain_id: 10143, gas: { h: 5 } },
    instances: [{ id: 12, address: PERPL_TESTNET.exchange, collateral_token_id: 1, min_account_open_amount: "100000000", min_deposit_amount: "10000000" }],
    tokens: [{ id: 1, address: PERPL_TESTNET.collateral, symbol: "AUSD", decimals: 6 }],
    markets: [{ id: 16, instance_id: 12, symbol: "BTC", order_ttl_blocks: 20, order_max_market_slippage_bps: 1000, config: { price_decimals: 1, size_decimals: 5, initial_margin: 1500 } }],
    geo_block: ["US"],
  };
  const res = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

  it("parses the context into markets with instance_id, decimals and ttl", async () => {
    const f = vi.fn(async () => res(200, ctx));
    const rest = new PerplRest({ baseUrl: "https://testnet.perpl.xyz/api/", chainId: 10143, fetch: f as never });
    const c = await rest.getContext();
    expect(f).toHaveBeenCalledWith("https://testnet.perpl.xyz/api/v1/pub/context", expect.objectContaining({ method: "GET" }));
    expect(c.collateral).toEqual({ tokenId: 1, address: PERPL_TESTNET.collateral, symbol: "AUSD", decimals: 6 });
    expect(c.minDepositAmount).toBe(10_000_000n);
    expect(c.instance.exchangeAddress).toBe(PERPL_TESTNET.exchange);
    expect(c.markets[0]).toMatchObject({ id: 16, instanceId: 12, priceDecimals: 1, sizeDecimals: 5, orderTtlBlocks: 20, maxSlippageBps: 1000, maxLeverageHdths: 1500 });
    expect(c.geoBlock).toEqual(["US"]);
    expect(() => parseContext({ chain: { chain_id: 1 } })).toThrow(/no protocol instance/);
    expect(() => parseContext({})).toThrow(/invalid/);
  });

  it("451 becomes PerplGeoBlockedError with an actionable message, not retried", async () => {
    const f = vi.fn(async () => res(451, { error: "blocked" }));
    const rest = new PerplRest({ baseUrl: "https://x/api", chainId: 10143, fetch: f as never, sleep: async () => {} });
    const err = await rest.getContext().catch((e) => e);
    expect(err).toBeInstanceOf(PerplGeoBlockedError);
    expect(err).toBeInstanceOf(PerplHttpError);
    expect(err.status).toBe(451);
    expect(err.message).toMatch(/451/);
    expect(err.message).toMatch(/EU/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("503 and 429 are retried with exponential back-off, then succeed", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(503, "warming up")).mockResolvedValueOnce(res(429, {})).mockResolvedValueOnce(res(200, ctx));
    const sleeps: number[] = [];
    const rest = new PerplRest({ baseUrl: "https://x/api", chainId: 10143, fetch: f as never, sleep: async (ms) => void sleeps.push(ms), retryBaseMs: 100 });
    await rest.getContext();
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it("gives up after maxRetries and surfaces the status", async () => {
    const f = vi.fn(async () => res(503, "still warming"));
    const rest = new PerplRest({ baseUrl: "https://x/api", chainId: 10143, fetch: f as never, sleep: async () => {}, maxRetries: 1 });
    await expect(rest.getTicker()).rejects.toMatchObject({ status: 503, isRetryable: true });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("404 on the wallet endpoint = no exchange account", async () => {
    const rest = new PerplRest({ baseUrl: "https://x/api", chainId: 10143, apiKey: "k", apiSecret: Ed25519Signer.generate().seedHex, fetch: (async () => res(404, { error: "no account" })) as never });
    await expect(rest.getWallet()).rejects.toMatchObject({ status: 404, isNotFound: true });
    expect(await rest.getWalletOrNull()).toBeNull();
  });

  it("network errors are wrapped and retried", async () => {
    const f = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(res(200, ctx));
    const rest = new PerplRest({ baseUrl: "https://x/api", chainId: 10143, fetch: f as never, sleep: async () => {} });
    await rest.getContext();
    expect(f).toHaveBeenCalledTimes(2);
    const g = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const bad = new PerplRest({ baseUrl: "https://x/api", chainId: 10143, fetch: g as never, sleep: async () => {}, maxRetries: 0 });
    await expect(bad.getContext()).rejects.toBeInstanceOf(PerplNetworkError);
  });

  it("signs the request target WITHOUT the /api prefix, with the exact body that is sent", async () => {
    const signer = Ed25519Signer.generate().signer;
    const captured: Array<{ url: string; init: RequestInit }> = [];
    const rest = new PerplRest({
      baseUrl: "https://testnet.perpl.xyz/api",
      chainId: 10143,
      apiKey: "TOKEN",
      apiSecret: signer,
      nowMs: () => 1_789_000_000_000,
      fetch: (async (url: string, init: RequestInit) => {
        captured.push({ url, init });
        return res(200, { d: [], np: "" });
      }) as never,
    });
    await rest.getFills({ count: 100, page: "abc" });
    const h1 = captured[0]!.init.headers as Record<string, string>;
    expect(captured[0]!.url).toBe("https://testnet.perpl.xyz/api/v1/trading/fills?count=100&page=abc");
    expect(h1["X-API-Key"]).toBe("TOKEN");
    const canon1 = canonicalRest({ chainId: 10143, method: "GET", target: "/v1/trading/fills?count=100&page=abc", timestamp: h1["X-API-Timestamp"]!, nonce: h1["X-API-Nonce"]!, body: "" });
    expect(verifySignature(signer.publicKey, canon1, h1["X-API-Signature"]!)).toBe(true);

    await rest.postOrders([{ rq: 1, mkt: 16, acc: 1, t: 1, p: 0, s: 100, fl: 4, lv: 300, lb: 0 }], 5).catch(() => {});
    const sent = captured[1]!;
    const h2 = sent.init.headers as Record<string, string>;
    expect(h2["content-type"]).toBe("application/json");
    const canon2 = canonicalRest({ chainId: 10143, method: "POST", target: "/v1/trading/orders", timestamp: h2["X-API-Timestamp"]!, nonce: h2["X-API-Nonce"]!, body: sent.init.body as string });
    expect(verifySignature(signer.publicKey, canon2, h2["X-API-Signature"]!)).toBe(true);
    expect(JSON.parse(sent.init.body as string)).toEqual({ sn: 5, d: [{ rq: 1, mkt: 16, acc: 1, t: 1, p: 0, s: 100, fl: 4, lv: 300, lb: 0 }] });
  });

  it("every retry is re-signed with a fresh nonce", async () => {
    const nonces: string[] = [];
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      nonces.push((init.headers as Record<string, string>)["X-API-Nonce"]!);
      return nonces.length < 3 ? res(503, "") : res(200, { mt: 23, sn: 1, d: [] });
    });
    const rest = new PerplRest({ baseUrl: "https://x/api", chainId: 10143, apiKey: "k", apiSecret: Ed25519Signer.generate().signer, fetch: f as never, sleep: async () => {} });
    await rest.getOrders();
    expect(new Set(nonces).size).toBe(3);
  });

  it("rejects targets that do not start with /v1/", async () => {
    const rest = new PerplRest({ baseUrl: "https://x/api", chainId: 10143 });
    await expect(rest.request("GET", "/api/v1/pub/context")).rejects.toThrow(/must start with \/v1\//);
  });
});

describe("PerplTradingSocket against the simulator", () => {
  async function socketRig(simOpts: Parameters<typeof startPerplSimulator>[0] = {}, sockOpts: Partial<ConstructorParameters<typeof PerplTradingSocket>[0]> = {}) {
    sim = await startPerplSimulator({ seed: 5, blockTimeMs: 30, heartbeatIntervalMs: 50, latencyMs: [10, 20], ...simOpts });
    const key = sim.enrollNewKey();
    const sock = new PerplTradingSocket({ wsUrl: sim.wsUrl, chainId: 10143, apiKey: key.apiKey, signer: key.signer, backoffMs: [20, 40], jitter: 0, ...sockOpts });
    return { sim, key, sock };
  }

  it("connect resolves on the wallet snapshot, emits typed events, tracks the head", async () => {
    const { sock, key } = await socketRig();
    const seen: string[] = [];
    sock.on("connected", (c) => seen.push(`connected:${c.epoch}`));
    sock.on("walletSnapshot", (w) => seen.push(`wallet:${w.as[0]?.id === key.accountId}`));
    sock.on("orders", (o) => seen.push(`orders:${o.snapshot}`));
    sock.on("positions", (p) => seen.push(`positions:${p.snapshot}`));
    await sock.connect();
    expect(sock.state).toBe("ready");
    expect(await sock.whenSnapshots(2000)).toBe(true);
    await waitFor(() => sock.head !== undefined && sock.heartbeatsSeen);
    expect(seen).toEqual(["wallet:true", "connected:1", "orders:true", "positions:true"]);
    await sock.close();
    expect(sock.state).toBe("closed");
  });

  it("nextSn is unique, non-zero and increasing across the socket's lifetime", async () => {
    const { sock } = await socketRig({}, { initialSn: 10 });
    const sns = Array.from({ length: 5 }, () => sock.nextSn());
    expect(sns).toEqual([11, 12, 13, 14, 15]);
    await sock.close().catch(() => {});
  });

  it("rejects the first connect on an auth failure (3401) without retrying forever", async () => {
    const { sock } = await socketRig({}, { signer: Ed25519Signer.generate().signer });
    await expect(sock.connect()).rejects.toThrow(/3401/);
    expect(sock.state).toBe("closed");
  });

  it("a heartbeat gap forces a reconnect (backoff) and emits HeartbeatGapError", async () => {
    const { sock, sim } = await socketRig();
    await sock.connect();
    const errors: Error[] = [];
    sock.on("error", (e) => errors.push(e));
    const discon: string[] = [];
    sock.on("disconnected", (d) => discon.push(d.forced ?? "?"));
    sim.inject({ kind: "heartbeat_gap" });
    await waitFor(() => sock.epoch === 2 && sock.isReady());
    expect(errors.some((e) => e instanceof HeartbeatGapError)).toBe(true);
    expect(discon[0]).toMatch(/heartbeat gap/);
    await sock.close();
  });

  it("silence (no heartbeats) beyond the watchdog forces a reconnect", async () => {
    const { sock, sim } = await socketRig({ heartbeatIntervalMs: 60_000 }, { heartbeatTimeoutMs: 150 });
    await sock.connect();
    // the first heartbeat never comes (60 s interval): the watchdog is only armed after the first one, so nothing happens
    await new Promise((r) => setTimeout(r, 400));
    expect(sock.epoch).toBe(1);
    expect(sim.tradingConnections()).toBe(1);
    await sock.close();
  });

  it("server restart (1001) reconnects immediately; epochs increase", async () => {
    const { sock, sim } = await socketRig();
    await sock.connect();
    const t0 = Date.now();
    sim.dropConnections(1001, "going away");
    await waitFor(() => sock.epoch === 2 && sock.isReady());
    expect(Date.now() - t0).toBeLessThan(1500);
    await sock.close();
  });

  it("1011 is surfaced as an error and reconnects with backoff", async () => {
    const { sock, sim, key } = await socketRig();
    await sock.connect();
    const errors: string[] = [];
    sock.on("error", (e) => errors.push(e.message));
    await sock.whenSnapshots();
    await sock.send({ mt: 22, sn: sock.nextSn(), rq: 1, mkt: 999, acc: key.accountId, t: 1, p: 0, s: 1, fl: 4, lv: 100, lb: 0 });
    await waitFor(() => errors.some((m) => /1011/.test(m)));
    await waitFor(() => sock.epoch === 2 && sock.isReady());
    expect(sim.receivedOrderFrames()).toBe(1);
    await sock.close();
  });

  it("token bucket: sends beyond the budget wait, then fail with RateLimitedError", async () => {
    const { sock } = await socketRig({}, { maxRequestsPerMinute: 4, maxSendWaitMs: 200, pingIntervalMs: 0 });
    await sock.connect();
    // sign-in used 1 of 4
    await sock.send({ mt: 1, t: 1 });
    await sock.send({ mt: 1, t: 2 });
    await sock.send({ mt: 1, t: 3 });
    expect(sock.budgetRemaining).toBe(0);
    await expect(sock.send({ mt: 1, t: 4 })).rejects.toBeInstanceOf(RateLimitedError);
    await sock.close();
  });

  it("send while disconnected rejects with NotConnectedError", async () => {
    const { sock } = await socketRig();
    await expect(sock.send({ mt: 1, t: 1 })).rejects.toBeInstanceOf(NotConnectedError);
  });

  it("de-duplicates identical mt:3 frames", async () => {
    const { sock } = await socketRig();
    await sock.connect();
    const got: unknown[] = [];
    sock.on("status", (s) => got.push(s));
    const feed = (sock as unknown as { onMessage(t: string): void }).onMessage.bind(sock);
    const frame = JSON.stringify({ mt: 3, sid: 100, sn: 5, cid: 9, status: { code: 0, error: "" } });
    feed(frame);
    feed(frame);
    feed(JSON.stringify({ mt: 3, sid: 100, sn: 6, cid: 10, status: { code: 0, error: "" } }));
    expect(got).toHaveLength(2);
    await sock.close();
  });

  it("garbage frames raise an error event but never crash the socket", async () => {
    const { sock } = await socketRig();
    await sock.connect();
    const errors: Error[] = [];
    sock.on("error", (e) => errors.push(e));
    (sock as unknown as { onMessage(t: string): void }).onMessage("{not json");
    expect(errors).toHaveLength(1);
    expect(sock.isReady()).toBe(true);
    await sock.close();
  });
});

describe("PerplMarketData", () => {
  it("receives mt:9 over the socket, serves cached marks, tracks the head, falls back to REST when stale", async () => {
    sim = await startPerplSimulator({ seed: 5, blockTimeMs: 30, heartbeatIntervalMs: 50 });
    const rest = new PerplRest({ baseUrl: sim.url, chainId: 10143 });
    const ctx = await rest.getContext();
    const md = new PerplMarketData({ wsUrl: sim.wsUrl, chainId: 10143, getMarket: (id) => ctx.markets.find((m) => m.id === id), rest, staleAfterMs: 200 });
    const prices: number[] = [];
    md.on("price", (p) => p.marketId === 16 && prices.push(p.mark));
    await md.start();
    await waitFor(() => prices.length >= 3 && md.head !== undefined);
    const mark = await md.getMarkPrice(16);
    expect(Math.abs(mark / sim.getPrice("BTC") - 1)).toBeLessThan(0.001);
    expect(md.getCached(16)).toMatchObject({ source: "ws", marketId: 16 });
    expect(md.getCached(16)?.bid).toBeLessThan(md.getCached(16)?.ask as number);

    // stop the feed: the cache goes stale and the REST ticker takes over
    await md.stop();
    await new Promise((r) => setTimeout(r, 300));
    const viaRest = await md.getMarkPrice(16);
    expect(md.getCached(16)?.source).toBe("rest");
    expect(Math.abs(viaRest / sim.getPrice("BTC") - 1)).toBeLessThan(0.001);
    await expect(md.getMarkPrice(9999)).rejects.toThrow();
  });

  it("reconnects after the socket drops and keeps the subscription", async () => {
    sim = await startPerplSimulator({ seed: 5, blockTimeMs: 30, heartbeatIntervalMs: 50 });
    const rest = new PerplRest({ baseUrl: sim.url, chainId: 10143 });
    const ctx = await rest.getContext();
    const md = new PerplMarketData({ wsUrl: sim.wsUrl, chainId: 10143, getMarket: (id) => ctx.markets.find((m) => m.id === id), backoffMs: [30], jitter: 0 });
    const disc: number[] = [];
    md.on("disconnected", (d) => disc.push(d.code));
    await md.start();
    await waitFor(() => md.getCached(16));
    const before = md.getCached(16)!.atMs;
    // kill the market-data socket from the server side
    (md as unknown as { ws: { terminate(): void } }).ws.terminate();
    await waitFor(() => disc.length === 1);
    await waitFor(() => md.connected && (md.getCached(16)?.atMs ?? 0) > before + 50);
    await md.stop();
  });

  it("refuses more than 16 subscriptions", () => {
    expect(() => new PerplMarketData({ wsUrl: "ws://x", chainId: 1, getMarket: () => BTC, extraStreams: Array.from({ length: 15 }, (_, i) => `trades@${i}`) })).toThrow(/16/);
  });
});

describe("chain helpers (viem)", () => {
  it("chain definition", () => {
    expect(monadTestnet.id).toBe(10143);
    expect(monadTestnet.nativeCurrency.symbol).toBe("MON");
    expect(monadTestnet.rpcUrls.default.http[0]).toBe("https://testnet-rpc.monad.xyz");
  });

  it("calldata selectors match perpl.md section 3", () => {
    expect(buildApproveTx(1n).data.slice(0, 10)).toBe("0x095ea7b3");
    expect(buildCreateAccountTx(1n).data.slice(0, 10)).toBe("0xcab13915");
    expect(buildAllowOrderForwardingTx(true).data.slice(0, 10)).toBe("0x7962f910");
    expect(buildDepositTx(1n).data.slice(0, 10)).toBe("0xbad4a01f");
    expect(buildIncreasePositionCollateralTx(16, 1n).data.slice(0, 10)).toBe("0xf769f0d3");
    expect(toFunctionSelector("requestFunds(address)")).toBe(buildFaucetRequestTx(PERPL_TESTNET.faucet).data.slice(0, 10));
  });

  it("tx requests target the right contracts, value 0, round-trip decode", () => {
    const amount = 100_000_000n;
    const approve = buildApproveTx(amount);
    expect(approve).toMatchObject({ to: getAddress(PERPL_TESTNET.collateral), value: 0n });
    expect(decodeFunctionData({ abi: erc20Abi, data: approve.data })).toEqual({ functionName: "approve", args: [getAddress(PERPL_TESTNET.exchange), amount] });
    const create = buildCreateAccountTx(amount);
    expect(create.to).toBe(getAddress(PERPL_TESTNET.exchange));
    expect(decodeFunctionData({ abi: exchangeAbi, data: create.data })).toEqual({ functionName: "createAccount", args: [amount] });
    expect(decodeFunctionData({ abi: exchangeAbi, data: buildAllowOrderForwardingTx().data })).toEqual({ functionName: "allowOrderForwarding", args: [true] });
    expect(decodeFunctionData({ abi: exchangeAbi, data: buildDepositTx(15_000_000n).data })).toEqual({ functionName: "depositCollateral", args: [15_000_000n] });
    const wallet = "0x50B240678777451BEfd67B7e8c3b4366482ba8F9";
    const faucet = buildFaucetRequestTx(wallet);
    expect(faucet.to).toBe(PERPL_TESTNET.faucet);
    expect(decodeFunctionData({ abi: agoraFaucetAbi, data: faucet.data })).toEqual({ functionName: "requestFunds", args: [wallet] });
  });

  it("custom addresses (collateral read from pub/context) are honoured", () => {
    const tok = "0xdf5b0000000000000000000000000000000fc027";
    expect(buildApproveTx(5n, { collateral: tok }).to).toBe(getAddress(tok));
  });

  it("rejects zero amounts", () => {
    expect(() => buildApproveTx(0n)).toThrow(/> 0/);
    expect(() => buildDepositTx(-1n)).toThrow();
  });

  it("setup plan: approve -> createAccount -> allowOrderForwarding, skipping what is done", () => {
    const labels = (p: { label?: string }[]) => p.map((x) => x.label);
    expect(labels(buildSetupPlan({ amountCns: 100_000_000n, hasAccount: false, allowanceCns: 0n }))).toEqual(["Approve AUSD for Perpl", "Create Perpl account", "Enable order forwarding"]);
    expect(labels(buildSetupPlan({ amountCns: 100_000_000n, hasAccount: false, allowanceCns: 100_000_000n }))).toEqual(["Create Perpl account", "Enable order forwarding"]);
    expect(labels(buildSetupPlan({ amountCns: 1n, hasAccount: true, allowanceCns: 0n }))).toEqual(["Enable order forwarding"]);
    expect(buildSetupPlan({ amountCns: 1n, hasAccount: true, allowanceCns: 0n, forwardingEnabled: true })).toEqual([]);
    expect(() => buildSetupPlan({ amountCns: 99_999_999n, hasAccount: false, allowanceCns: 0n })).toThrow(/below the minimum/);
  });

  it("reads through an injected viem client", async () => {
    const calls: string[] = [];
    const client = {
      readContract: async ({ functionName }: { functionName: string }) => {
        calls.push(functionName);
        if (functionName === "getAccountByAddr") return { accountId: 7n, balanceCNS: 5n, lockedBalanceCNS: 1n, frozen: 0, accountAddr: PERPL_TESTNET.faucet, positions: {} };
        if (functionName === "balanceOf") return 250_000_000n;
        if (functionName === "allowance") return 0n;
        if (functionName === "getMinAccountOpenCNS") return 100_000_000n;
        throw new Error("unexpected " + functionName);
      },
    };
    const chain = new PerplChain({ publicClient: client as never });
    const owner = "0x50B240678777451BEfd67B7e8c3b4366482ba8F9";
    expect(await chain.getAccountByAddress(owner)).toMatchObject({ accountId: 7n, balanceCns: 5n, frozen: 0 });
    expect(await chain.getAusdBalance(owner)).toBe(250_000_000n);
    expect(await chain.getAusdAllowance(owner)).toBe(0n);
    expect(await chain.getMinAccountOpenCns()).toBe(100_000_000n);
    const status = await chain.getSetupStatus(owner);
    expect(status.account?.accountId).toBe(7n);
    expect(status.plan.map((p) => p.label)).toEqual(["Enable order forwarding"]);
  });

  it("AccountDoesNotExist revert means no account (null), other errors propagate", async () => {
    const revert = Object.assign(new Error('The contract function "getAccountByAddr" reverted with the following reason: AccountDoesNotExist'), { name: "ContractFunctionExecutionError" });
    const none = new PerplChain({ publicClient: { readContract: async () => Promise.reject(revert) } as never });
    expect(await none.getAccountByAddress("0x50B240678777451BEfd67B7e8c3b4366482ba8F9")).toBeNull();
    const down = new PerplChain({ publicClient: { readContract: async () => Promise.reject(new Error("fetch failed ECONNREFUSED")) } as never });
    await expect(down.getAccountByAddress("0x50B240678777451BEfd67B7e8c3b4366482ba8F9")).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("simulator markets", () => {
  it("match the documented testnet table", () => {
    expect(SIM_MARKETS.map((m) => [m.id, m.symbol, m.priceDecimals, m.sizeDecimals, m.initialMargin, m.startPrice])).toEqual([
      [16, "BTC", 1, 5, 1500, 112000],
      [32, "ETH", 2, 3, 1200, 4100],
      [48, "SOL", 2, 3, 1000, 210],
      [64, "MON", 5, 0, 300, 0.04],
      [256, "ZEC", 3, 3, 300, 60],
    ]);
  });
});
