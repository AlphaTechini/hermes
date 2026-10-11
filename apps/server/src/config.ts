import { randomBytes } from "node:crypto";
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
  MONAD_RPC_URL: z.preprocess(emptyToUndef, z.string().url().default("https://testnet-rpc.monad.xyz")),
  PERPL_EXCHANGE_ADDRESS: z.preprocess(
    emptyToUndef,
    z.string().regex(/^0x[0-9a-fA-F]{40}$/).default("0x1964c32f0be608e7d29302aff5e61268e72080cc"),
  ),
  PRIVY_APP_ID: opt(z.string()),
  PRIVY_APP_SECRET: opt(z.string()),
  AUTH_MODE: opt(z.enum(["privy", "dev"])),
  WEB_ORIGIN: z.preprocess(emptyToUndef, z.string().default("http://localhost:5173")),
});

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
  monadRpcUrl: string;
  perplExchangeAddress: string;
  privyAppId: string | undefined;
  privyAppSecret: string | undefined;
  authMode: "privy" | "dev";
  webOrigin: string;
  warnings: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
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
    monadRpcUrl: e.MONAD_RPC_URL,
    perplExchangeAddress: e.PERPL_EXCHANGE_ADDRESS,
    privyAppId: e.PRIVY_APP_ID,
    privyAppSecret: e.PRIVY_APP_SECRET,
    authMode,
    webOrigin: e.WEB_ORIGIN,
    warnings,
  };
}
