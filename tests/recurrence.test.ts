import { describe, expect, it, vi } from "vitest";
import { addCalendarPeriod } from "@/domain/calendar";
import {
  actionableOccurrences,
  isRecurringRuleCompleted,
  nextOccurrenceDate,
  recurringTransactionForOccurrence,
  validateRecurringRule
} from "@/domain/recurrence";
import { FinanceStore } from "@/store/finance-store";
import type { Account, Category, FinanceData, RecurringRule } from "@/types";

const timestamp = "2026-07-01T00:00:00.000Z";
const account: Account = { id: "bank", name: "Bank", kind: "bank", currency: "USD", openingBalanceMinor: 0, archived: false, createdAt: timestamp, updatedAt: timestamp };
const category: Category = { id: "rent", name: "Rent", type: "expense", archived: false, createdAt: timestamp, updatedAt: timestamp };
const rule: RecurringRule = {
  id: "rule", kind: "bill", type: "expense", frequency: "monthly", interval: 1, accountId: "bank",
  amountMinor: 100_000, currency: "USD", categoryId: "rent", description: "Rent",
  anchorDueDate: "2026-07-31", nextDueDate: "2026-07-31", reminderLeadDays: 0,
  calendar: "gregorian", active: true, createdAt: timestamp, updatedAt: timestamp
};

async function preparedStore(save = vi.fn(async (_data: FinanceData) => undefined)): Promise<{ store: FinanceStore; save: typeof save }> {
  const store = new FinanceStore(save);
  await store.load(null);
  await store.upsertAccount(account);
  await store.upsertCategory(category);
  await store.upsertRecurringRule(rule);
  save.mockClear();
  return { store, save };
}

describe("scheduled item cadence", () => {
  it("supports positive multi-period intervals without losing the calendar anchor", () => {
    expect(addCalendarPeriod("2026-03-19", "weekly", 1, "persian")).toBe("2026-03-26");
    expect(nextOccurrenceDate({ ...rule, interval: 2 }, "2026-07-31")).toBe("2026-09-30");
    expect(nextOccurrenceDate({ ...rule, anchorDueDate: "2026-01-31", interval: 2 }, "2026-03-31")).toBe("2026-05-31");
    expect(nextOccurrenceDate({ ...rule, anchorDueDate: "2024-02-29", frequency: "yearly", interval: 2 }, "2024-02-29")).toBe("2026-02-28");
  });

  it("rejects invalid interval, limit, lead, and kind/type combinations", () => {
    expect(() => validateRecurringRule({ ...rule, interval: 0 }, [account], [category])).toThrow("positive safe integer");
    expect(() => validateRecurringRule({ ...rule, occurrenceLimit: 0 }, [account], [category])).toThrow("positive safe integer");
    expect(() => validateRecurringRule({ ...rule, reminderLeadDays: -1 }, [account], [category])).toThrow("nonnegative");
    expect(() => validateRecurringRule({ ...rule, kind: "recurring-income" }, [account], [category])).toThrow("income transaction type");
  });

  it("returns only each active item's next actionable occurrence and respects lead days", () => {
    const fiveDaysAway = { ...rule, nextDueDate: "2026-07-06", anchorDueDate: "2026-07-06", reminderLeadDays: 5 };
    expect(actionableOccurrences([fiveDaysAway], [], "2026-07-01")).toEqual([{ ruleId: "rule", date: "2026-07-06", due: false }]);
    expect(actionableOccurrences([{ ...fiveDaysAway, reminderLeadDays: 4 }], [], "2026-07-01")).toEqual([]);
    expect(actionableOccurrences([{ ...rule, nextDueDate: "2026-06-30" }], [], "2026-07-01")).toEqual([{ ruleId: "rule", date: "2026-06-30", due: true }]);
  });

  it("treats an end date as inclusive and enforces completed occurrence limits", async () => {
    const { store } = await preparedStore();
    await store.upsertRecurringRule({ ...rule, endDate: "2026-07-31", occurrenceLimit: 1 });
    let data = store.snapshot();
    expect(actionableOccurrences(data.recurringRules, data.recurringResolutions, "2026-07-31")).toHaveLength(1);
    await store.resolveRecurringOccurrence(rule.id, rule.nextDueDate, "skipped");
    data = store.snapshot();
    expect(isRecurringRuleCompleted(data.recurringRules[0]!, data.recurringResolutions)).toBe(true);
    expect(actionableOccurrences(data.recurringRules, data.recurringResolutions, "2026-08-31")).toEqual([]);
  });

  it("preserves a January anchor for non-schedule edits and resets it for schedule edits", async () => {
    const { store } = await preparedStore();
    await store.upsertRecurringRule({ ...rule, nextDueDate: "2026-01-31" });
    await store.resolveRecurringOccurrence(rule.id, "2026-01-31", "skipped");
    const february = store.snapshot().recurringRules[0]!;
    await store.upsertRecurringRule({ ...february, description: "Edited description", anchorDueDate: february.nextDueDate });
    expect(store.snapshot().recurringRules[0]).toMatchObject({ anchorDueDate: "2026-01-31", nextDueDate: "2026-02-28" });
    await store.resolveRecurringOccurrence(rule.id, "2026-02-28", "skipped");
    expect(store.snapshot().recurringRules[0]?.nextDueDate).toBe("2026-03-31");
    await store.upsertRecurringRule({ ...store.snapshot().recurringRules[0]!, nextDueDate: "2026-04-15" });
    expect(store.snapshot().recurringRules[0]).toMatchObject({ anchorDueDate: "2026-04-15", nextDueDate: "2026-04-15" });
    await store.resolveRecurringOccurrence(rule.id, "2026-04-15", "skipped");
    expect(store.snapshot().recurringRules[0]?.nextDueDate).toBe("2026-05-15");
  });
});

describe("scheduled item resolution", () => {
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
  });

  it("skips with no transaction and cannot resolve the occurrence twice", async () => {
    const { store } = await preparedStore();
    await store.resolveRecurringOccurrence(rule.id, rule.nextDueDate, "skipped");
    expect(store.snapshot().transactions).toEqual([]);
    expect(store.snapshot().recurringResolutions[0]?.action).toBe("skipped");
    await expect(store.resolveRecurringOccurrence(rule.id, rule.nextDueDate, "skipped")).rejects.toThrow("no longer current");
  });

  it("logs repeated reschedules, resets cadence, and prevents reused resolution keys", async () => {
    const { store } = await preparedStore();
    await store.rescheduleRecurringOccurrence(rule.id, "2026-07-31", "2026-08-10");
    expect(store.snapshot().recurringRules[0]).toMatchObject({ anchorDueDate: "2026-08-10", nextDueDate: "2026-08-10" });
    expect(store.snapshot().recurringResolutions[0]).toMatchObject({ action: "rescheduled", occurrenceDate: "2026-07-31", rescheduledToDate: "2026-08-10" });
    expect(store.snapshot().transactions).toEqual([]);
    await store.rescheduleRecurringOccurrence(rule.id, "2026-08-10", "2026-08-20");
    await expect(store.rescheduleRecurringOccurrence(rule.id, "2026-08-20", "2026-08-10")).rejects.toThrow("already been resolved or rescheduled");
    expect(store.snapshot().recurringResolutions).toHaveLength(2);
  });

  it.each(["recorded", "skipped", "rescheduled"] as const)("rolls back a failed %s persistence and keeps the queue usable", async (action) => {
    const { store, save } = await preparedStore();
    save.mockRejectedValueOnce(new Error("disk full"));
    const before = store.snapshot();
    const operation = action === "recorded"
      ? store.resolveRecurringOccurrence(rule.id, rule.nextDueDate, action, recurringTransactionForOccurrence(rule, rule.nextDueDate, "transaction", timestamp))
      : action === "skipped"
        ? store.resolveRecurringOccurrence(rule.id, rule.nextDueDate, action)
        : store.rescheduleRecurringOccurrence(rule.id, rule.nextDueDate, "2026-08-10");
    await expect(operation).rejects.toThrow("disk full");
    expect(store.snapshot()).toEqual(before);
    await store.resolveRecurringOccurrence(rule.id, rule.nextDueDate, "skipped");
    expect(store.snapshot().recurringResolutions).toHaveLength(1);
  });

  it("keeps paused rules loadable after their account is archived", async () => {
    let persisted: unknown;
    const { store } = await preparedStore(vi.fn(async (data: FinanceData) => { persisted = data; }));
    await store.archiveAccount(account.id);
    expect(store.snapshot().recurringRules[0]?.active).toBe(false);
    const reloaded = new FinanceStore(async () => undefined);
    await expect(reloaded.load(persisted)).resolves.toBeUndefined();
  });
});
