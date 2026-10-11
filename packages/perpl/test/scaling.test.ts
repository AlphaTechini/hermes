import { describe, expect, it } from "vitest";
import {
  ausdToCns,
  checkLeverage,
  cnsToAusd,
  feeFromNotional,
  feeMicrosFor,
  formatScaled,
  fromScaled,
  hundredthsToLeverage,
  leverageToHundredths,
  lotsForNotional,
  notionalUsd,
  priceToTicks,
  sizeToLots,
  slippageBps,
  toDecimalString,
  toScaled,
  toScaledNumber,
} from "../src/scaling";

describe("toDecimalString", () => {
  it("expands exponents and strips float noise", () => {
    expect(toDecimalString(1e-7)).toBe("0.0000001");
    expect(toDecimalString(1.5e21)).toBe("1500000000000000000000");
    expect(toDecimalString(0.1 + 0.2)).toBe("0.3");
    expect(toDecimalString(0.0036899999999999997)).toBe("0.00369");
    expect(toDecimalString("  012.500 ")).toBe("12.5");
    expect(toDecimalString("-0.50")).toBe("-0.5");
    expect(toDecimalString(5n)).toBe("5");
  });
  it("rejects junk", () => {
    expect(() => toDecimalString("abc")).toThrow();
    expect(() => toDecimalString(NaN)).toThrow();
    expect(() => toDecimalString("")).toThrow();
  });
});

describe("toScaled / fromScaled", () => {
  it("scales prices by price_decimals (BTC: 1 decimal)", () => {
    expect(toScaled(112000, 1)).toBe(1120000n);
    expect(toScaled("112000.05", 1)).toBe(1120001n); // round half up
    expect(toScaled("112000.04", 1)).toBe(1120000n);
    expect(toScaled("112000.09", 1, "floor")).toBe(1120000n);
    expect(toScaled("112000.01", 1, "ceil")).toBe(1120001n);
  });
  it("does not drift on classic float cases", () => {
    expect(toScaled(0.1 + 0.2, 1)).toBe(3n);
    expect(toScaled(1.005, 2, "floor")).toBe(100n);
    expect(toScaled(4100.35, 2)).toBe(410035n);
    expect(toScaled(0.04, 5)).toBe(4000n);
    expect(toScaledNumber(60.123, 3)).toBe(60123);
  });
  it("is bigint safe beyond 2^53", () => {
    expect(toScaled("123456789012345678.123456", 6)).toBe(123456789012345678123456n);
    expect(formatScaled(123456789012345678123456n, 6)).toBe("123456789012345678.123456");
  });
  it("throws on negatives and unsafe sizes", () => {
    expect(() => toScaled(-1, 2)).toThrow();
    expect(toScaled("-0", 2)).toBe(0n);
    expect(() => toScaledNumber("90071992547409.93", 2)).toThrow(/safe integer/);
  });
  it("formatScaled / fromScaled", () => {
    expect(formatScaled(1120005n, 1)).toBe("112000.5");
    expect(formatScaled(5, 3)).toBe("0.005");
    expect(formatScaled(-1500000, 6)).toBe("-1.5");
    expect(formatScaled("100000000", 6)).toBe("100");
    expect(fromScaled(1120005, 1)).toBeCloseTo(112000.5, 6);
    expect(fromScaled("123456789012345678123456", 6)).toBe(123456789012345680);
  });
});

describe("rounding to tick and lot", () => {
  it("lots round DOWN by default (never more than asked)", () => {
    expect(sizeToLots(0.001, 5)).toBe(100);
    expect(sizeToLots(0.0010099, 5)).toBe(100);
    expect(sizeToLots(0.0000099, 5)).toBe(0);
    expect(sizeToLots(1.9, 0)).toBe(1); // MON has 0 size decimals
    expect(sizeToLots(0.00123 * 3, 5)).toBe(369);
  });
  it("lot multiples", () => {
    expect(sizeToLots(0.00123, 5, "floor", 10)).toBe(120);
    expect(sizeToLots(0.00123, 5, "ceil", 10)).toBe(130);
    expect(sizeToLots(0.00125, 5, "round", 10)).toBe(130);
  });
  it("tick rounding", () => {
    expect(priceToTicks(112000.04, 1)).toBe(1120000);
    expect(priceToTicks(112000.06, 1)).toBe(1120001);
    expect(priceToTicks(4100.123, 2, "floor")).toBe(410012);
    expect(priceToTicks(4100.123, 2, "ceil")).toBe(410013);
    expect(priceToTicks(4100.12, 2, "round", 5)).toBe(410010);
    expect(priceToTicks(4100.13, 2, "round", 5)).toBe(410015);
  });
  it("rejects bad multiples", () => {
    expect(() => sizeToLots(1, 2, "floor", 0)).toThrow();
  });
});

describe("lotsForNotional", () => {
  it("$500 of BTC at 112000 with 5 size decimals", () => {
    // 500 / 112000 = 0.004464285... -> 446 lots
    expect(lotsForNotional(500, 112000, 5)).toBe(446);
    expect(lotsForNotional(500, 112000, 5, "ceil")).toBe(447);
    expect(lotsForNotional(500, 112000, 5, "round")).toBe(446);
  });
  it("exact division", () => {
    expect(lotsForNotional(100, 50, 3)).toBe(2000);
    expect(lotsForNotional(1000, 0.04, 0)).toBe(25000);
  });
  it("too small returns 0", () => {
    expect(lotsForNotional(0.5, 112000, 5)).toBe(0);
  });
  it("rejects a zero price", () => {
    expect(() => lotsForNotional(10, 0, 3)).toThrow();
  });
  it("notionalUsd round trips", () => {
    expect(notionalUsd(100, 1120000, { sizeDecimals: 5, priceDecimals: 1 })).toBeCloseTo(112, 6);
  });
});

describe("leverage", () => {
  it("hundredths", () => {
    expect(leverageToHundredths(5)).toBe(500);
    expect(leverageToHundredths(2.5)).toBe(250);
    expect(leverageToHundredths("1.255")).toBe(126);
    expect(hundredthsToLeverage(500)).toBe(5);
  });
  it("checkLeverage against initial_margin", () => {
    const m = { maxLeverageHdths: 1500, symbol: "BTC" };
    expect(checkLeverage(100, m)).toBeUndefined();
    expect(checkLeverage(1500, m)).toBeUndefined();
    expect(checkLeverage(1501, m)).toMatch(/at most 15x/);
    expect(checkLeverage(99, m)).toMatch(/at least 1x/);
  });
});

describe("AUSD amounts and fees", () => {
  it("6 decimals", () => {
    expect(ausdToCns(100)).toBe(100_000_000n);
    expect(ausdToCns("0.000001")).toBe(1n);
    expect(cnsToAusd("100000000")).toBe(100);
    expect(cnsToAusd("-1500000")).toBe(-1.5);
  });
  it("fee tiers fall back to the base rate", () => {
    const m = { makerFeesMicros: [45, 36], takerFeesMicros: [345, 276], makerFeeMicros: 45, takerFeeMicros: 345 };
    expect(feeMicrosFor(m, 0, false)).toBe(345);
    expect(feeMicrosFor(m, 1, false)).toBe(276);
    expect(feeMicrosFor(m, 7, false)).toBe(345);
    expect(feeMicrosFor({ ...m, takerFeesMicros: [] }, 1, false)).toBe(345);
    expect(feeMicrosFor(m, -1, true)).toBe(45);
  });
  it("fee = notional x micros / 1e6", () => {
    expect(feeFromNotional(500_000_000n, 345)).toBe(172_500n); // $500 * 3.45 bps = $0.1725
  });
  it("slippage sign convention", () => {
    expect(slippageBps(100, 100.1, "buy")).toBeCloseTo(10, 6);
    expect(slippageBps(100, 99.9, "sell")).toBeCloseTo(10, 6);
    expect(slippageBps(100, 99.9, "buy")).toBeCloseTo(-10, 6);
    expect(slippageBps(0, 1, "buy")).toBe(0);
  });
});
