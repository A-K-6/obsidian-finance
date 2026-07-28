import { describe, expect, it, vi } from "vitest";
import { addCalendarPeriod } from "@/domain/calendar";
import { recurringTransactionForOccurrence, upcomingOccurrences } from "@/domain/recurrence";
import { FinanceStore } from "@/store/finance-store";
import type { Account, Category, RecurringRule } from "@/types";

const timestamp = "2026-07-01T00:00:00.000Z";
const account: Account = { id: "bank", name: "Bank", kind: "bank", currency: "USD", openingBalanceMinor: 0, archived: false, createdAt: timestamp, updatedAt: timestamp };
const category: Category = { id: "rent", name: "Rent", type: "expense", archived: false, createdAt: timestamp, updatedAt: timestamp };
const rule: RecurringRule = {
  id: "rule", type: "expense", frequency: "monthly", accountId: "bank", amountMinor: 100_000, currency: "USD",
  categoryId: "rent", description: "Rent", anchorDueDate: "2026-07-31", nextDueDate: "2026-07-31",
  calendar: "gregorian", active: true, createdAt: timestamp, updatedAt: timestamp
};

async function preparedStore(save = vi.fn(async () => undefined)): Promise<{ store: FinanceStore; save: typeof save }> {
  const store = new FinanceStore(save);
  await store.load(null);
  await store.upsertAccount(account);
  await store.upsertCategory(category);
  await store.upsertRecurringRule(rule);
  save.mockClear();
  return { store, save };
}

describe("recurring rules", () => {
  it("uses seven absolute days for weekly recurrence in either calendar", () => {
    expect(addCalendarPeriod("2026-03-19", "weekly", 1, "persian")).toBe("2026-03-26");
  });

  it("lists due and upcoming occurrences without posting anything", async () => {
    const { store, save } = await preparedStore();
    const data = store.snapshot();
    expect(upcomingOccurrences(data.recurringRules, data.recurringResolutions, "2026-07-31", "2026-09-30").map((item) => item.date)).toEqual(["2026-07-31", "2026-08-31", "2026-09-30"]);
    expect(data.transactions).toEqual([]);
    expect(save).not.toHaveBeenCalled();
  });

  it("records only after explicit resolution and advances atomically", async () => {
    const { store, save } = await preparedStore();
    const candidate = recurringTransactionForOccurrence(rule, rule.nextDueDate, "transaction", timestamp);
    expect(store.snapshot().transactions).toEqual([]);
    await store.resolveRecurringOccurrence(rule.id, rule.nextDueDate, "recorded", candidate);
    const data = store.snapshot();
    expect(data.transactions).toEqual([candidate]);
    expect(data.recurringResolutions).toHaveLength(1);
    expect(data.recurringRules[0]?.nextDueDate).toBe("2026-08-31");
    expect(save).toHaveBeenCalledOnce();
    await expect(store.resolveRecurringOccurrence(rule.id, rule.nextDueDate, "recorded", { ...candidate, id: "duplicate" })).rejects.toThrow("no longer current");
    expect(store.snapshot().transactions).toHaveLength(1);
  });

  it("skips with no transaction and cannot resolve the occurrence twice", async () => {
    const { store } = await preparedStore();
    await store.resolveRecurringOccurrence(rule.id, rule.nextDueDate, "skipped");
    expect(store.snapshot().transactions).toEqual([]);
    expect(store.snapshot().recurringResolutions[0]?.action).toBe("skipped");
    await expect(store.resolveRecurringOccurrence(rule.id, rule.nextDueDate, "skipped")).rejects.toThrow("no longer current");
  });

  it("keeps paused rules loadable after their account is archived", async () => {
    let persisted: unknown;
    const { store } = await preparedStore(vi.fn(async (data) => { persisted = data; }));
    await store.archiveAccount(account.id);
    expect(store.snapshot().recurringRules[0]?.active).toBe(false);
    const reloaded = new FinanceStore(async () => undefined);
    await expect(reloaded.load(persisted)).resolves.toBeUndefined();
  });
});
