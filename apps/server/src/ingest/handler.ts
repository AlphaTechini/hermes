import { randomBytes } from "node:crypto";
import { hiresNowMs, parseAlert, type IngestResponse } from "@hermes/shared";
import type { Config } from "../config";
import { decrypt, safeEqual, sha256Hex, shortId } from "../crypto";
import type { Repos } from "../db/repos";
import type { EventBus } from "../events/bus";
import type { Pipeline } from "../pipeline/pipeline";

export const MAX_BODY_BYTES = 16 * 1024;
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface IngestInput {
  strategyId: string;
  /** Raw request body text exactly as received. */
  rawBody: string;
  /** hiresNowMs() captured as early as possible. */
  receivedAtMs: number;
  source: "webhook" | "test-alert";
}

export type IngestResult =
  | { status: 202 | 200; body: IngestResponse }
  | { status: 400 | 401; body: { error: { code: string; message: string; issues?: { path: string; message: string }[] } } };

const UNAUTHORIZED: IngestResult = {
  status: 401,
  body: { error: { code: "unauthorized", message: "Unauthorized" } },
};

/** Stable JSON: object keys sorted recursively. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * Idempotency key: the alert's own `id` if it has one, otherwise sha256(strategyId + normalised body without the
 * secret). Hash keys only collapse byte-identical alerts, so include `{{timenow}}` in the message (the shipped
 * templates do) or repeated identical signals within 24 h count as duplicates.
 */
export function idempotencyKeyFor(strategyId: string, body: Record<string, unknown>, clientId: string | undefined): string {
  if (clientId) return `id:${clientId}`;
  const { secret: _secret, ...rest } = body;
  return `h:${sha256Hex(strategyId + canonicalJson(rest))}`;
}

export interface IngestDeps {
  repos: Repos;
  config: Config;
  pipeline: Pipeline;
  bus: EventBus;
  now?: () => number;
}

export function createIngest(deps: IngestDeps) {
  const { repos, config, pipeline, bus } = deps;
  const now = deps.now ?? Date.now;
  // For unknown strategies we still burn the same compare to keep timing flat.
  const dummySecret = randomBytes(32).toString("base64url");

  function handle(input: IngestInput): IngestResult {
    const strategy = repos.strategies.get(input.strategyId);
    if (!strategy) {
      safeEqual(dummySecret, dummySecret);
      return UNAUTHORIZED;
    }

    // Parse the body ourselves: TradingView sends text/plain unless it detects valid JSON.
    let obj: Record<string, unknown> | null = null;
    try {
      const v: unknown = JSON.parse(input.rawBody);
      if (v && typeof v === "object" && !Array.isArray(v)) obj = v as Record<string, unknown>;
    } catch {
      obj = null;
    }

    // Never persist the secret.
    const redactedBody = obj
      ? JSON.stringify({ ...obj, ...("secret" in obj ? { secret: "[redacted]" } : {}) })
      : `[unparseable body, ${Buffer.byteLength(input.rawBody)} bytes]`;

    const alertId = `alr_${shortId(14)}`;
    repos.alerts.insert({
      id: alertId,
      strategyId: strategy.id,
      userId: strategy.userId,
      rawBody: redactedBody,
      status: "received",
      receivedAtMs: input.receivedAtMs,
    });
    repos.alerts.addEvent(alertId, "received", input.receivedAtMs, { source: input.source });
    const emit = () => {
      const record = repos.alerts.record(alertId);
      if (record) bus.publish(strategy.userId, { type: "alert", alert: record });
    };
    emit();

    // --- authenticate (strategy enabled + secret). One answer for every failure. ---
    let secretOk = false;
    const provided = obj?.secret;
    if (strategy.enabled && typeof provided === "string") {
      try {
        secretOk = safeEqual(provided, decrypt(strategy.secretEnc, config.masterKey));
      } catch {
        secretOk = false;
      }
    } else {
      safeEqual(dummySecret, dummySecret);
    }
    if (!secretOk) {
      pipeline.transition(alertId, "rejected_auth", {}, {
        why: !strategy.enabled ? "strategy_disabled" : obj === null ? "unparseable_body" : typeof provided !== "string" ? "missing_secret" : "secret_mismatch",
      });
      return UNAUTHORIZED;
    }
    // Normalise numeric secrets etc. is not needed: we compared the exact string.

    // --- schema ---
    const parsed = parseAlert(obj, {
      market: strategy.defaultMarket,
      sizeUsd: strategy.defaultSizeUsd,
      leverage: strategy.defaultLeverage,
    });
    if (!parsed.ok) {
      pipeline.transition(alertId, "invalid", {}, { issues: parsed.issues });
      return {
        status: 400,
        body: { error: { code: "invalid_payload", message: "The alert message is not valid.", issues: parsed.issues } },
      };
    }
    const alert = parsed.value;

    // --- idempotency ---
    const key = idempotencyKeyFor(strategy.id, obj as Record<string, unknown>, alert.clientId);
    repos.alerts.expireKey(strategy.id, key, now() - IDEMPOTENCY_WINDOW_MS);
    const existing = repos.alerts.findByKey(strategy.id, key);
    if (existing) {
      pipeline.transition(alertId, "duplicate", {}, { duplicateOf: existing.id, key });
      return { status: 200, body: { alertId, duplicate: true } };
    }

    repos.alerts.patch(alertId, {
      idempotencyKey: key,
      parsedJson: JSON.stringify(alert),
      market: alert.market,
      side: alert.intent.side,
      kind: alert.intent.kind,
      sizeUsd: alert.sizeUsd ?? null,
      alertPrice: alert.price ?? null,
    });
    pipeline.transition(alertId, "verified", {}, { key: key.startsWith("id:") ? key : "hash" });

    // Hand off after the response is on its way (enqueue defers to the next tick).
    pipeline.enqueue(alertId);
    return { status: 202, body: { alertId } };
  }

  return { handle };
}

export type Ingest = ReturnType<typeof createIngest>;
export { hiresNowMs };
