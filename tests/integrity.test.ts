import { describe, expect, it } from "vitest";
import { cardPaymentReminders } from "@/domain/credit-cards";
import { FinanceStore } from "@/store/finance-store";
import type { Account, Category, RecurringRule, SimpleTransaction } from "@/types";

const timestamp = "2026-07-01T00:00:00.000Z";
const account: Account = {
  id: "bank", name: "Bank", kind: "bank", currency: "USD", openingBalanceMinor: 0,
  archived: false, createdAt: timestamp, updatedAt: timestamp
};
const category: Category = {
  id: "rent", name: "Rent", type: "expense", archived: false, createdAt: timestamp, updatedAt: timestamp
};
const rule: RecurringRule = {
  id: "monthly-rent", type: "expense", frequency: "monthly", accountId: "bank", amountMinor: 100_00,
  currency: "USD", categoryId: "rent", description: "Rent", anchorDueDate: "2026-07-01", nextDueDate: "2026-07-01",
  calendar: "gregorian", active: true, createdAt: timestamp, updatedAt: timestamp
};
const transaction: SimpleTransaction = {
  id: "rent-july", type: "expense", accountId: "bank", amountMinor: 100_00, currency: "USD", categoryId: "rent",
  date: "2026-07-01", createdAt: timestamp, updatedAt: timestamp
};

async function populatedStore(): Promise<FinanceStore> {
  const store = new FinanceStore(async () => undefined);
  await store.load(null);
  await store.upsertAccount(account);
  await store.upsertCategory(category);
  await store.upsertRecurringRule(rule);
  return store;
}

describe("recurring data integrity", () => {
  it("locks account currency while a recurring rule references it", async () => {
    const store = await populatedStore();
    await expect(store.upsertAccount({ ...account, currency: "EUR" })).rejects.toThrow("cannot change");
  });

  it("prevents deletion and incompatible edits of recorded recurring transactions", async () => {
    const store = await populatedStore();
    await store.resolveRecurringOccurrence(rule.id, rule.nextDueDate, "recorded", transaction);
    await expect(store.deleteTransaction(transaction.id)).rejects.toThrow("cannot be deleted");
    await expect(store.upsertTransaction({ ...transaction, date: "2026-07-02" })).rejects.toThrow("cannot be changed");
  });

  it("does not reactivate a rule with an archived category", async () => {
    const store = await populatedStore();
    await store.setRecurringRuleActive(rule.id, false);
    await store.archiveCategory(category.id);
    await expect(store.setRecurringRuleActive(rule.id, true)).rejects.toThrow("archived category");
  });
});

describe("credit-card reminder integrity", () => {
  it("keeps an unpaid statement overdue across calendar months", () => {
    const card: Account = {
      ...account, id: "card", name: "Card", kind: "credit-card", creditLimitMinor: 1000_00,
      statementBalanceMinor: 200_00, minimumPaymentMinor: 20_00, paymentDueDay: 15, statementDueDate: "2026-07-15"
    };
    const reminders = cardPaymentReminders([card], "2026-08-01", "2026-09-01", "gregorian");
    expect(reminders).toEqual([{ accountId: "card", dueDate: "2026-07-15", amountMinor: 20_00, status: "overdue" }]);
  });
});
