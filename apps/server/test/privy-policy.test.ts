import { generateP256KeyPair } from "@privy-io/node";
import { decodeFunctionData, encodeFunctionData, getAddress, parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { buildPolicyDemoTx, buildWalletTx, erc20ApproveAbi, exchangeAbi, faucetAbi } from "../src/privy/abi";
import { buildPolicyCreateParams, evaluatePolicy, specFromConfig, type HermesPolicySpec } from "../src/privy/policy";
import { publicKeyOf } from "../src/privy/privy-service";

const EXCHANGE = "0x1964c32f0be608e7d29302aff5e61268e72080cc";
const AUSD = "0xa9012a055bd4e0edff8ce09f960291c09d5322dc";
const FAUCET = "0xd236c18d274e54faccc3dd9dda4b27965a73ee6c";
const OTHER = "0x000000000000000000000000000000000000dEaD" as const;
const USER = "0x1111111111111111111111111111111111111111" as const;
const CAP = parseUnits("10000", 6);
const NOW = 1_800_000_000;

const spec: HermesPolicySpec = { chainId: 10143, exchange: EXCHANGE, ausd: AUSD, faucet: FAUCET, approveCapBase: CAP, expiresAt: NOW + 3600 };

const approve = (spender: `0x${string}`, amount: bigint) =>
  encodeFunctionData({ abi: erc20ApproveAbi, functionName: "approve", args: [spender, amount] });
const tx = (over: Partial<Parameters<typeof evaluatePolicy>[0]> = {}) => ({
  chainId: 10143 as number | undefined,
  to: AUSD as string | undefined,
  value: 0n,
  data: approve(EXCHANGE, parseUnits("100", 6)),
  ...over,
});

describe("evaluatePolicy (local mirror of the Hermes Privy policy)", () => {
  it("allows approve(Exchange, amount under cap) on AUSD", () => {
    expect(evaluatePolicy(tx(), spec, NOW)).toMatchObject({ allowed: true });
  });
  it("allows approve exactly at the cap, with mixed-case addresses", () => {
    const d = evaluatePolicy(tx({ to: getAddress(AUSD), data: approve(getAddress(EXCHANGE), CAP) }), spec, NOW);
    expect(d.allowed).toBe(true);
  });
  it("denies approve over the cap", () => {
    const d = evaluatePolicy(tx({ data: approve(EXCHANGE, CAP + 1n) }), spec, NOW);
    expect(d).toMatchObject({ allowed: false, code: "ausd_over_cap" });
  });
  it("denies approve to any spender other than the Exchange", () => {
    const d = evaluatePolicy(tx({ data: approve(OTHER, 1n) }), spec, NOW);
    expect(d).toMatchObject({ allowed: false, code: "ausd_wrong_spender" });
  });
  it("denies other AUSD functions (transfer)", () => {
    const data = "0xa9059cbb" + OTHER.slice(2).padStart(64, "0") + "1".padStart(64, "0");
    expect(evaluatePolicy(tx({ data }), spec, NOW)).toMatchObject({ allowed: false, code: "ausd_not_approve" });
    expect(evaluatePolicy(tx({ data: "0x" }), spec, NOW)).toMatchObject({ allowed: false, code: "ausd_not_approve" });
  });
  it("denies any native value, even to an allowed contract", () => {
    expect(evaluatePolicy(tx({ to: EXCHANGE, value: 1n, data: "0x" }), spec, NOW)).toMatchObject({ allowed: false, code: "native_value" });
    expect(evaluatePolicy(tx({ to: OTHER, value: parseUnits("0.001", 18), data: "0x" }), spec, NOW)).toMatchObject({ allowed: false, code: "native_value" });
  });
  it("denies other chains", () => {
    expect(evaluatePolicy(tx({ chainId: 1 }), spec, NOW)).toMatchObject({ allowed: false, code: "wrong_chain" });
    expect(evaluatePolicy(tx({ chainId: undefined }), spec, NOW)).toMatchObject({ allowed: false, code: "wrong_chain" });
  });
  it("denies unknown contracts and plain transfers", () => {
    expect(evaluatePolicy(tx({ to: OTHER }), spec, NOW)).toMatchObject({ allowed: false, code: "unknown_target" });
    expect(evaluatePolicy(tx({ to: undefined }), spec, NOW)).toMatchObject({ allowed: false, code: "unknown_target" });
  });
  it("allows any call to the Exchange and the faucet with value 0", () => {
    const create = buildWalletTx("create_account", { exchange: EXCHANGE, ausd: AUSD, faucet: FAUCET, walletAddress: USER, approveCapBase: CAP }, "100");
    expect(evaluatePolicy(create, spec, NOW)).toMatchObject({ allowed: true, rule: "Perpl Exchange" });
    const faucet = buildWalletTx("faucet", { exchange: EXCHANGE, ausd: AUSD, faucet: FAUCET, walletAddress: USER, approveCapBase: CAP });
    expect(evaluatePolicy(faucet, spec, NOW)).toMatchObject({ allowed: true, rule: "Agora faucet" });
  });
  it("denies everything after the policy expiry, and has no time bound when expiresAt is null", () => {
    expect(evaluatePolicy(tx(), spec, NOW + 3601)).toMatchObject({ allowed: false, code: "expired" });
    expect(evaluatePolicy(tx(), { ...spec, expiresAt: null }, NOW + 10 ** 9).allowed).toBe(true);
  });
});

describe("calldata builders", () => {
  const ctx = { exchange: EXCHANGE, ausd: AUSD, faucet: FAUCET, walletAddress: USER, approveCapBase: CAP };
  it("encodes the five actions with the right selectors and targets", () => {
    const a = buildWalletTx("approve_collateral", ctx, "250.5");
    expect(a.to.toLowerCase()).toBe(AUSD);
    expect(decodeFunctionData({ abi: erc20ApproveAbi, data: a.data }).args).toEqual([expect.stringMatching(/^0x1964/i), 250_500_000n]);
    expect(buildWalletTx("approve_collateral", ctx).description).toContain("10000");
    const c = buildWalletTx("create_account", ctx, "100");
    expect(c.data.slice(0, 10)).toBe("0xcab13915");
    expect(buildWalletTx("allow_forwarding", ctx).data.slice(0, 10)).toBe("0x7962f910");
    const d = buildWalletTx("deposit", ctx, "10");
    expect(d.data.slice(0, 10)).toBe("0xbad4a01f");
    expect(decodeFunctionData({ abi: exchangeAbi, data: d.data }).args).toEqual([10_000_000n]);
    expect(decodeFunctionData({ abi: faucetAbi, data: buildWalletTx("faucet", ctx).data }).args?.[0]).toBe(USER);
    for (const t of [a, c, d]) expect(t.chainId).toBe(10143);
  });
  it("requires an amount for create_account and deposit", () => {
    expect(() => buildWalletTx("deposit", ctx)).toThrow(/amount/);
    expect(() => buildWalletTx("create_account", ctx)).toThrow(/amount/);
  });
  it("policy demo transactions are denied by the mirror", () => {
    for (const v of ["native_transfer", "approve_other_spender"] as const) {
      expect(evaluatePolicy(buildPolicyDemoTx({ ausd: AUSD }, v), spec, NOW).allowed).toBe(false);
    }
  });
});

describe("policy create params (sent to Privy)", () => {
  it("has the chain, value, target, spender, cap and time bound conditions", () => {
    const p = buildPolicyCreateParams(spec, "kq_1");
    expect(p).toMatchObject({ version: "1.0", chain_type: "ethereum", owner_id: "kq_1" });
    expect(p.rules).toHaveLength(3);
    for (const r of p.rules) {
      expect(r.method).toBe("eth_sendTransaction");
      expect(r.action).toBe("ALLOW");
      expect(r.conditions).toContainEqual({ field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: "10143" });
      expect(r.conditions).toContainEqual({ field_source: "ethereum_transaction", field: "value", operator: "eq", value: "0" });
      expect(r.conditions).toContainEqual({ field_source: "system", field: "current_unix_timestamp", operator: "lte", value: String(spec.expiresAt) });
    }
    const ausdRule = p.rules[1]!;
    expect(ausdRule.conditions).toContainEqual(expect.objectContaining({ field_source: "ethereum_calldata", field: "approve.amount", operator: "lte", value: "10000000000" }));
    expect(ausdRule.conditions).toContainEqual(expect.objectContaining({ field: "approve.spender", operator: "in" }));
    const targets = p.rules.map((r) => r.conditions.find((c) => "field" in c && c.field === "to"));
    expect(JSON.stringify(targets).toLowerCase()).toContain(EXCHANGE);
    expect(JSON.stringify(targets).toLowerCase()).toContain(AUSD);
    expect(JSON.stringify(targets).toLowerCase()).toContain(FAUCET);
  });
  it("omits the time condition when there is no expiry", () => {
    const p = buildPolicyCreateParams({ ...spec, expiresAt: null }, "kq_1");
    expect(JSON.stringify(p)).not.toContain("current_unix_timestamp");
  });
  it("derives defaults from config", () => {
    const c = loadConfig({ NODE_ENV: "test", HERMES_MASTER_KEY: "11".repeat(32), AUTH_MODE: "dev" });
    const s = specFromConfig(c.privyWallet);
    expect(s).toMatchObject({ chainId: 10143, exchange: EXCHANGE, ausd: AUSD, faucet: FAUCET, approveCapBase: 10_000_000_000n, expiresAt: null });
  });
});

describe("authorization key", () => {
  it("derives the SPKI public key Privy expects from the generated PKCS8 private key", async () => {
    const kp = await generateP256KeyPair();
    expect(publicKeyOf(kp.privateKey)).toBe(kp.publicKey);
    expect(publicKeyOf(`wallet-auth:${kp.privateKey}`)).toBe(kp.publicKey);
    expect(() => publicKeyOf("AAAA")).toThrow();
  });
});
