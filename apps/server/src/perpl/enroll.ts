import { Ed25519Signer } from "@hermes/perpl";
import { hashTypedData } from "viem";
import { HermesError } from "../errors";

/** EIP-712 payload ready for a wallet: `EIP712Domain` removed, `chainId` as a number. */
export interface EnrollTypedData {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

interface RawTypedData extends EnrollTypedData {
  domain: Record<string, unknown> & { chainId: string | number };
}

interface Pending {
  seedHex: string;
  address: string;
  raw: RawTypedData;
  mac: string;
  expiresAt: number;
}

export interface EnrollOptions {
  apiBase: string;
  chainId: number;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
}

const toSigningForm = (raw: RawTypedData): EnrollTypedData => {
  const { EIP712Domain: _domain, ...types } = raw.types;
  return { domain: { ...raw.domain, chainId: Number(raw.domain.chainId) }, types, primaryType: raw.primaryType, message: raw.message };
};

/**
 * Perpl API key enrolment with the user's own wallet (Perpl docs, integrations.md). The Ed25519 key is generated and
 * kept here, so its secret never reaches the browser; the browser only signs the EIP-712 payload with the wallet that
 * owns the Perpl account. `start` and `finish` are two calls because the wallet signature happens in between.
 */
export class PerplEnrollment {
  private readonly pending = new Map<string, Pending>();
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;

  constructor(private readonly opts: EnrollOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
  }

  async start(userId: string, address: string): Promise<EnrollTypedData> {
    const { signer, seedHex } = Ed25519Signer.generate();
    const res = await this.post("/v1/api-key/payload", {
      chain_id: this.opts.chainId,
      address,
      public_key: signer.publicKeyHex,
      scope_mask: 3,
      label: "Hermes",
    });
    const body = res as { typed_data?: RawTypedData; mac?: string };
    if (!body.typed_data || !body.mac) throw new HermesError(502, "perpl_enroll_failed", "Perpl did not return a key payload.");
    this.pending.set(userId, { seedHex, address, raw: body.typed_data, mac: body.mac, expiresAt: Date.now() + this.ttlMs });
    return toSigningForm(body.typed_data);
  }

  /** Returns the new credentials in the same shape a pasted key has. */
  async finish(userId: string, signature: string): Promise<{ apiKeyPublic: string; apiKeyPrivate: string }> {
    const p = this.pending.get(userId);
    if (!p || p.expiresAt < Date.now()) {
      this.pending.delete(userId);
      throw new HermesError(409, "perpl_enroll_expired", "The key request expired. Start again.");
    }
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) throw new HermesError(400, "invalid_signature", "The wallet signature is not valid hex.");

    const signer = Ed25519Signer.fromSecret(p.seedHex);
    const digest = hashTypedData(toSigningForm(p.raw) as Parameters<typeof hashTypedData>[0]);
    const pop = "0x" + Buffer.from(signer.signBytes(Buffer.from(digest.slice(2), "hex"))).toString("hex");

    const res = (await this.post("/v1/api-key/enroll", {
      chain_id: this.opts.chainId,
      address: p.address,
      typed_data: p.raw,
      mac: p.mac,
      signature,
      pop_signature: pop,
    })) as { api_key?: { api_key?: string } };
    this.pending.delete(userId);
    const token = res.api_key?.api_key;
    if (!token) throw new HermesError(502, "perpl_enroll_failed", "Perpl accepted the key but returned no token.");
    return { apiKeyPublic: token, apiKeyPrivate: p.seedHex };
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.apiBase.replace(/\/+$/, "") + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new HermesError(502, "perpl_unreachable", "Could not reach Perpl to create the API key.");
    }
    const text = await res.text();
    if (res.ok) return text ? (JSON.parse(text) as unknown) : {};
    switch (res.status) {
      case 404:
        throw new HermesError(409, "perpl_account_not_found", "Perpl has no account for this wallet yet. Finish the account step first.");
      case 409:
        throw new HermesError(409, "perpl_key_exists", "This key is already registered with Perpl. Start again.");
      case 423:
        throw new HermesError(409, "perpl_key_limit", "This Perpl account already has 16 API keys. Remove one on testnet.perpl.xyz/apikeys.");
      case 451:
        throw new HermesError(451, "perpl_geo_blocked", "Perpl refused the request from this server's region.");
      default:
        throw new HermesError(502, "perpl_enroll_failed", `Perpl refused the key request (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
  }
}
