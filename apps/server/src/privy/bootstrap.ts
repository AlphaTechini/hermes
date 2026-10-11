/**
 * One-time Privy setup for the Hermes server signer. Run: `pnpm --filter @hermes/server privy:bootstrap`.
 *
 *   1. generates a P-256 authorization key pair (or reuses PRIVY_AUTHORIZATION_PRIVATE_KEY if already set),
 *   2. creates the "Hermes server" key quorum (threshold 1) containing that key,
 *   3. creates the Hermes wallet policy (see policy.ts) owned by that key quorum,
 *   4. PRINTS the env lines to add. Nothing is written to disk: the private key is a secret.
 *
 * Needs PRIVY_APP_ID and PRIVY_APP_SECRET. Optional: PRIVY_POLICY_TTL_DAYS (default 30), PRIVY_APPROVE_CAP,
 * PERPL_EXCHANGE_ADDRESS, AUSD_ADDRESS, AGORA_FAUCET_ADDRESS (same variables as the server).
 */
import { existsSync } from "node:fs";
import { PrivyClient, generateP256KeyPair } from "@privy-io/node";
import { loadConfig } from "../config";
import { buildPolicyCreateParams, specFromConfig } from "./policy";
import { publicKeyOf } from "./privy-service";

async function main() {
  for (const f of [".env", "apps/server/.env"]) {
    if (existsSync(f)) {
      try {
        process.loadEnvFile(f);
      } catch {
        /* ignore */
      }
    }
  }
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("PRIVY_APP_ID and PRIVY_APP_SECRET are required (Privy dashboard > App settings > Basics).");
  }
  const ttlDays = Number(process.env.PRIVY_POLICY_TTL_DAYS ?? "30");
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) throw new Error("PRIVY_POLICY_TTL_DAYS must be a positive number");

  const config = loadConfig({ ...process.env, NODE_ENV: "development", AUTH_MODE: "dev" });
  const expiresAt = Math.floor(Date.now() / 1000) + Math.round(ttlDays * 86_400);
  const spec = specFromConfig({ ...config.privyWallet, policyExpiresAt: expiresAt });

  const privy = new PrivyClient({ appId, appSecret });

  let privateKey = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY?.trim().replace(/^wallet-auth:/, "");
  let publicKey: string;
  if (privateKey) {
    publicKey = publicKeyOf(privateKey);
    console.error("Reusing the authorization key from PRIVY_AUTHORIZATION_PRIVATE_KEY.");
  } else {
    const kp = await generateP256KeyPair();
    privateKey = kp.privateKey;
    publicKey = kp.publicKey;
    console.error("Generated a new P-256 authorization key pair.");
  }

  const quorum = await privy.keyQuorums().create({
    public_keys: [publicKey],
    authorization_threshold: 1,
    display_name: "Hermes server",
  });
  console.error(`Created key quorum ${quorum.id}.`);

  const policy = await privy.policies().create(buildPolicyCreateParams(spec, quorum.id));
  console.error(`Created policy ${policy.id} (${policy.rules?.length ?? "?"} rules, valid until ${new Date(expiresAt * 1000).toISOString()}).`);

  const lines = [
    `PRIVY_AUTHORIZATION_PRIVATE_KEY=${privateKey}`,
    `PRIVY_KEY_QUORUM_ID=${quorum.id}`,
    `PRIVY_POLICY_ID=${policy.id}`,
    `PRIVY_POLICY_EXPIRES_AT=${expiresAt}`,
    `PRIVY_APPROVE_CAP=${config.privyWallet.approveCapAusd}`,
  ];
  console.log("\n# Add these to apps/server/.env (the private key is a SECRET: never commit it):");
  for (const l of lines) console.log(l);
  console.log("\n# Frontend (apps/web/.env): the signer id and policy id are public.");
  console.log(`VITE_PRIVY_SIGNER_ID=${quorum.id}`);
  console.log(`VITE_PRIVY_POLICY_ID=${policy.id}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  const body = (err as { error?: unknown }).error;
  if (body) console.error(JSON.stringify(body, null, 2));
  process.exit(1);
});
