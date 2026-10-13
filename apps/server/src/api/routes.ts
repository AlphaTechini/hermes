import {
  AlertStatus,
  CreateStrategyRequest,
  MARKETS,
  MARKET_SYMBOLS,
  PutPerplConnectionRequest,
  RegisterWalletRequest,
  ReportRangeSchema,
  RiskLimits,
  TestAlertRequest,
  UpdateStrategyRequest,
  hiresNowMs,
  isMarketSymbol,
  normalizeMarket,
  renderTradingViewMessage,
  tradingViewTemplates,
  APPROVAL_STATUSES,
  type AccountSummary,
  type AlertListResponse,
  type IngestResponse,
  type MarketDTO,
  type PerplConnectionDTO,
  type PerplContextDTO,
  type PerplLinkStatus,
  type StreamEvent,
  type StreamTicket,
} from "@hermes/shared";
import type { OutgoingHttpHeaders } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Auth } from "../auth/plugin";
import type { Config } from "../config";
import { decrypt, encrypt, generateSecret, shortId } from "../crypto";
import type { Repos } from "../db/repos";
import type { EventBus } from "../events/bus";
import { HermesError, notFound } from "../errors";
import type { Ingest } from "../ingest/handler";
import { PerplEnrollment } from "../perpl/enroll";
import type { PerplRuntime } from "../perpl/runtime";
import type { Pipeline } from "../pipeline/pipeline";
import { buildReportCard, priorWindow, rangeStart } from "../reports/report-card";
import { withTodayPnl } from "../risk/today";
import { LimitQuery, parse } from "./helpers";
import { toStrategyDTO, toStrategySecretDTO, toUserDTO } from "./serializers";

export interface ApiDeps {
  config: Config;
  repos: Repos;
  auth: Auth;
  pipeline: Pipeline;
  ingest: Ingest;
  bus: EventBus;
  perpl?: PerplRuntime | undefined;
}

/** Only used to size test alerts when no live price is available. */
const REFERENCE_PRICES: Record<string, number> = { BTC: 112000, ETH: 3900, SOL: 190, MON: 0.04, ZEC: 45 };

const AlertsQuery = z.object({
  strategyId: z.string().min(1).optional(),
  status: AlertStatus.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export function apiRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { config, repos, auth, pipeline, ingest, bus } = deps;
  const perpl = () => deps.perpl;

  app.get("/healthz", async () => {
    repos.db.prepare("SELECT 1").get();
    return {
      ok: true,
      authMode: config.authMode,
      perplMode: config.perplMode,
      uptimeSec: Math.round(process.uptime()),
    };
  });

  // ---------------------------------------------------------------------
  // Stream (own auth: ticket or token in the query string, since EventSource cannot set headers)
  // ---------------------------------------------------------------------
  const sseResponses = new Set<import("node:http").ServerResponse>();
  app.addHook("onClose", async () => {
    for (const res of sseResponses) res.end();
    sseResponses.clear();
  });

  app.get<{ Querystring: { ticket?: string; token?: string } }>("/api/stream", async (req, reply) => {
    const { ticket, token } = req.query;
    let user = ticket ? auth.userFromTicket(ticket) : undefined;
    if (!user && !ticket) {
      const header = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
      user = await auth.userFromToken(token ?? header);
    }
    if (!user) throw new HermesError(401, "unauthorized", "Invalid or expired stream ticket");
    const userId = user.id;

    reply.hijack();
    const res = reply.raw;
    sseResponses.add(res);
    res.writeHead(200, {
      ...(reply.getHeaders() as OutgoingHttpHeaders),
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (e: StreamEvent) => {
      if (!res.writableEnded) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    res.write("retry: 3000\n\n");
    send({ type: "ready", at: Date.now() });
    const health = perpl()?.health?.(userId);
    if (health) send({ type: "perpl_status", health }); // current link state right away, not on the next push
    const unsubscribe = bus.subscribe((m) => {
      if (m.userId === userId) send(m.event);
    });
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 15_000);
    heartbeat.unref();
    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      sseResponses.delete(res);
    });
    return reply;
  });

  // ---------------------------------------------------------------------
  // Authenticated JSON API
  // ---------------------------------------------------------------------
  app.register(async (api) => {
    api.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => auth.authenticate(req, reply));

    const strategyOf = (req: FastifyRequest) => {
      const id = (req.params as { id: string }).id;
      const s = repos.strategies.get(id);
      if (!s || s.userId !== req.user.id) throw notFound("strategy");
      return s;
    };

    // --- session ---
    api.get("/api/me", async (req) => toUserDTO(config, req.user));

    api.post("/api/me/wallet", async (req) => {
      const body = parse(RegisterWalletRequest, req.body);
      const u = repos.users.setWallet(req.user.id, body.address, body.email);
      return toUserDTO(config, u ?? req.user);
    });

    api.post("/api/stream-ticket", async (req): Promise<StreamTicket> => auth.mintStreamTicket(req.user.id));

    // --- limits ---
    api.get("/api/limits", async (req) => repos.limits.get(req.user.id));
    api.put("/api/limits", async (req) => {
      const body = parse(RiskLimits, req.body);
      const markets = [...new Set(body.allowedMarkets.map((m) => normalizeMarket(m)))];
      const unknown = markets.filter((m) => !isMarketSymbol(m));
      if (unknown.length) {
        throw new HermesError(400, "validation_error", `Unknown markets: ${unknown.join(", ")}. Supported: ${MARKET_SYMBOLS.join(", ")}`);
      }
      return repos.limits.put(req.user.id, { ...body, allowedMarkets: markets });
    });

    // --- strategies ---
    api.get("/api/strategies", async (req) =>
      repos.strategies.listByUser(req.user.id).map((s) => toStrategyDTO(config, repos, s)),
    );

    api.post("/api/strategies", async (req, reply) => {
      const body = parse(CreateStrategyRequest, req.body);
      const market = body.defaultMarket ? normalizeMarket(body.defaultMarket) : null;
      const row = repos.strategies.create({
        id: shortId(12),
        userId: req.user.id,
        name: body.name,
        secretEnc: encrypt(generateSecret(), config.masterKey),
        enabled: body.enabled ?? true,
        defaultMarket: market || null,
        defaultSizeUsd: body.defaultSizeUsd ?? null,
        defaultLeverage: body.defaultLeverage ?? null,
        dryRun: body.dryRun ?? false,
        maxSlippageBps: body.maxSlippageBps ?? null,
        orderType: body.orderType ?? "market",
      });
      return reply.code(201).send(toStrategySecretDTO(config, repos, row));
    });

    api.get("/api/strategies/:id", async (req) => toStrategyDTO(config, repos, strategyOf(req)));

    api.patch("/api/strategies/:id", async (req) => {
      const s = strategyOf(req);
      const body = parse(UpdateStrategyRequest, req.body);
      const patch: Parameters<Repos["strategies"]["update"]>[1] = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.defaultMarket !== undefined) patch.defaultMarket = body.defaultMarket ? normalizeMarket(body.defaultMarket) || null : null;
      if (body.defaultSizeUsd !== undefined) patch.defaultSizeUsd = body.defaultSizeUsd;
      if (body.defaultLeverage !== undefined) patch.defaultLeverage = body.defaultLeverage;
      if (body.dryRun !== undefined) patch.dryRun = body.dryRun;
      if (body.maxSlippageBps !== undefined) patch.maxSlippageBps = body.maxSlippageBps;
      if (body.orderType !== undefined) patch.orderType = body.orderType;
      const updated = repos.strategies.update(s.id, patch) ?? s;
      return toStrategyDTO(config, repos, updated);
    });

    api.delete("/api/strategies/:id", async (req) => {
      const s = strategyOf(req);
      repos.strategies.delete(s.id);
      return { ok: true };
    });

    api.post("/api/strategies/:id/rotate-secret", async (req) => {
      const s = strategyOf(req);
      repos.strategies.setSecret(s.id, encrypt(generateSecret(), config.masterKey));
      return toStrategySecretDTO(config, repos, repos.strategies.get(s.id) ?? s);
    });

    api.get("/api/strategies/:id/secret", async (req) => toStrategySecretDTO(config, repos, strategyOf(req)));

    api.post("/api/strategies/:id/test-alert", async (req, reply) => {
      const s = strategyOf(req);
      const body = parse(TestAlertRequest, req.body ?? {});
      const secret = decrypt(s.secretEnc, config.masterKey);
      const action = body.action ?? "buy";
      const market = normalizeMarket(body.market ?? s.defaultMarket ?? "BTC");
      let price = body.price;
      if (price === undefined && isMarketSymbol(market)) {
        const client = perpl()?.get(req.user.id);
        if (client?.isConnected()) {
          try {
            price = await client.getMarkPrice(MARKETS[market].id);
          } catch {
            price = undefined;
          }
        }
      }
      price ??= REFERENCE_PRICES[market] ?? 100;
      const sizeUsd = body.sizeUsd ?? s.defaultSizeUsd ?? 100;

      // Exactly what TradingView does: take the alert message template and substitute its placeholders.
      const templates = tradingViewTemplates(secret, { action, sizeUsd });
      const useStrategy = body.marketPosition !== undefined;
      const text = renderTradingViewMessage(useStrategy ? templates.strategy : templates.indicator, {
        ticker: `${market}USDT.P`,
        close: String(price),
        timenow: new Date().toISOString(),
        "strategy.order.id": "hermes-test",
        "strategy.order.action": action,
        "strategy.order.contracts": String(Number((sizeUsd / price).toPrecision(6))),
        "strategy.market_position": body.marketPosition ?? "flat",
      });
      const result = ingest.handle({ strategyId: s.id, rawBody: text, receivedAtMs: hiresNowMs(), source: "test-alert" });
      if ("error" in result.body) return reply.code(result.status).send(result.body);
      const out: IngestResponse = { ...result.body, body: text.replace(secret, "[redacted]") };
      return reply.code(result.status).send(out);
    });

    // --- alerts ---
    api.get("/api/alerts", async (req): Promise<AlertListResponse> => {
      const q = parse(AlertsQuery, req.query);
      if (q.strategyId) {
        const s = repos.strategies.get(q.strategyId);
        if (!s || s.userId !== req.user.id) throw notFound("strategy");
      }
      let cursor: { receivedAtMs: number; id: string } | undefined;
      if (q.cursor) {
        const i = q.cursor.indexOf(":");
        const ms = Number(q.cursor.slice(0, i));
        if (i < 1 || !Number.isFinite(ms)) throw new HermesError(400, "validation_error", "Invalid cursor");
        cursor = { receivedAtMs: ms, id: q.cursor.slice(i + 1) };
      }
      return repos.alerts.list({ userId: req.user.id, strategyId: q.strategyId, status: q.status, limit: q.limit, cursor });
    });

    api.get<{ Params: { id: string } }>("/api/alerts/:id", async (req) => {
      const detail = repos.alertDetail(req.params.id);
      const row = repos.alerts.get(req.params.id);
      if (!detail || !row || row.userId !== req.user.id) throw notFound("alert");
      return detail;
    });

    // --- orders / fills / positions / account ---
    api.get("/api/orders", async (req) => repos.orders.list(req.user.id, parse(LimitQuery, req.query).limit));
    api.get("/api/fills", async (req) => repos.fills.list(req.user.id, parse(LimitQuery, req.query).limit));
    api.get("/api/positions", async (req) => pipeline.refreshPositions(req.user.id));

    api.get("/api/account", async (req): Promise<AccountSummary> => {
      const userId = req.user.id;
      const client = perpl()?.get(userId);
      const conn = repos.connections.get(userId);
      // todayPnlUsd = realised (database) + unrealised (Perpl position snapshot): what the loss stop is evaluated against
      const decorate = (a: AccountSummary): AccountSummary => withTodayPnl(repos, userId, a);
      if (client?.isConnected()) {
        try {
          const live = await client.getAccount();
          if (live.collateralUsd > 0) repos.connections.setCollateral(userId, live.collateralUsd);
          return decorate({ ...live, live: true });
        } catch (err) {
          req.log.warn({ err }, "getAccount failed, falling back to stored snapshot");
        }
      }
      const positions = repos.positions.list(userId);
      const openNotionalUsd = positions.reduce((a, p) => a + p.notionalUsd, 0);
      const unrealizedPnlUsd = positions.reduce((a, p) => a + p.upnl, 0);
      const collateralUsd = conn?.collateral ?? 0;
      return decorate({
        connected: false,
        accountId: conn?.accountId ?? null,
        collateralUsd,
        equityUsd: collateralUsd + unrealizedPnlUsd,
        availableUsd: Math.max(0, collateralUsd + unrealizedPnlUsd - openNotionalUsd / 10),
        openNotionalUsd,
        unrealizedPnlUsd,
        realizedPnlTodayUsd: 0,
        updatedAt: Date.now(),
        live: false,
      });
    });

    // --- markets ---
    // Mark prices for every Perpl market, so the UI never needs an open position to show one.
    api.get("/api/markets", async (req): Promise<MarketDTO[]> => {
      const client = perpl()?.get(req.user.id);
      const connected = Boolean(client?.isConnected());
      return Promise.all(
        MARKET_SYMBOLS.map(async (symbol): Promise<MarketDTO> => {
          const { id } = MARKETS[symbol];
          let markPrice: number | null = null;
          if (client && connected) {
            try {
              const p = await Promise.race([
                client.getMarkPrice(id),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error("mark price timed out")), 2_000).unref()),
              ]);
              markPrice = Number.isFinite(p) && p > 0 ? p : null;
            } catch (err) {
              req.log.debug({ err, symbol }, "mark price unavailable");
            }
          }
          return { symbol, id, markPrice };
        }),
      );
    });

    // --- approvals ---
    const ApprovalsQuery = z.object({
      status: z.enum(APPROVAL_STATUSES).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    });
    api.get("/api/approvals", async (req) => {
      const q = parse(ApprovalsQuery, req.query);
      return repos.approvals.list(req.user.id, q.status, q.limit).map((a) => repos.toApprovalDto(a));
    });
    api.post<{ Params: { id: string } }>("/api/approvals/:id/approve", async (req) =>
      pipeline.approve(req.params.id, req.user.id),
    );
    api.post<{ Params: { id: string } }>("/api/approvals/:id/reject", async (req) =>
      pipeline.reject(req.params.id, req.user.id),
    );

    // --- perpl connection ---
    const connectionDto = (userId: string): PerplConnectionDTO => {
      const row = repos.connections.get(userId);
      const client = perpl()?.get(userId);
      const health = row ? (perpl()?.health?.(userId) ?? null) : null;
      let status: PerplLinkStatus = row ? "disconnected" : "not_configured";
      if (client) status = client.isConnected() ? "connected" : (health?.status === "reconnecting" ? "reconnecting" : "disconnected");
      return {
        configured: Boolean(row),
        status,
        accountId: row?.accountId ?? null,
        apiKeyPublic: row?.apiKeyPublic ?? null,
        collateral: row?.collateral ?? null,
        createdAt: row?.createdAt ?? null,
        lastRq: row?.lastRq ?? null,
        mode: config.perplMode,
        health,
      };
    };
    const afterConnectionChange = async (userId: string) => {
      try {
        await perpl()?.refresh?.(userId);
      } catch (err) {
        app.log.warn({ err }, "perpl provider refresh failed");
      }
      bus.publish(userId, { type: "perpl", status: connectionDto(userId).status });
    };
    /** Validate against Perpl (when a runtime is attached), then store the encrypted key and start the client. */
    const saveConnection = async (
      userId: string,
      creds: { accountId: string; apiKeyPublic: string; apiKeyPrivate: string },
      collateral?: number,
    ) => {
      await perpl()?.validate?.(userId, creds); // throws a HermesError with a clear code; nothing is saved then
      repos.connections.upsert({
        userId,
        accountId: creds.accountId,
        apiKeyPublic: creds.apiKeyPublic,
        apiKeyPrivateEnc: encrypt(creds.apiKeyPrivate, config.masterKey),
        ...(collateral !== undefined ? { collateral } : {}),
      });
      await afterConnectionChange(userId);
      return connectionDto(userId);
    };

    api.get("/api/perpl/connection", async (req) => connectionDto(req.user.id));
    api.get("/api/perpl/context", async (): Promise<PerplContextDTO> => {
      const rt = perpl();
      if (!rt?.context) throw new HermesError(503, "perpl_unreachable", "The Perpl integration is not running, so its context is unavailable.");
      return rt.context();
    });
    api.put("/api/perpl/connection", async (req) => {
      const body = parse(PutPerplConnectionRequest, req.body);
      let accountId = body.accountId;
      if (accountId === undefined) {
        // No account id given: find it from the API key, then from the user's wallet address.
        const rt = perpl();
        if (!rt?.lookupAccount) {
          throw new HermesError(400, "perpl_account_not_found", "Could not look up the Perpl account automatically. Enter the account id.");
        }
        const wallet =
          req.user.walletAddress ??
          (repos.db.prepare("SELECT address FROM privy_wallets WHERE user_id = ?").get(req.user.id) as { address: string } | undefined)?.address ??
          null;
        accountId = await rt.lookupAccount(req.user.id, { apiKeyPublic: body.apiKeyPublic, apiKeyPrivate: body.apiKeyPrivate }, wallet);
      }
      return saveConnection(req.user.id, { accountId, apiKeyPublic: body.apiKeyPublic, apiKeyPrivate: body.apiKeyPrivate });
    });
    // Live only: create the API key with the user's own wallet instead of pasting one from testnet.perpl.xyz.
    const enrollment = new PerplEnrollment({ apiBase: config.perplApiBase, chainId: 10143 });
    const walletOf = (userId: string, fromToken: string | null | undefined) =>
      fromToken ??
      (repos.db.prepare("SELECT address FROM privy_wallets WHERE user_id = ?").get(userId) as { address: string } | undefined)?.address ??
      null;
    const requireLive = () => {
      if (config.perplMode !== "live") {
        throw new HermesError(404, "not_available", "Creating a Perpl key from Hermes is only available with PERPL_MODE=live.");
      }
    };
    api.post("/api/perpl/enroll/start", async (req) => {
      requireLive();
      const address = walletOf(req.user.id, req.user.walletAddress);
      if (!address) throw new HermesError(409, "wallet_missing", "Your wallet is not ready yet.");
      return { address, typedData: await enrollment.start(req.user.id, address) };
    });
    api.post("/api/perpl/enroll/finish", async (req) => {
      requireLive();
      const { signature } = parse(z.object({ signature: z.string().trim().min(10).max(1000) }), req.body);
      const creds = await enrollment.finish(req.user.id, signature);
      const rt = perpl();
      if (!rt?.lookupAccount) throw new HermesError(503, "perpl_unreachable", "The Perpl integration is not running.");
      const accountId = await rt.lookupAccount(req.user.id, creds, walletOf(req.user.id, req.user.walletAddress));
      return saveConnection(req.user.id, { accountId, ...creds });
    });
    api.delete("/api/perpl/connection", async (req) => {
      repos.connections.delete(req.user.id);
      await afterConnectionChange(req.user.id);
      return connectionDto(req.user.id);
    });
    // Simulator only: one-click "Connect simulated Perpl account". Generates an Ed25519 key pair, enrolls it with the
    // in-process simulator, creates a funded account and stores it exactly as a pasted key would be.
    api.post("/api/perpl/sim/connect", async (req) => {
      const rt = perpl();
      if (config.perplMode !== "sim" || !rt?.provisionSim) {
        throw new HermesError(404, "not_available", "The simulated Perpl account is only available with PERPL_MODE=sim.");
      }
      const creds = rt.provisionSim(req.user.id);
      return saveConnection(req.user.id, creds, creds.collateralUsd);
    });

    // --- reports ---
    api.get<{ Params: { strategyId: string }; Querystring: { range?: string } }>(
      "/api/reports/:strategyId",
      async (req) => {
        const s = repos.strategies.get(req.params.strategyId);
        if (!s || s.userId !== req.user.id) throw notFound("strategy");
        const range = parse(ReportRangeSchema.default("30d"), req.query.range);
        const now = Date.now();
        const alerts = repos.reports.alertsForStrategy(s.id, rangeStart(range, now) ?? 0);
        const pw = priorWindow(range, now);
        const priorAlerts = pw ? repos.reports.alertsForStrategy(s.id, pw.since, pw.until) : undefined;
        const slippageCapBps = s.maxSlippageBps ?? repos.limits.get(req.user.id).defaultSlippageBps;
        return buildReportCard({ strategy: { id: s.id, name: s.name }, range, now, alerts, priorAlerts, slippageCapBps });
      },
    );
  });
}
