import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseUnits } from "viem";
import { z } from "zod";

const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const opt = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToUndef, schema.optional());

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.preprocess(emptyToUndef, z.coerce.number().int().min(1).max(65535).default(8787)),
  PUBLIC_BASE_URL: opt(z.string().url()),
  DATABASE_PATH: z.preprocess(emptyToUndef, z.string().default("./data/hermes.db")),
  HERMES_MASTER_KEY: opt(z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters (32 bytes)")),
  PERPL_MODE: z.preprocess(emptyToUndef, z.enum(["sim", "live"]).default("sim")),
  PERPL_API_BASE: z.preprocess(emptyToUndef, z.string().url().default("https://testnet.perpl.xyz/api")),
  PERPL_WS_BASE: z.preprocess(emptyToUndef, z.string().default("wss://testnet.perpl.xyz")),
  /** Port of the in-process Perpl simulator (PERPL_MODE=sim). 0 = pick a free port. */
  PERPL_SIM_PORT: z.preprocess(emptyToUndef, z.coerce.number().int().min(0).max(65535).default(8790)),
  MONAD_RPC_URL: z.preprocess(emptyToUndef, z.string().url().default("https://testnet-rpc.monad.xyz")),
  PERPL_EXCHANGE_ADDRESS: z.preprocess(
    emptyToUndef,
    z.string().regex(/^0x[0-9a-fA-F]{40}$/).default("0x1964c32f0be608e7d29302aff5e61268e72080cc"),
  ),
  AUSD_ADDRESS: z.preprocess(
    emptyToUndef,
    z.string().regex(/^0x[0-9a-fA-F]{40}$/).default("0xa9012a055bd4e0edff8ce09f960291c09d5322dc"),
  ),
  AGORA_FAUCET_ADDRESS: z.preprocess(
    emptyToUndef,
    z.string().regex(/^0x[0-9a-fA-F]{40}$/).default("0xd236c18d274e54faccc3dd9dda4b27965a73ee6c"),
  ),
  PRIVY_AUTHORIZATION_PRIVATE_KEY: opt(z.string()),
  PRIVY_KEY_QUORUM_ID: opt(z.string()),
  PRIVY_POLICY_ID: opt(z.string()),
  PRIVY_APPROVE_CAP: z.preprocess(emptyToUndef, z.string().regex(/^\d+(\.\d{1,6})?$/, "AUSD amount, max 6 decimals").default("10000")),
  PRIVY_POLICY_EXPIRES_AT: opt(z.coerce.number().int().positive()),
  PRIVY_APP_ID: opt(z.string()),
  PRIVY_APP_SECRET: opt(z.string()),
  AUTH_MODE: opt(z.enum(["privy", "dev"])),
  WEB_ORIGIN: z.preprocess(emptyToUndef, z.string().default("http://localhost:5173")),
  WEB_DIST_DIR: opt(z.string()),
});

/** Hermes Privy wallet module settings (server signer, policy mirror). */
export interface PrivyWalletConfig {
  /** Base64 PKCS8 P-256 private key of the Hermes server authorization key. Secret. */
  authorizationPrivateKey: string | undefined;
  keyQuorumId: string | undefined;
  policyId: string | undefined;
  /** Lowercase 0x addresses. */
  exchangeAddress: string;
  ausdAddress: string;
  faucetAddress: string;
  /** Max AUSD `approve` amount in human units and in 6-decimal base units. */
  approveCapAusd: string;
  approveCapBase: bigint;
  /** Unix seconds; the policy refuses everything after this. Null = no time bound mirrored locally. */
  policyExpiresAt: number | null;
}

export interface Config {
  nodeEnv: string;
  port: number;
  publicBaseUrl: string;
  databasePath: string;
  /** 32-byte AES key. */
  masterKey: Buffer;
  /** True when the master key was generated for this process only. */
  masterKeyEphemeral: boolean;
  perplMode: "sim" | "live";
  perplApiBase: string;
  perplWsBase: string;
  perplSimPort: number;
  monadRpcUrl: string;
  perplExchangeAddress: string;
  privyAppId: string | undefined;
  privyAppSecret: string | undefined;
  privyWallet: PrivyWalletConfig;
  authMode: "privy" | "dev";
  webOrigin: string;
  /** Built web app to serve from this server (single-origin deploy). Unset in development, where Vite serves it. */
  webDistDir: string | undefined;
  warnings: string[];
}

export interface LoadConfigOptions {
  /**
   * Development convenience: when HERMES_MASTER_KEY is unset, generate one and keep it in
   * `<dir of DATABASE_PATH>/.hermes-dev-master-key` so stored secrets survive restarts and the seed script.
   */
  devKeyFile?: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: LoadConfigOptions = {}): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${msg}`);
  }
  const e = parsed.data;
  const warnings: string[] = [];
  const isProd = e.NODE_ENV === "production";

  let masterKey: Buffer;
  let ephemeral = false;
  if (e.HERMES_MASTER_KEY) {
    masterKey = Buffer.from(e.HERMES_MASTER_KEY, "hex");
  } else if (isProd) {
    throw new Error("HERMES_MASTER_KEY is required in production (64 hex chars).");
  } else if (options.devKeyFile && e.DATABASE_PATH !== ":memory:") {
    const file = join(dirname(e.DATABASE_PATH), ".hermes-dev-master-key");
    if (existsSync(file) && /^[0-9a-fA-F]{64}$/.test(readFileSync(file, "utf8").trim())) {
      masterKey = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
    } else {
      masterKey = randomBytes(32);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, masterKey.toString("hex"), { mode: 0o600 });
    }
    warnings.push(
      `HERMES_MASTER_KEY is not set: using a DEV key persisted at ${file}. Fine for local development; ` +
        "set HERMES_MASTER_KEY (64 hex chars) for anything else.",
    );
  } else {
    masterKey = randomBytes(32);
    ephemeral = true;
    warnings.push(
      "HERMES_MASTER_KEY is not set: using an EPHEMERAL key. Stored webhook secrets and Perpl API keys " +
        "become unreadable after a restart. Set HERMES_MASTER_KEY (64 hex chars) to persist them.",
    );
  }

  const havePrivy = Boolean(e.PRIVY_APP_ID && e.PRIVY_APP_SECRET);
  const authMode = e.AUTH_MODE ?? (e.PRIVY_APP_ID ? "privy" : "dev");
  if (authMode === "privy" && !havePrivy) {
    throw new Error("AUTH_MODE=privy requires PRIVY_APP_ID and PRIVY_APP_SECRET.");
  }
  if (authMode === "dev") {
    warnings.push(
      "AUTH_MODE=dev: every API request is treated as the fixed demo user. Never expose this to the internet.",
    );
  }

  if (authMode === "privy" && !(e.PRIVY_AUTHORIZATION_PRIVATE_KEY && e.PRIVY_KEY_QUORUM_ID && e.PRIVY_POLICY_ID)) {
    warnings.push(
      "Privy server signer is not configured (PRIVY_AUTHORIZATION_PRIVATE_KEY, PRIVY_KEY_QUORUM_ID, PRIVY_POLICY_ID): " +
        "login works, but /api/wallet/actions is unavailable. Run `pnpm --filter @hermes/server privy:bootstrap`.",
    );
  }

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    publicBaseUrl: (e.PUBLIC_BASE_URL ?? `http://localhost:${e.PORT}`).replace(/\/+$/, ""),
    databasePath: e.DATABASE_PATH,
    masterKey,
    masterKeyEphemeral: ephemeral,
    perplMode: e.PERPL_MODE,
    perplApiBase: e.PERPL_API_BASE,
    perplWsBase: e.PERPL_WS_BASE,
    perplSimPort: e.PERPL_SIM_PORT,
    monadRpcUrl: e.MONAD_RPC_URL,
    perplExchangeAddress: e.PERPL_EXCHANGE_ADDRESS,
    privyAppId: e.PRIVY_APP_ID,
    privyAppSecret: e.PRIVY_APP_SECRET,
    privyWallet: {
      authorizationPrivateKey: e.PRIVY_AUTHORIZATION_PRIVATE_KEY,
      keyQuorumId: e.PRIVY_KEY_QUORUM_ID,
      policyId: e.PRIVY_POLICY_ID,
      exchangeAddress: e.PERPL_EXCHANGE_ADDRESS.toLowerCase(),
      ausdAddress: e.AUSD_ADDRESS.toLowerCase(),
      faucetAddress: e.AGORA_FAUCET_ADDRESS.toLowerCase(),
      approveCapAusd: e.PRIVY_APPROVE_CAP,
      approveCapBase: parseUnits(e.PRIVY_APPROVE_CAP, 6),
      policyExpiresAt: e.PRIVY_POLICY_EXPIRES_AT ?? null,
    },
    authMode,
    webOrigin: e.WEB_ORIGIN,
    webDistDir: e.WEB_DIST_DIR,
    warnings,
  };
}
