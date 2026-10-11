import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { decrypt, encrypt, generateSecret, safeEqual, shortId } from "../src/crypto";

describe("crypto", () => {
  const key = randomBytes(32);
  it("round-trips and uses a fresh IV each time", () => {
    const a = encrypt("hello", key);
    const b = encrypt("hello", key);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe("hello");
    expect(decrypt(encrypt("", key), key)).toBe("");
    expect(decrypt(encrypt("ünïcödé 🔑", key), key)).toBe("ünïcödé 🔑");
  });
  it("rejects tampering, wrong keys and bad formats", () => {
    const c = encrypt("secret", key);
    const parts = c.split(".");
    const flipped = [parts[0], parts[1], parts[2], Buffer.from("x" + Buffer.from(parts[3]!, "base64url").toString("latin1").slice(1), "latin1").toString("base64url")].join(".");
    expect(() => decrypt(flipped, key)).toThrow();
    expect(() => decrypt(c, randomBytes(32))).toThrow();
    expect(() => decrypt("garbage", key)).toThrow();
    expect(() => encrypt("x", Buffer.alloc(16))).toThrow();
  });
  it("safeEqual compares correctly regardless of length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
  it("generates url-safe ids and secrets", () => {
    expect(shortId()).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(generateSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(Array.from({ length: 200 }, () => shortId())).size).toBe(200);
  });
});

describe("config", () => {
  it("defaults to sim + dev auth with an ephemeral key and loud warnings", () => {
    const c = loadConfig({ NODE_ENV: "development" });
    expect(c).toMatchObject({ port: 8787, perplMode: "sim", authMode: "dev", masterKeyEphemeral: true, databasePath: "./data/hermes.db" });
    expect(c.masterKey).toHaveLength(32);
    expect(c.warnings.join(" ")).toMatch(/EPHEMERAL/);
    expect(c.publicBaseUrl).toBe("http://localhost:8787");
  });
  it("selects privy automatically when PRIVY_APP_ID is present and requires the secret", () => {
    expect(() => loadConfig({ PRIVY_APP_ID: "x" })).toThrow(/PRIVY_APP_SECRET/);
    expect(loadConfig({ PRIVY_APP_ID: "x", PRIVY_APP_SECRET: "y" }).authMode).toBe("privy");
    expect(loadConfig({ PRIVY_APP_ID: "x", PRIVY_APP_SECRET: "y", AUTH_MODE: "dev" }).authMode).toBe("dev");
  });
  it("validates the master key and requires it in production", () => {
    expect(() => loadConfig({ HERMES_MASTER_KEY: "abc" })).toThrow(/64 hex/);
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/HERMES_MASTER_KEY/);
    const k = "ab".repeat(32);
    expect(loadConfig({ HERMES_MASTER_KEY: k }).masterKey.toString("hex")).toBe(k);
  });
  it("treats empty strings as unset and trims trailing slashes", () => {
    const c = loadConfig({ PORT: "", PUBLIC_BASE_URL: "https://x.example/", PRIVY_APP_ID: "", AUTH_MODE: "" });
    expect(c.port).toBe(8787);
    expect(c.publicBaseUrl).toBe("https://x.example");
    expect(c.authMode).toBe("dev");
  });
});
