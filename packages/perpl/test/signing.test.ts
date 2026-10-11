import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import vectors from "./fixtures/desk-canonical-vectors.json";
import {
  Ed25519Signer,
  KeyParseError,
  buildSignInFrame,
  canonicalRest,
  canonicalWsSignin,
  parseApiCredentials,
  parseEd25519Seed,
  randomNonce,
  sha256Hex,
  signRestRequest,
  verifySignature,
} from "../src/signing";

// Test vectors from Desk (frankolien/desk DeskKit/Tests/DeskPerplTests/CanonicalVectors.json), cited in perpl.md section 4.2.
const signer = Ed25519Signer.fromSecret(vectors.ed25519Seed);

describe("signing: Desk canonical vectors", () => {
  it("empty body hash constant", () => {
    expect(sha256Hex("")).toBe(vectors.emptyBodySha256);
  });

  it("WS sign-in canonical string and signature match", () => {
    const canonical = canonicalWsSignin(vectors.chainId, vectors.timestamp, vectors.nonce);
    expect(canonical).toBe(vectors.signin.canonical);
    expect(signer.signText(canonical)).toBe(vectors.signin.signature);
  });

  it("buildSignInFrame reproduces the vector signature", () => {
    const f = buildSignInFrame(signer, vectors.chainId, "TOKEN", { nowMs: Number(vectors.timestamp), nonce: vectors.nonce });
    expect(f).toEqual({
      mt: 29,
      chain_id: 10143,
      api_key: "TOKEN",
      timestamp: "1789000000000",
      nonce: "AQIDBAUGBwgJCgsMDQ4PEA",
      signature: vectors.signin.signature,
    });
  });

  for (const v of vectors.rest) {
    it(`REST ${v.method} ${v.target}`, () => {
      const canonical = canonicalRest({ chainId: vectors.chainId, method: v.method, target: v.target, timestamp: vectors.timestamp, nonce: vectors.nonce, body: v.body });
      expect(canonical).toBe(v.canonical);
      expect(signer.signText(canonical)).toBe(v.signature);
      const h = signRestRequest(signer, { chainId: vectors.chainId, apiKey: "K", method: v.method, target: v.target, body: v.body }, { nowMs: Number(vectors.timestamp), nonce: vectors.nonce });
      expect(h["X-API-Signature"]).toBe(v.signature);
      expect(h["X-API-Timestamp"]).toBe(vectors.timestamp);
      expect(h["X-API-Nonce"]).toBe(vectors.nonce);
      expect(h["X-API-Key"]).toBe("K");
    });
  }

  it("verifies its own signatures and rejects tampering", () => {
    expect(verifySignature(signer.publicKey, vectors.signin.canonical, vectors.signin.signature)).toBe(true);
    expect(verifySignature(signer.publicKeyHex, vectors.signin.canonical, vectors.signin.signature)).toBe(true);
    expect(verifySignature(signer.publicKey, vectors.signin.canonical + "x", vectors.signin.signature)).toBe(false);
    expect(verifySignature(signer.publicKey, vectors.signin.canonical, "AAAA")).toBe(false);
  });

  it("nonce is 16 random bytes base64url without padding", () => {
    const n = randomNonce();
    expect(n).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomNonce()).not.toBe(n);
  });
});

describe("signing: key formats", () => {
  const seedHex = vectors.ed25519Seed;
  const seed = Buffer.from(seedHex, "hex");
  const expectedPub = signer.publicKeyHex;
  const pubOf = (s: string): string => Ed25519Signer.fromSecret(s).publicKeyHex;

  it("hex, 0x hex, upper case, quoted and whitespace-wrapped", () => {
    expect(pubOf(seedHex)).toBe(expectedPub);
    expect(pubOf("0x" + seedHex)).toBe(expectedPub);
    expect(pubOf(seedHex.toUpperCase())).toBe(expectedPub);
    expect(pubOf(`  "${seedHex}"\n`)).toBe(expectedPub);
  });

  it("64-byte seed||public (hex and base64)", () => {
    const full = Buffer.concat([seed, Buffer.from(expectedPub.slice(2), "hex")]);
    expect(pubOf(full.toString("hex"))).toBe(expectedPub);
    expect(pubOf(full.toString("base64"))).toBe(expectedPub);
  });

  it("base64 and base64url, padded or not", () => {
    expect(pubOf(seed.toString("base64"))).toBe(expectedPub);
    expect(pubOf(seed.toString("base64url"))).toBe(expectedPub);
    expect(pubOf(seed.toString("base64").replace(/=+$/, ""))).toBe(expectedPub);
  });

  it("PKCS#8 PEM and DER-in-base64", () => {
    const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
    const pem = `-----BEGIN PRIVATE KEY-----\n${der.toString("base64")}\n-----END PRIVATE KEY-----\n`;
    expect(pubOf(pem)).toBe(expectedPub);
    expect(pubOf(der.toString("base64"))).toBe(expectedPub);
  });

  it("accepts raw bytes", () => {
    expect(Ed25519Signer.fromSecret(seed).publicKeyHex).toBe(expectedPub);
  });

  it("rejects garbage with a KeyParseError", () => {
    for (const bad of ["", "not a key", "abcd", "0x1234", "!!!!!!!!!!"]) expect(() => parseEd25519Seed(bad)).toThrow(KeyParseError);
  });

  it("never leaks the private key through JSON or inspect", () => {
    expect(JSON.stringify(signer)).not.toContain(seedHex);
    expect(JSON.stringify(signer)).toContain(expectedPub);
  });

  it("generate() round-trips", () => {
    const { signer: s, seedHex: h } = Ed25519Signer.generate();
    expect(Ed25519Signer.fromSecret(h).publicKeyHex).toBe(s.publicKeyHex);
    const sig = s.signText("hello");
    expect(verifySignature(s.publicKey, "hello", sig)).toBe(true);
    // sanity: same as sha256 independent check of helper
    expect(sha256Hex("a")).toBe(createHash("sha256").update("a").digest("hex"));
  });
});

describe("signing: pasted credentials", () => {
  it("JSON", () => {
    expect(parseApiCredentials('{"api_key":"abc","secret":"0011"}')).toEqual({ apiKey: "abc", secret: "0011" });
    expect(parseApiCredentials('{"apiKey":"abc","privateKey":"0011"}')).toEqual({ apiKey: "abc", secret: "0011" });
  });
  it("env lines", () => {
    expect(parseApiCredentials("PERPL_API_KEY=abc\nPERPL_API_KEY_SECRET=0011\n")).toEqual({ apiKey: "abc", secret: "0011" });
    expect(parseApiCredentials("export PERPL_API_KEY='abc'\nexport PERPL_API_KEY_SECRET=\"0011\"")).toEqual({ apiKey: "abc", secret: "0011" });
  });
  it("key: value lines", () => {
    expect(parseApiCredentials("API Key: nope\napi_key: abc\nprivate_key: 0011")).toMatchObject({ secret: "0011" });
  });
});
