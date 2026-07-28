import { describe, expect, it } from "vitest";
import { budgetStatus, safeAddMinor } from "@/domain/budgets";
import type { FinanceTransaction, MonthlyBudget } from "@/types";

const timestamp = "2026-01-01T00:00:00.000Z";
const budget: MonthlyBudget = {
  id: "budget", categoryId: "groceries", currency: "USD", calendar: "persian", month: "1405-01",
  amountMinor: 30_000, createdAt: timestamp, updatedAt: timestamp
};

const transactions: FinanceTransaction[] = [
  { id: "expense", type: "expense", accountId: "bank", amountMinor: 35_000, currency: "USD", categoryId: "groceries", date: "2026-03-25", createdAt: timestamp, updatedAt: timestamp },
  { id: "refund", type: "refund", accountId: "bank", amountMinor: 4_000, currency: "USD", categoryId: "groceries", date: "2026-03-26", createdAt: timestamp, updatedAt: timestamp },
  { id: "eur", type: "expense", accountId: "euro", amountMinor: 99_000, currency: "EUR", categoryId: "groceries", date: "2026-03-26", createdAt: timestamp, updatedAt: timestamp },
  { id: "other", type: "expense", accountId: "bank", amountMinor: 99_000, currency: "USD", categoryId: "travel", date: "2026-03-26", createdAt: timestamp, updatedAt: timestamp },
  { id: "outside", type: "expense", accountId: "bank", amountMinor: 99_000, currency: "USD", categoryId: "groceries", date: "2026-04-25", createdAt: timestamp, updatedAt: timestamp }
];

describe("monthly budgets", () => {
  it("subtracts same-category refunds and never mixes currencies", () => {
    expect(budgetStatus(budget, transactions)).toEqual({ budget, spentMinor: 31_000, remainingMinor: -1_000, overspent: true });
  });

  it("reports textual overspending state from a signed remaining amount", () => {
    const status = budgetStatus({ ...budget, amountMinor: 32_000 }, transactions);
    expect(status.overspent).toBe(false);
    expect(status.remainingMinor).toBe(1_000);
  });

  it("rejects unsafe money aggregation", () => {
    expect(() => safeAddMinor(Number.MAX_SAFE_INTEGER, 1)).toThrow("outside the supported range");
  });
});
