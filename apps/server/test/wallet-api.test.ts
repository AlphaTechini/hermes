import type { PolicyDemoResponse, PrivyWalletDTO, SignerConfigDTO, StreamEvent, WalletActionDTO } from "@hermes/shared";
import { generateP256KeyPair } from "@privy-io/node";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type HermesApp } from "../src/app";
import { loadConfig, type Config } from "../src/config";
import { openDb, type Db } from "../src/db/connection";
import { DevWalletService } from "../src/privy/dev-service";
import { specFromConfig } from "../src/privy/policy";
import { PrivyService, type PrivyLike } from "../src/privy/privy-service";

const BASE_ENV = { NODE_ENV: "test", HERMES_MASTER_KEY: "11".repeat(32), PUBLIC_BASE_URL: "https://hermes.test" };
const HASH = /^0x[0-9a-f]{64}$/;

interface Ctx extends HermesApp {
  db: Db;
  config: Config;
  close(): Promise<void>;
}
const open: Ctx[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

async function make(env: Record<string, string>, extra: Partial<Parameters<typeof buildApp>[0]> = {}): Promise<Ctx> {
  const config = loadConfig({ ...BASE_ENV, ...env });
  const db = openDb(":memory:");
  const h = await buildApp({ config, db, ...extra });
  await h.app.ready();
  const ctx: Ctx = {
    ...h,
    db,
    config,
    async close() {
      await h.app.close();
      db.close();
    },
  };
  open.push(ctx);
  return ctx;
}

const makeDev = (env: Record<string, string> = {}) => {
  const config = loadConfig({ ...BASE_ENV, AUTH_MODE: "dev", ...env });
  return make({ AUTH_MODE: "dev", ...env }, { walletService: new DevWalletService({ spec: specFromConfig(config.privyWallet), confirmDelayMs: 0 }) });
};

const call = (c: Ctx, method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  c.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe("wallet API in dev mode (simulated wallet, real local policy)", () => {
  it("serves the signer config for useSigners().addSigners", async () => {
    const c = await makeDev();
    const r = await call(c, "GET", "/api/privy/signer-config");
    expect(r.statusCode).toBe(200);
    const j = r.json<SignerConfigDTO>();
    expect(j).toMatchObject({ mode: "dev", configured: true, keyQuorumId: expect.any(String), policyIds: [expect.any(String)] });
    expect(j.policy).toMatchObject({
      chainId: 10143,
      exchange: "0x1964c32f0be608e7d29302aff5e61268e72080cc",
      collateralToken: "0xa9012a055bd4e0edff8ce09f960291c09d5322dc",
      approveCapAusd: "10000",
    });
  });

  it("registers the signer (simulated) and reports the wallet", async () => {
    const c = await makeDev();
    expect((await call(c, "GET", "/api/privy/wallet")).json()).toBeNull();
    const addr = "0x2222222222222222222222222222222222222222";
    const r = await call(c, "POST", "/api/privy/signer-registered", { address: addr });
    expect(r.statusCode).toBe(200);
    expect(r.json<PrivyWalletDTO>()).toMatchObject({ address: addr, simulated: true, signerAddedAt: expect.any(Number), policyId: "dev-policy" });
    const row = c.db.prepare("SELECT * FROM privy_wallets").get() as { wallet_id: string; address: string; signer_added_at: number };
    expect(row.address).toBe(addr);
    expect(row.wallet_id).toMatch(/^dev_wallet_/);
    expect((await call(c, "POST", "/api/privy/signer-registered", { address: "nope" })).statusCode).toBe(400);
  });

  it("runs the Perpl setup sequence, records each action and emits it on the event bus", async () => {
    const c = await makeDev();
    const events: StreamEvent[] = [];
    c.bus.subscribe((m) => events.push(m.event));

    const steps: Array<[Record<string, unknown>, string]> = [
      [{ kind: "approve_collateral", amount: 200 }, "approve"],
      [{ kind: "create_account", amount: "150" }, "Create"],
      [{ kind: "allow_forwarding" }, "forwarding"],
      [{ kind: "deposit", amount: 25.5 }, "Deposit"],
      [{ kind: "faucet" }, "faucet"],
    ];
    for (const [body, text] of steps) {
      const r = await call(c, "POST", "/api/wallet/actions", body);
      expect(r.statusCode, r.body).toBe(200);
      const a = r.json<WalletActionDTO>();
      expect(a).toMatchObject({ kind: body.kind, status: "confirmed", simulated: true, value: "0" });
      expect(a.txHash).toMatch(HASH);
      expect(a.description.toLowerCase()).toContain(text.toLowerCase());
      expect(a.data).toMatch(/^0x[0-9a-f]+$/);
    }
    const list = (await call(c, "GET", "/api/wallet/actions")).json<WalletActionDTO[]>();
    expect(list.map((a) => a.kind)).toEqual(["faucet", "deposit", "allow_forwarding", "create_account", "approve_collateral"]);
    expect(c.db.prepare("SELECT COUNT(*) AS n FROM wallet_actions WHERE status = 'confirmed'").get()).toEqual({ n: 5 });

    const walletEvents = events.filter((e) => e.type === "wallet_action");
    expect(walletEvents.length).toBeGreaterThanOrEqual(10); // submitted + hash + confirmed per action
    expect(walletEvents.at(-1)).toMatchObject({ type: "wallet_action", action: { kind: "faucet", status: "confirmed" } });
  });

  it("validates input", async () => {
    const c = await makeDev();
    expect((await call(c, "POST", "/api/wallet/actions", { kind: "withdraw" })).statusCode).toBe(400);
    expect((await call(c, "POST", "/api/wallet/actions", { kind: "deposit" })).statusCode).toBe(400);
    expect((await call(c, "POST", "/api/wallet/actions", { kind: "deposit", amount: -5 })).statusCode).toBe(400);
    expect((await call(c, "POST", "/api/wallet/actions", { kind: "deposit", amount: "1.1234567" })).statusCode).toBe(400);
  });

  it("pre-flight rejects an approve over the cap before it reaches the wallet, and records it", async () => {
    const c = await makeDev();
    const r = await call(c, "POST", "/api/wallet/actions", { kind: "approve_collateral", amount: 10_001 });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ error: { code: "policy_denied", message: expect.stringContaining("exceeds the cap") } });
    const row = c.db.prepare("SELECT status, error, tx_hash FROM wallet_actions").get() as { status: string; error: string; tx_hash: string | null };
    expect(row.status).toBe("denied_by_policy");
    expect(row.error).toContain("pre-flight");
    expect(row.tx_hash).toBeNull();
  });

  it("policy demo: both forbidden transactions are denied and recorded as denied_by_policy", async () => {
    const c = await makeDev();
    const native = (await call(c, "POST", "/api/wallet/policy-demo", {})).json<PolicyDemoResponse>();
    expect(native).toMatchObject({ blocked: true, enforcedBy: "local_policy_mirror" });
    expect(native.action).toMatchObject({ kind: "policy_demo", status: "denied_by_policy", txHash: null, value: "1000000000000000" });
    expect(native.action.error).toMatch(/native value must be 0/);

    const spender = (await call(c, "POST", "/api/wallet/policy-demo", { variant: "approve_other_spender" })).json<PolicyDemoResponse>();
    expect(spender.blocked).toBe(true);
    expect(spender.action.error).toMatch(/not the Perpl Exchange/);

    const rows = c.db.prepare("SELECT kind, status FROM wallet_actions").all();
    expect(rows).toEqual([
      { kind: "policy_demo", status: "denied_by_policy" },
      { kind: "policy_demo", status: "denied_by_policy" },
    ]);
  });

  it("denies actions after the policy window closes (PRIVY_POLICY_EXPIRES_AT)", async () => {
    const c = await makeDev({ PRIVY_POLICY_EXPIRES_AT: "1000000000" });
    const r = await call(c, "POST", "/api/wallet/actions", { kind: "faucet" });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ error: { message: expect.stringContaining("expired") } });
  });
});

// ---------------------------------------------------------------------------------------------------------
// Privy mode against a fake PrivyClient (verifies our calls and error mapping, not Privy itself)
// ---------------------------------------------------------------------------------------------------------

const EMBEDDED = "0x3333333333333333333333333333333333333333";
const DID = "did:privy:test-user";

class PrivyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly error: unknown,
    message: string,
  ) {
    super(message);
  }
}

async function makePrivy(opts: { signerOnWallet?: "with_policy" | "without_policy" | "none"; owned?: boolean; configured?: boolean; sendImpl?: (walletId: string, input: unknown) => Promise<{ hash: string }> } = {}) {
  const kp = await generateP256KeyPair();
  const sent: Array<{ walletId: string; input: { caip2: string; params: { transaction: Record<string, unknown> }; authorization_context: { authorization_private_keys: string[] } } }> = [];
  const env: Record<string, string> = {
    AUTH_MODE: "privy",
    PRIVY_APP_ID: "app",
    PRIVY_APP_SECRET: "secret",
    ...(opts.configured === false ? {} : { PRIVY_AUTHORIZATION_PRIVATE_KEY: kp.privateKey, PRIVY_KEY_QUORUM_ID: "kq_hermes", PRIVY_POLICY_ID: "pol_hermes" }),
  };
  const signer = opts.signerOnWallet ?? "with_policy";
  const fake = {
    users: () => ({
      _get: async () => ({
        linked_accounts:
          opts.owned === false
            ? []
            : [{ type: "wallet", chain_type: "ethereum", connector_type: "embedded", address: EMBEDDED, id: "w_1" }],
      }),
    }),
    wallets: () => ({
      getWalletByAddress: async ({ address }: { address: string }) => ({
        id: "w_1",
        address,
        additional_signers:
          signer === "none" ? [] : [{ signer_id: "kq_hermes", ...(signer === "with_policy" ? { override_policy_ids: ["pol_hermes"] } : {}) }],
      }),
      ethereum: () => ({
        sendTransaction: async (walletId: string, input: never) => {
          sent.push({ walletId, input });
          return (opts.sendImpl ?? (async () => ({ hash: `0x${"ab".repeat(32)}` })))(walletId, input);
        },
      }),
    }),
    keyQuorums: () => ({ get: async () => ({ authorization_keys: [{ public_key: kp.publicKey }] }) }),
  } as unknown as PrivyLike;

  const config = loadConfig({ ...BASE_ENV, ...env });
  const service = new PrivyService({ config, client: fake, receipt: async () => "confirmed" });
  const ctx = await make(env, { walletService: service, verifier: { verify: async () => ({ privyDid: DID }) } });
  return { ctx, sent, kp };
}

const AUTH = { authorization: "Bearer test-token" };

describe("wallet API in privy mode (fake Privy client)", () => {
  it("requires authentication", async () => {
    const { ctx } = await makePrivy();
    expect((await call(ctx, "GET", "/api/privy/signer-config")).statusCode).toBe(401);
  });

  it("returns the key quorum and policy ids for the frontend", async () => {
    const { ctx } = await makePrivy();
    const j = (await call(ctx, "GET", "/api/privy/signer-config", undefined, AUTH)).json<SignerConfigDTO>();
    expect(j).toMatchObject({ mode: "privy", configured: true, keyQuorumId: "kq_hermes", policyIds: ["pol_hermes"] });
  });

  it("confirms the signer with Privy, then sends a transaction with the server key and the right shape", async () => {
    const { ctx, sent, kp } = await makePrivy();
    const reg = await call(ctx, "POST", "/api/privy/signer-registered", { address: EMBEDDED }, AUTH);
    expect(reg.statusCode, reg.body).toBe(200);
    expect(reg.json<PrivyWalletDTO>()).toMatchObject({ walletId: "w_1", address: EMBEDDED, policyId: "pol_hermes", simulated: false });

    const r = await call(ctx, "POST", "/api/wallet/actions", { kind: "deposit", amount: 50 }, AUTH);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<WalletActionDTO>()).toMatchObject({ status: "confirmed", txHash: `0x${"ab".repeat(32)}`, simulated: false });
    expect(sent).toHaveLength(1);
    const s = sent[0]!;
    expect(s.walletId).toBe("w_1");
    expect(s.input.caip2).toBe("eip155:10143");
    expect(s.input.authorization_context.authorization_private_keys).toEqual([kp.privateKey]);
    expect(s.input.params.transaction).toMatchObject({ value: "0x0", chain_id: 10143 });
    expect(String(s.input.params.transaction.to).toLowerCase()).toBe("0x1964c32f0be608e7d29302aff5e61268e72080cc");
    expect(String(s.input.params.transaction.data).slice(0, 10)).toBe("0xbad4a01f");
  });

  it("refuses to register when the address is not the user's embedded wallet", async () => {
    const { ctx } = await makePrivy({ owned: false });
    const r = await call(ctx, "POST", "/api/privy/signer-registered", { address: EMBEDDED }, AUTH);
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: { code: "wallet_not_owned" } });
  });

  it("refuses when Privy does not list the signer, or lists it without the Hermes policy", async () => {
    const none = await makePrivy({ signerOnWallet: "none" });
    expect((await call(none.ctx, "POST", "/api/privy/signer-registered", { address: EMBEDDED }, AUTH)).json()).toMatchObject({ error: { code: "signer_not_found" } });
    const noPolicy = await makePrivy({ signerOnWallet: "without_policy" });
    const r = await call(noPolicy.ctx, "POST", "/api/privy/signer-registered", { address: EMBEDDED }, AUTH);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: { code: "policy_not_attached" } });
  });

  it("blocks wallet actions until the signer is registered", async () => {
    const { ctx, sent } = await makePrivy();
    const r = await call(ctx, "POST", "/api/wallet/actions", { kind: "faucet" }, AUTH);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: { code: "signer_not_registered" } });
    expect(sent).toHaveLength(0);
  });

  it("pre-flight stops an over-cap approve before calling Privy", async () => {
    const { ctx, sent } = await makePrivy();
    await call(ctx, "POST", "/api/privy/signer-registered", { address: EMBEDDED }, AUTH);
    const r = await call(ctx, "POST", "/api/wallet/actions", { kind: "approve_collateral", amount: 99999 }, AUTH);
    expect(r.statusCode).toBe(422);
    expect(sent).toHaveLength(0);
  });

  it("policy demo skips the pre-flight, calls Privy, and records Privy's own denial", async () => {
    const { ctx, sent } = await makePrivy({
      sendImpl: async () => {
        throw new PrivyHttpError(403, { error: "Request denied by policy", code: "policy_violation" }, "403 Request denied by policy");
      },
    });
    await call(ctx, "POST", "/api/privy/signer-registered", { address: EMBEDDED }, AUTH);
    const r = await call(ctx, "POST", "/api/wallet/policy-demo", {}, AUTH);
    expect(r.statusCode).toBe(200);
    const j = r.json<PolicyDemoResponse>();
    expect(sent).toHaveLength(1); // it DID reach Privy
    expect(sent[0]!.input.params.transaction).toMatchObject({ value: "0x38d7ea4c68000" }); // 0.001 MON
    expect(j).toMatchObject({ blocked: true, enforcedBy: "privy" });
    expect(j.action).toMatchObject({ kind: "policy_demo", status: "denied_by_policy", txHash: null });
    expect(j.action.error).toContain("policy");
  });

  it("flags a demo that Privy did NOT block", async () => {
    const { ctx } = await makePrivy();
    await call(ctx, "POST", "/api/privy/signer-registered", { address: EMBEDDED }, AUTH);
    const j = (await call(ctx, "POST", "/api/wallet/policy-demo", {}, AUTH)).json<PolicyDemoResponse>();
    expect(j).toMatchObject({ blocked: false, enforcedBy: null });
  });

  it("records non-policy Privy errors as failed, not denied", async () => {
    const { ctx } = await makePrivy({ sendImpl: async () => Promise.reject(new PrivyHttpError(401, { error: "Invalid authorization signature" }, "401 Invalid authorization signature")) });
    await call(ctx, "POST", "/api/privy/signer-registered", { address: EMBEDDED }, AUTH);
    const a = (await call(ctx, "POST", "/api/wallet/actions", { kind: "faucet" }, AUTH)).json<WalletActionDTO>();
    expect(a.status).toBe("failed");
    expect(a.error).toContain("Invalid authorization signature");
  });

  it("reports 503 when the server signer is not configured", async () => {
    const { ctx } = await makePrivy({ configured: false });
    expect((await call(ctx, "GET", "/api/privy/signer-config", undefined, AUTH)).json<SignerConfigDTO>()).toMatchObject({ configured: false, keyQuorumId: null, policyIds: [] });
    const r = await call(ctx, "POST", "/api/privy/signer-registered", { address: EMBEDDED }, AUTH);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: { code: "privy_signer_not_configured" } });
  });
});
