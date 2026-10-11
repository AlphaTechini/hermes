/**
 * Ed25519 API-key signing for Perpl (docs/research/perpl.md section 4).
 *
 *  - WS sign-in (mt:29): canonical string = `chain_id \n trading-ws-signin \n timestamp_ms \n nonce`
 *  - REST: canonical string = `chain_id \n METHOD \n request-target \n timestamp_ms \n nonce \n hex(sha256(body))`
 *    where request-target is the path + query exactly as sent, starting `/v1/...` WITHOUT the `/api` prefix
 *  - signature = base64url(ed25519(canonical)), no padding; nonce = 16 random bytes base64url, single use;
 *    timestamp must be within 30 s of server time.
 *
 * Implemented on node:crypto (Ed25519 is deterministic, so it reproduces the Desk test vectors byte for byte).
 * No private key is ever logged or serialised by this module.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";
import { MsgType, type SignInFrame } from "./protocol";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class KeyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyParseError";
  }
}

/** base64url without padding. */
export const b64url = (b: Uint8Array | Buffer): string => Buffer.from(b).toString("base64url");

/** Random nonce: 16 bytes, base64url, no padding. */
export function randomNonce(): string {
  return b64url(randomBytes(16));
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const HEX_RE = /^[0-9a-fA-F]+$/;

/**
 * Parse a pasted Ed25519 private key into its 32-byte seed. Accepted (lenient, since the exact format shown by
 * testnet.perpl.xyz/apikeys is not documented; perpl.md only says "hex of the 32-byte key"):
 *
 *  - hex, with or without `0x`: 64 chars = seed, 128 chars = seed || public key (NaCl style)
 *  - base64 / base64url (padding optional): 32 bytes = seed, 64 bytes = seed || public key, 48 bytes = PKCS#8 DER
 *  - PEM `-----BEGIN PRIVATE KEY-----` (PKCS#8; what `openssl genpkey -algorithm ed25519` writes)
 *  - any of the above wrapped in quotes or with surrounding whitespace / newlines
 */
export function parseEd25519Seed(input: string | Uint8Array): Uint8Array {
  if (typeof input !== "string") {
    if (input.length === 32) return Uint8Array.from(input);
    if (input.length === 64) return Uint8Array.from(input.subarray(0, 32));
    throw new KeyParseError(`Ed25519 key must be 32 or 64 bytes, got ${input.length}`);
  }
  let s = input.trim().replace(/^["']|["']$/g, "").trim();
  if (!s) throw new KeyParseError("empty private key");

  if (s.includes("-----BEGIN")) {
    try {
      const k = createPrivateKey(s);
      if (k.asymmetricKeyType !== "ed25519") throw new KeyParseError(`PEM key is ${k.asymmetricKeyType}, expected ed25519`);
      const der = k.export({ format: "der", type: "pkcs8" });
      return Uint8Array.from(der.subarray(-32));
    } catch (e) {
      if (e instanceof KeyParseError) throw e;
      throw new KeyParseError(`could not parse PEM private key: ${(e as Error).message}`);
    }
  }

  s = s.replace(/\s+/g, "");
  const hex = s.replace(/^0x/i, "");
  if (HEX_RE.test(hex) && (hex.length === 64 || hex.length === 128)) {
    return Uint8Array.from(Buffer.from(hex.slice(0, 64), "hex"));
  }

  // base64 or base64url
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
    const normalized = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    const bytes = Buffer.from(normalized, "base64");
    if (bytes.length === 32) return Uint8Array.from(bytes);
    if (bytes.length === 64) return Uint8Array.from(bytes.subarray(0, 32));
    if (bytes.length === 48 && bytes.subarray(0, 16).equals(PKCS8_ED25519_PREFIX)) return Uint8Array.from(bytes.subarray(16));
    throw new KeyParseError(`decoded private key has ${bytes.length} bytes; expected 32 (seed), 64 (seed+public) or 48 (PKCS#8)`);
  }
  throw new KeyParseError("unrecognised private key format (expected hex, base64, base64url or PEM)");
}

/** Parse a public key (32 bytes) from hex (0x optional), base64 or base64url. */
export function parseEd25519PublicKey(input: string | Uint8Array): Uint8Array {
  if (typeof input !== "string") {
    if (input.length !== 32) throw new KeyParseError(`Ed25519 public key must be 32 bytes, got ${input.length}`);
    return Uint8Array.from(input);
  }
  const s = input.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, "");
  const hex = s.replace(/^0x/i, "");
  if (HEX_RE.test(hex) && hex.length === 64) return Uint8Array.from(Buffer.from(hex, "hex"));
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
    const bytes = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, ""), "base64");
    if (bytes.length === 32) return Uint8Array.from(bytes);
    if (bytes.length === 44 && bytes.subarray(0, 12).equals(SPKI_ED25519_PREFIX)) return Uint8Array.from(bytes.subarray(12));
  }
  throw new KeyParseError("unrecognised Ed25519 public key (expected 32 bytes as hex or base64)");
}

/** An Ed25519 signing key. Holds the private key in a KeyObject; `toJSON`/inspect never reveal it. */
export class Ed25519Signer {
  private readonly key: KeyObject;
  readonly publicKey: Uint8Array;

  private constructor(key: KeyObject) {
    this.key = key;
    this.publicKey = Uint8Array.from(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32));
  }

  static fromSeed(seed: Uint8Array): Ed25519Signer {
    if (seed.length !== 32) throw new KeyParseError("Ed25519 seed must be 32 bytes");
    const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
    return new Ed25519Signer(key);
  }

  /** Parse any format accepted by {@link parseEd25519Seed}. */
  static fromSecret(secret: string | Uint8Array): Ed25519Signer {
    return Ed25519Signer.fromSeed(parseEd25519Seed(secret));
  }

  static generate(): { signer: Ed25519Signer; seedHex: string } {
    const { privateKey } = generateKeyPairSync("ed25519");
    const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
    return { signer: new Ed25519Signer(privateKey), seedHex: Buffer.from(seed).toString("hex") };
  }

  /** `0x` + 64 hex. This is the `public_key` sent at enrolment. */
  get publicKeyHex(): string {
    return "0x" + Buffer.from(this.publicKey).toString("hex");
  }

  /** base64url(ed25519(utf8(text))). */
  signText(text: string): string {
    return b64url(nodeSign(null, Buffer.from(text, "utf8"), this.key));
  }

  /** Raw 64-byte signature over arbitrary bytes (used for the enrolment proof of possession). */
  signBytes(data: Uint8Array): Uint8Array {
    return Uint8Array.from(nodeSign(null, Buffer.from(data), this.key));
  }

  toJSON(): { publicKey: string } {
    return { publicKey: this.publicKeyHex };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Ed25519Signer(${this.publicKeyHex})`;
  }
}

/** Verify a base64url signature over utf8 text with a raw 32-byte public key. Never throws. */
export function verifySignature(publicKey: Uint8Array | string, text: string, signatureB64url: string): boolean {
  try {
    const raw = typeof publicKey === "string" ? parseEd25519PublicKey(publicKey) : publicKey;
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
    const sig = Buffer.from(signatureB64url, "base64url");
    if (sig.length !== 64) return false;
    return nodeVerify(null, Buffer.from(text, "utf8"), key, sig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Canonical strings
// ---------------------------------------------------------------------------------------------------------------------

/** WS sign-in canonical string (4 lines, no trailing newline). */
export function canonicalWsSignin(chainId: number | string, timestamp: string, nonce: string): string {
  return [String(chainId), "trading-ws-signin", timestamp, nonce].join("\n");
}

export interface RestCanonicalInput {
  chainId: number | string;
  method: string;
  /** Path + query exactly as sent, starting `/v1/...`, WITHOUT the `/api` prefix. */
  target: string;
  timestamp: string;
  nonce: string;
  /** The exact body string that is sent ("" for none). */
  body?: string;
}

/** REST canonical string (6 lines). */
export function canonicalRest(i: RestCanonicalInput): string {
  return [String(i.chainId), i.method.toUpperCase(), i.target, i.timestamp, i.nonce, sha256Hex(i.body ?? "")].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// Frame / header builders
// ---------------------------------------------------------------------------------------------------------------------

export interface SignOptions {
  /** Override the clock (tests). */
  nowMs?: number;
  /** Override the nonce (tests). */
  nonce?: string;
}

/** Build the mt:29 sign-in frame. Call it freshly for every connection (new timestamp + nonce). */
export function buildSignInFrame(signer: Ed25519Signer, chainId: number, apiKey: string, opts: SignOptions = {}): SignInFrame {
  const timestamp = String(opts.nowMs ?? Date.now());
  const nonce = opts.nonce ?? randomNonce();
  return {
    mt: MsgType.ApiKeySignIn,
    chain_id: chainId,
    api_key: apiKey,
    timestamp,
    nonce,
    signature: signer.signText(canonicalWsSignin(chainId, timestamp, nonce)),
  };
}

export interface SignedHeaders {
  "X-API-Key": string;
  "X-API-Timestamp": string;
  "X-API-Nonce": string;
  "X-API-Signature": string;
}

/** Build the four `X-API-*` headers for a REST request. The body must be the exact string that will be sent. */
export function signRestRequest(
  signer: Ed25519Signer,
  p: { chainId: number; apiKey: string; method: string; target: string; body?: string },
  opts: SignOptions = {},
): SignedHeaders {
  const timestamp = String(opts.nowMs ?? Date.now());
  const nonce = opts.nonce ?? randomNonce();
  const canonical = canonicalRest({ chainId: p.chainId, method: p.method, target: p.target, timestamp, nonce, ...(p.body !== undefined ? { body: p.body } : {}) });
  return {
    "X-API-Key": p.apiKey,
    "X-API-Timestamp": timestamp,
    "X-API-Nonce": nonce,
    "X-API-Signature": signer.signText(canonical),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Pasted credentials
// ---------------------------------------------------------------------------------------------------------------------

export interface PastedCredentials {
  apiKey?: string;
  secret?: string;
}

/**
 * Be lenient about what a user pastes from testnet.perpl.xyz/apikeys: a JSON object, `KEY=VALUE` env lines
 * (`PERPL_API_KEY`, `PERPL_API_KEY_SECRET`), or `key:value` lines. Returns whatever it can find; callers still validate
 * the secret with {@link parseEd25519Seed}.
 */
export function parseApiCredentials(text: string): PastedCredentials {
  const out: PastedCredentials = {};
  const t = text.trim();
  const KEY_NAMES = /^(api[_-]?key|x-api-key|key|token|perpl_api_key)$/i;
  const SECRET_NAMES = /^(api[_-]?secret|secret|secret[_-]?key|private[_-]?key|privatekey|perpl_api_key_secret|api[_-]?key[_-]?secret)$/i;
  const take = (name: string, value: string): void => {
    const v = value.trim().replace(/^["']|["'],?$/g, "");
    if (!v) return;
    if (SECRET_NAMES.test(name) && !out.secret) out.secret = v;
    else if (KEY_NAMES.test(name) && !out.apiKey) out.apiKey = v;
  };
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      for (const [k, v] of Object.entries(j)) if (typeof v === "string") take(k, v);
      return out;
    } catch {
      // fall through to line parsing
    }
  }
  for (const line of t.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w-]*)\s*[=:]\s*(.+?)\s*$/.exec(line);
    if (m) take(m[1] as string, m[2] as string);
  }
  return out;
}
