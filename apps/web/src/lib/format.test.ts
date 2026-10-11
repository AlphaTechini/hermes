import { describe, expect, it } from "vitest";
import {
  explorerAddressUrl,
  explorerTxUrl,
  formatBps,
  formatClock,
  formatCountdown,
  formatDateTime,
  formatDeltaMs,
  formatFraction,
  formatLeverage,
  formatLeverageX,
  formatMs,
  formatPercent,
  formatPrice,
  formatRelativeTime,
  formatSignedUsd,
  formatSize,
  formatTableTime,
  formatUsd,
  maskSecret,
  orNA,
  shortHex,
  slippageTone,
} from "./format";

describe("prices and sizes", () => {
  it("uses market-specific decimals", () => {
    expect(formatPrice(112048.5, "BTC")).toBe("112,048.5");
    expect(formatPrice(4098.62, "ETH")).toBe("4,098.62");
    expect(formatPrice(210.412, "SOL")).toBe("210.412");
    expect(formatPrice(0.040118, "MON")).toBe("0.040118");
    expect(formatPrice(287.4, "ZEC")).toBe("287.40");
    expect(formatPrice(112031, "BTC")).toBe("112,031.0");
  });
  it("sizes follow lot decimals", () => {
    expect(formatSize(0.05, "BTC")).toBe("0.050");
    expect(formatSize(1.2, "ETH")).toBe("1.20");
    expect(formatSize(140, "SOL")).toBe("140.0");
    expect(formatSize(150000, "MON")).toBe("150,000");
  });
  it("missing is n/a", () => {
    expect(formatPrice(null, "BTC")).toBe("n/a");
    expect(formatSize(undefined, "BTC")).toBe("n/a");
    expect(formatPrice(Number.NaN, "BTC")).toBe("n/a");
    expect(orNA(null, String)).toBe("n/a");
  });
});

describe("money", () => {
  it("formats USD", () => {
    expect(formatUsd(5602.43)).toBe("$5,602.43");
    expect(formatUsd(29458, { summary: true })).toBe("$29,458");
    expect(formatUsd(1_280_000, { summary: true })).toBe("$1.28M");
    expect(formatUsd(9999.5, { summary: true })).toBe("$9,999.50");
    expect(formatUsd(-12.5)).toBe("−$12.50");
  });
  it("signs PnL with U+2212 before the dollar sign", () => {
    expect(formatSignedUsd(22.05)).toBe("+$22.05");
    expect(formatSignedUsd(-137.2)).toBe("−$137.20");
    expect(formatSignedUsd(0)).toBe("$0.00");
    expect(formatSignedUsd(-137.2)).not.toContain("-");
  });
  it("percent", () => {
    expect(formatPercent(91.2)).toBe("91.2%");
    expect(formatPercent(0.37, { signed: true })).toBe("+0.4%");
    expect(formatPercent(-0.13, { signed: true, decimals: 2 })).toBe("−0.13%");
    expect(formatFraction(0.953)).toBe("95.3%");
  });
});

describe("slippage and latency", () => {
  it("bps, 1 decimal", () => {
    expect(formatBps(1.6)).toBe("1.6 bps");
    expect(formatBps(-0.4)).toBe("−0.4 bps");
    expect(formatBps(2.1, { signed: true })).toBe("+2.1 bps");
    expect(formatBps(null)).toBe("n/a");
  });
  it("slippage tone", () => {
    expect(slippageTone(-0.4)).toBe("better");
    expect(slippageTone(1.6, 30)).toBe("neutral");
    expect(slippageTone(31, 30)).toBe("warning");
  });
  it("ms and seconds", () => {
    expect(formatMs(0.4)).toBe("<1 ms");
    expect(formatMs(612)).toBe("612 ms");
    expect(formatMs(999.6)).toBe("1.00 s");
    expect(formatMs(1240)).toBe("1.24 s");
    expect(formatMs(1420)).toBe("1.42 s");
  });
  it("stage deltas", () => {
    expect(formatDeltaMs(0, { first: true })).toBe("0 ms");
    expect(formatDeltaMs(184)).toBe("+184 ms");
    expect(formatDeltaMs(0.3)).toBe("<1 ms");
    expect(formatDeltaMs(1500)).toBe("+1.50 s");
  });
  it("leverage and countdown", () => {
    expect(formatLeverage(500)).toBe("5.0x");
    expect(formatLeverageX(10)).toBe("10x");
    expect(formatCountdown(102)).toBe("1:42");
    expect(formatCountdown(38)).toBe("0:38");
  });
});

describe("time", () => {
  const t = new Date(2026, 9, 11, 14, 32, 18, 904).getTime();
  it("clock with ms", () => {
    expect(formatClock(t)).toBe("14:32:18.904");
    expect(formatClock(t, { ms: false })).toBe("14:32:18");
  });
  it("tables: time today, date and time before", () => {
    expect(formatTableTime(t, t + 1000)).toBe("14:32:18");
    expect(formatTableTime(t, t + 2 * 86_400_000)).toBe("11 Oct 14:32");
    expect(formatDateTime(new Date(2026, 9, 11, 22, 31).getTime())).toBe("11 Oct 22:31");
  });
  it("relative", () => {
    expect(formatRelativeTime(t, t + 1000)).toBe("now");
    expect(formatRelativeTime(t, t + 12_000)).toBe("12s ago");
    expect(formatRelativeTime(t, t + 4 * 60_000)).toBe("4m ago");
    expect(formatRelativeTime(t, t + 3 * 3_600_000)).toBe("3h ago");
    expect(formatRelativeTime(t, t + 30 * 3_600_000)).toBe(formatDateTime(t));
  });
});

describe("addresses and links", () => {
  it("truncates with U+2026", () => {
    expect(shortHex("0x7a3F9c21E0b84d6A5f1C3e7B92d40aF8c6E191c2")).toBe("0x7a3F…91c2");
    expect(shortHex("0x8f3a")).toBe("0x8f3a");
    expect(shortHex(null)).toBe("n/a");
  });
  it("explorer links", () => {
    expect(explorerTxUrl("0xabc")).toBe("https://testnet.monadexplorer.com/tx/0xabc");
    expect(explorerAddressUrl("0xdef")).toBe("https://testnet.monadexplorer.com/address/0xdef");
  });
  it("masks secrets but keeps the last four", () => {
    const m = maskSecret("whsec_9fT2mQ7vLc4Rk8Zp1Xn6hx2K");
    expect(m.endsWith("hx2K")).toBe(true);
    expect(m.startsWith("•".repeat(20))).toBe(true);
  });
});
