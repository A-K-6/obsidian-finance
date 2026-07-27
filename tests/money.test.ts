import { describe, expect, it } from "vitest";
import { formatMoney, minorToInput, normalizeLocale, parseMoney, parseNonNegativeMoney } from "@/domain/money";

describe("money", () => {
  it("parses two-decimal currencies into integer minor units", () => {
    expect(parseMoney("12.34", "USD")).toBe(1234);
  });

  it("handles zero-decimal currencies", () => {
    expect(parseMoney("1200", "JPY")).toBe(1200);
    expect(() => parseMoney("12.5", "JPY")).toThrow();
  });

  it("handles three-decimal currencies", () => {
    expect(parseMoney("1.234", "KWD")).toBe(1234);
  });

  it("accepts comma and space grouping separators", () => {
    expect(parseMoney("1,250,000.50", "USD")).toBe(125_000_050);
    expect(parseMoney("1 250 000", "IRR")).toBe(125_000_000);
  });

  it("rejects invalid precision and non-positive amounts", () => {
    expect(() => parseMoney("1.234", "USD")).toThrow();
    expect(() => parseMoney("0", "USD")).toThrow();
    expect(() => parseMoney("-1", "USD")).toThrow();
  });

  it("formats from integer minor units", () => {
    expect(formatMoney(1234, "USD", "en-US")).toContain("12.34");
  });

  it("accepts zero opening balances at the currency precision", () => {
    expect(parseNonNegativeMoney("0.000", "KWD")).toBe(0);
  });

  it("round-trips large safe integer amounts without floating-point conversion", () => {
    expect(minorToInput(9_000_000_000_000_001, "KWD")).toBe("9000000000000.001");
  });

  it("validates and canonicalizes locales", () => {
    expect(normalizeLocale("en-us")).toBe("en-US");
    expect(() => normalizeLocale("en_US")).toThrow();
  });
});
