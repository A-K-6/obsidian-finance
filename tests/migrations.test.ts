import { describe, expect, it, vi } from "vitest";
import { FinanceStore } from "@/store/finance-store";
import type { FinanceData } from "@/types";

const timestamp = "2026-07-01T00:00:00.000Z";
const v1 = {
  schemaVersion: 1,
  settings: { locale: "en-US", weekStartsOn: 1, defaultCurrency: "USD", defaultAccountId: "bank" },
  accounts: [{ id: "bank", name: "Bank", kind: "bank", currency: "USD", openingBalanceMinor: 12_345, archived: false, createdAt: timestamp, updatedAt: timestamp }],
  transactions: [
    { id: "expense", type: "expense", accountId: "bank", amountMinor: 999, currency: "USD", category: "  Groceries  ", date: "2026-07-02", note: "exact", createdAt: timestamp, updatedAt: timestamp },
    { id: "refund", type: "refund", accountId: "bank", amountMinor: 111, currency: "USD", category: "  Groceries  ", date: "2026-07-03", createdAt: timestamp, updatedAt: timestamp },
    { id: "income", type: "income", accountId: "bank", amountMinor: 5_000, currency: "USD", category: "Salary", date: "2026-07-04", createdAt: timestamp, updatedAt: timestamp }
  ]
};

const v2Rule = {
  id: "salary", type: "income", frequency: "monthly", accountId: "bank", amountMinor: 500_000,
  currency: "USD", categoryId: "income", description: "Salary", anchorDueDate: "2026-07-31", nextDueDate: "2026-08-31",
  note: "preserve me", calendar: "gregorian", active: true, createdAt: timestamp, updatedAt: timestamp
};
const v2 = {
  schemaVersion: 2,
  settings: { locale: "en-US", weekStartsOn: 1, defaultCurrency: "USD", defaultAccountId: "bank", calendar: "gregorian" },
  accounts: v1.accounts,
  categories: [{ id: "income", name: "Income", type: "income", archived: false, createdAt: timestamp, updatedAt: timestamp }],
  budgets: [],
  recurringRules: [v2Rule],
  recurringResolutions: [{ id: "resolution-salary-2026-07-31", ruleId: "salary", occurrenceDate: "2026-07-31", action: "skipped", resolvedAt: timestamp }],
  transactions: []
};

describe("sequential schema migration to v3", () => {
  it("migrates v1 through v2 to v3 while preserving financial records exactly", async () => {
    const save = vi.fn(async (_data: FinanceData) => undefined);
    const store = new FinanceStore(save);
    await store.load(v1);
    const data = store.snapshot();
    expect(data.schemaVersion).toBe(3);
    expect(data.settings.calendar).toBe("gregorian");
    expect(data.accounts[0]).toEqual(v1.accounts[0]);
    expect(data.transactions.map((item) => ({ id: item.id, date: item.date, createdAt: item.createdAt, updatedAt: item.updatedAt }))).toEqual(v1.transactions.map((item) => ({ id: item.id, date: item.date, createdAt: item.createdAt, updatedAt: item.updatedAt })));
    expect(data.categories.map((item) => [item.name, item.type])).toEqual([["  Groceries  ", "expense"], ["Salary", "income"]]);
    const expense = data.transactions[0];
    const refund = data.transactions[1];
    expect("categoryId" in expense && "categoryId" in refund ? expense.categoryId : undefined).toBe("categoryId" in refund ? refund.categoryId : undefined);
    expect((save.mock.calls[0]?.[0].transactions[0] as unknown as Record<string, unknown>).category).toBe("  Groceries  ");
    expect(save).toHaveBeenCalledOnce();
  });

  it("preserves v2 collection keys, rules, resolutions, and adds only safe schedule defaults", async () => {
    const save = vi.fn(async (_data: FinanceData) => undefined);
    const store = new FinanceStore(save);
    await store.load(v2);
    const data = store.snapshot();
    expect(data.schemaVersion).toBe(3);
    expect(data.recurringRules).toHaveLength(1);
    expect(data.recurringRules[0]).toMatchObject({ ...v2Rule, kind: "recurring-income", interval: 1, reminderLeadDays: 0 });
    expect(data.recurringResolutions).toEqual(v2.recurringResolutions);
    expect(Object.prototype.hasOwnProperty.call(save.mock.calls[0]?.[0] ?? {}, "recurringRules")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(save.mock.calls[0]?.[0] ?? {}, "recurringResolutions")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(save.mock.calls[0]?.[0] ?? {}, "scheduledItems")).toBe(false);
    expect(save).toHaveBeenCalledOnce();
  });

  it("loads persisted v3 idempotently without saving again", async () => {
    let migrated: unknown;
    const first = new FinanceStore(async (data) => { migrated = data; });
    await first.load(v2);
    const save = vi.fn(async () => undefined);
    const second = new FinanceStore(save);
    await second.load(migrated);
    expect(second.snapshot()).toEqual(first.snapshot());
    expect(save).not.toHaveBeenCalled();
  });

  it("does not commit in memory when sequential migration persistence fails", async () => {
    const store = new FinanceStore(async () => { throw new Error("disk full"); });
    await expect(store.load(v1)).rejects.toThrow("disk full");
    expect(store.snapshot().accounts).toEqual([]);
    expect(store.snapshot().schemaVersion).toBe(3);
  });
});
