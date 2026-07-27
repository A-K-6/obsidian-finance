import { describe, expect, it } from "vitest";
import { accountBalances, monthRange, netBalancesByCurrency, summarize, validateTransaction, weekRange } from "@/domain/finance";
import type { Account, FinanceTransaction } from "@/types";

const createdAt = "2026-07-01T00:00:00.000Z";
const accounts: Account[] = [
  { id: "bank", name: "Bank", kind: "bank", currency: "USD", openingBalanceMinor: 100_00, archived: false, createdAt, updatedAt: createdAt },
  { id: "card", name: "Card", kind: "credit-card", currency: "USD", openingBalanceMinor: 20_00, creditLimitMinor: 1000_00, archived: false, createdAt, updatedAt: createdAt },
  { id: "euro", name: "Euro cash", kind: "cash", currency: "EUR", openingBalanceMinor: 0, archived: false, createdAt, updatedAt: createdAt }
];

const transactions: FinanceTransaction[] = [
  { id: "expense", type: "expense", accountId: "card", amountMinor: 30_00, currency: "USD", date: "2026-07-06", createdAt, updatedAt: createdAt },
  { id: "refund", type: "refund", accountId: "card", amountMinor: 5_00, currency: "USD", date: "2026-07-07", createdAt, updatedAt: createdAt },
  { id: "income", type: "income", accountId: "bank", amountMinor: 200_00, currency: "USD", date: "2026-07-07", createdAt, updatedAt: createdAt },
  { id: "payment", type: "card-payment", fromAccountId: "bank", toAccountId: "card", sourceAmountMinor: 25_00, destinationAmountMinor: 25_00, sourceCurrency: "USD", destinationCurrency: "USD", date: "2026-07-08", createdAt, updatedAt: createdAt },
  { id: "exchange", type: "transfer", fromAccountId: "bank", toAccountId: "euro", sourceAmountMinor: 10_00, destinationAmountMinor: 9_00, sourceCurrency: "USD", destinationCurrency: "EUR", date: "2026-07-08", createdAt, updatedAt: createdAt }
];

describe("finance rules", () => {
  it("calculates asset and credit-card balances without double-counting payments", () => {
    const balances = accountBalances(accounts, transactions);
    expect(balances.get("bank")).toBe(265_00);
    expect(balances.get("card")).toBe(20_00);
    expect(balances.get("euro")).toBe(9_00);
  });

  it("calculates net current balance per currency across active accounts", () => {
    const totals = netBalancesByCurrency(accounts, transactions);
    expect(totals.get("USD")).toBe(245_00);
    expect(totals.get("EUR")).toBe(9_00);
  });

  it("excludes transfers and card payments from summaries", () => {
    const summary = summarize(transactions, "2026-07-01", "2026-07-31").get("USD");
    expect(summary).toEqual({ income: 200_00, expenses: 30_00, refunds: 5_00, net: 175_00 });
  });

  it("keeps currencies in separate summary buckets", () => {
    const withEuroExpense: FinanceTransaction[] = [...transactions, { id: "e", type: "expense", accountId: "euro", amountMinor: 4_00, currency: "EUR", date: "2026-07-09", createdAt, updatedAt: createdAt }];
    const summary = summarize(withEuroExpense, "2026-07-01", "2026-07-31");
    expect(summary.get("USD")?.expenses).toBe(30_00);
    expect(summary.get("EUR")?.expenses).toBe(4_00);
  });

  it("requires equal values for a same-currency transfer", () => {
    const invalid: FinanceTransaction = { id: "bad", type: "transfer", fromAccountId: "bank", toAccountId: "bank-2", sourceAmountMinor: 100, destinationAmountMinor: 90, sourceCurrency: "USD", destinationCurrency: "USD", date: "2026-07-08", createdAt, updatedAt: createdAt };
    const bank2: Account = { ...accounts[0], id: "bank-2", name: "Second bank" };
    expect(() => validateTransaction(invalid, [...accounts, bank2])).toThrow("same source and destination amount");
  });

  it("calculates local week and month boundaries", () => {
    expect(weekRange(new Date(2026, 6, 8), 1)).toEqual(["2026-07-06", "2026-07-12"]);
    expect(monthRange(new Date(2026, 1, 12))).toEqual(["2026-02-01", "2026-02-28"]);
  });

  it("rejects impossible calendar dates", () => {
    const invalid: FinanceTransaction = { id: "date", type: "expense", accountId: "bank", amountMinor: 100, currency: "USD", date: "2026-02-31", createdAt, updatedAt: createdAt };
    expect(() => validateTransaction(invalid, accounts)).toThrow("valid transaction date");
  });

  it("allows an existing transaction to remain on its archived account", () => {
    const archivedAccounts = accounts.map((account) => account.id === "bank" ? { ...account, archived: true } : account);
    const existing: FinanceTransaction = { id: "old", type: "expense", accountId: "bank", amountMinor: 100, currency: "USD", date: "2026-07-08", createdAt, updatedAt: createdAt };
    expect(() => validateTransaction(existing, archivedAccounts, new Set(["bank"]))).not.toThrow();
  });
});
