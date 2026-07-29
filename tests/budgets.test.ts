import { describe, expect, it } from "vitest";
import { budgetStatus, safeAddMinor } from "@/domain/budgets";
import type { Category, FinanceTransaction, MonthlyBudget } from "@/types";

const timestamp = "2026-01-01T00:00:00.000Z";
const budget: MonthlyBudget = {
  id: "budget", categoryId: "groceries", currency: "USD", calendar: "persian", month: "1405-01",
  amountMinor: 30_000, createdAt: timestamp, updatedAt: timestamp
};

const categories: Category[] = [
  { id: "groceries", name: "Groceries", type: "expense", archived: false, createdAt: timestamp, updatedAt: timestamp },
  { id: "produce", name: "Produce", type: "expense", parentCategoryId: "groceries", archived: false, createdAt: timestamp, updatedAt: timestamp },
  { id: "travel", name: "Travel", type: "expense", archived: false, createdAt: timestamp, updatedAt: timestamp }
];

const transactions: FinanceTransaction[] = [
  { id: "expense", type: "expense", accountId: "bank", amountMinor: 35_000, currency: "USD", categoryId: "groceries", date: "2026-03-25", createdAt: timestamp, updatedAt: timestamp },
  { id: "refund", type: "refund", accountId: "bank", amountMinor: 4_000, currency: "USD", categoryId: "groceries", date: "2026-03-26", createdAt: timestamp, updatedAt: timestamp },
  { id: "child-expense", type: "expense", accountId: "bank", amountMinor: 2_000, currency: "USD", categoryId: "produce", date: "2026-03-26", createdAt: timestamp, updatedAt: timestamp },
  { id: "child-refund", type: "refund", accountId: "bank", amountMinor: 500, currency: "USD", categoryId: "produce", date: "2026-03-27", createdAt: timestamp, updatedAt: timestamp },
  { id: "eur", type: "expense", accountId: "euro", amountMinor: 99_000, currency: "EUR", categoryId: "produce", date: "2026-03-26", createdAt: timestamp, updatedAt: timestamp },
  { id: "other", type: "expense", accountId: "bank", amountMinor: 99_000, currency: "USD", categoryId: "travel", date: "2026-03-26", createdAt: timestamp, updatedAt: timestamp },
  { id: "outside", type: "expense", accountId: "bank", amountMinor: 99_000, currency: "USD", categoryId: "groceries", date: "2026-04-25", createdAt: timestamp, updatedAt: timestamp }
];

describe("monthly budgets", () => {
  it("rolls direct child expenses and refunds into a root budget without mixing currencies", () => {
    expect(budgetStatus(budget, transactions, categories)).toEqual({
      budget, spentMinor: 32_500, remainingMinor: -2_500, overspent: true, includesSubcategories: true
    });
  });

  it("keeps a child budget scoped to that child", () => {
    const childBudget = { ...budget, id: "child-budget", categoryId: "produce", amountMinor: 2_000 };
    expect(budgetStatus(childBudget, transactions, categories)).toEqual({
      budget: childBudget, spentMinor: 1_500, remainingMinor: 500, overspent: false, includesSubcategories: false
    });
  });

  it("reports textual overspending state from a signed remaining amount", () => {
    const status = budgetStatus({ ...budget, amountMinor: 33_000 }, transactions, categories);
    expect(status.overspent).toBe(false);
    expect(status.remainingMinor).toBe(500);
  });

  it("rejects unsafe money aggregation", () => {
    expect(() => safeAddMinor(Number.MAX_SAFE_INTEGER, 1)).toThrow("outside the supported range");
  });
});
