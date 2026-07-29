import { describe, expect, it } from "vitest";
import { categoryLabel, categoryOptionEntries, parentCategoryOptionEntries } from "@/domain/categories";
import { FinanceStore } from "@/store/finance-store";
import { DEFAULT_DATA } from "@/types";
import type { Account, Category, FinanceData, MonthlyBudget, RecurringRule, SimpleTransaction } from "@/types";

const timestamp = "2026-07-01T00:00:00.000Z";

function category(id: string, name: string, overrides: Partial<Category> = {}): Category {
  return { id, name, type: "expense", archived: false, createdAt: timestamp, updatedAt: timestamp, ...overrides };
}

async function emptyStore(): Promise<FinanceStore> {
  const store = new FinanceStore(async () => undefined);
  await store.load(null);
  return store;
}

const account: Account = {
  id: "bank", name: "Bank", kind: "bank", currency: "USD", openingBalanceMinor: 0,
  archived: false, createdAt: timestamp, updatedAt: timestamp
};

describe("category selection", () => {
  const categories = [
    category("rent", "Rent", { parentCategoryId: "housing" }),
    category("salary", "Salary", { type: "income" }),
    category("snacks", "Snacks", { parentCategoryId: "food", archived: true }),
    category("housing", "Housing"),
    category("produce", "Produce", { parentCategoryId: "food" }),
    category("old", "Old root", { archived: true }),
    category("food", "Food")
  ];

  it("orders roots alphabetically with their alphabetized children immediately below", () => {
    expect(categoryOptionEntries(categories, "expense")).toEqual([
      ["food", "Food"],
      ["produce", "Food › Produce"],
      ["housing", "Housing"],
      ["rent", "Housing › Rent"]
    ]);
  });

  it("excludes archived choices but preserves and marks an archived current selection", () => {
    expect(categoryOptionEntries(categories, "expense", "snacks")).toEqual([
      ["food", "Food"],
      ["produce", "Food › Produce"],
      ["housing", "Housing"],
      ["rent", "Housing › Rent"],
      ["snacks", "Food › Snacks — archived"]
    ]);
    expect(categoryLabel(categories, "snacks")).toBe("Food › Snacks — archived");
  });

  it("offers only active same-type roots as parents and can retain an archived current parent", () => {
    expect(parentCategoryOptionEntries(categories, "expense", "produce")).toEqual([
      ["food", "Food"],
      ["housing", "Housing"]
    ]);
    expect(parentCategoryOptionEntries(categories, "expense", "produce", "old")).toEqual([
      ["food", "Food"],
      ["housing", "Housing"],
      ["old", "Old root — archived (current)"]
    ]);
  });
});

describe("category hierarchy integrity", () => {
  it("rejects non-string category identities while loading persisted data", async () => {
    const invalid = { ...DEFAULT_DATA, categories: [{ ...category("root", "Root"), id: 42 }] };
    await expect(new FinanceStore(async () => undefined).load(invalid)).rejects.toThrow("Category name is required");
  });

  it("rejects self-links, missing parents, cross-type parents, grandchildren, and cycles", async () => {
    const store = await emptyStore();
    await store.upsertCategory(category("root", "Root"));
    await store.upsertCategory(category("income", "Income", { type: "income" }));
    await store.upsertCategory(category("child", "Child", { parentCategoryId: "root" }));

    await expect(store.upsertCategory(category("self", "Self", { parentCategoryId: "self" }))).rejects.toThrow("own parent");
    await expect(store.upsertCategory(category("missing", "Missing", { parentCategoryId: "absent" }))).rejects.toThrow("not found");
    await expect(store.upsertCategory(category("cross", "Cross", { parentCategoryId: "income" }))).rejects.toThrow("types must match");
    await expect(store.upsertCategory(category("grandchild", "Grandchild", { parentCategoryId: "child" }))).rejects.toThrow("one subcategory level");

    const cyclic: FinanceData = {
      ...DEFAULT_DATA,
      categories: [category("a", "A", { parentCategoryId: "b" }), category("b", "B", { parentCategoryId: "a" })]
    };
    await expect(new FinanceStore(async () => undefined).load(cyclic)).rejects.toThrow("one subcategory level");
  });

  it("blocks active children under archived parents and parent-to-child or incompatible type edits", async () => {
    const store = await emptyStore();
    await store.upsertCategory(category("parent", "Parent"));
    await store.upsertCategory(category("child", "Child", { parentCategoryId: "parent" }));
    await store.upsertCategory(category("other", "Other"));
    await store.upsertCategory(category("archived", "Archived", { archived: true }));

    await expect(store.upsertCategory(category("active-under-archived", "Invalid", { parentCategoryId: "archived" }))).rejects.toThrow("archived parent");
    await store.upsertCategory(category("archived-child", "Historical", { parentCategoryId: "archived", archived: true }));
    await expect(store.upsertCategory(category("parent", "Parent", { parentCategoryId: "other" }))).rejects.toThrow("one subcategory level");
    await expect(store.upsertCategory(category("parent", "Parent", { type: "income" }))).rejects.toThrow("types must match");
  });

  it("enforces case-insensitive sibling uniqueness without a global name restriction", async () => {
    const store = await emptyStore();
    await store.upsertCategory(category("food", "Food"));
    await store.upsertCategory(category("home", "Home"));
    await store.upsertCategory(category("food-misc", "Misc", { parentCategoryId: "food" }));
    await expect(store.upsertCategory(category("food-misc-2", "mIsC", { parentCategoryId: "food" }))).rejects.toThrow("sibling category");
    await store.upsertCategory(category("home-misc", "MISC", { parentCategoryId: "home" }));
    expect(store.snapshot().categories.map((item) => item.id)).toContain("home-misc");
  });

  it("blocks parent archiving without changing descendants or scheduled items", async () => {
    const store = await emptyStore();
    await store.upsertAccount(account);
    await store.upsertCategory(category("parent", "Parent"));
    await store.upsertCategory(category("child", "Child", { parentCategoryId: "parent" }));
    const rule: RecurringRule = {
      id: "parent-rule", kind: "bill", type: "expense", frequency: "monthly", interval: 1,
      accountId: account.id, amountMinor: 10_00, currency: "USD", categoryId: "parent", description: "Parent bill",
      anchorDueDate: "2026-07-01", nextDueDate: "2026-07-01", reminderLeadDays: 0,
      calendar: "gregorian", active: true, createdAt: timestamp, updatedAt: timestamp
    };
    await store.upsertRecurringRule(rule);

    await expect(store.archiveCategory("parent")).rejects.toThrow("active subcategories");
    const data = store.snapshot();
    expect(data.categories.find((item) => item.id === "parent")?.archived).toBe(false);
    expect(data.categories.find((item) => item.id === "child")?.parentCategoryId).toBe("parent");
    expect(data.recurringRules[0]?.active).toBe(true);
  });

  it("pauses only directly related schedules and reloads archived historical hierarchy losslessly", async () => {
    let persisted: FinanceData | undefined;
    const store = new FinanceStore(async (data) => { persisted = data; });
    await store.load(null);
    await store.upsertAccount(account);
    await store.upsertCategory(category("parent", "Parent"));
    await store.upsertCategory(category("child", "Child", { parentCategoryId: "parent" }));
    const budget: MonthlyBudget = {
      id: "child-budget", categoryId: "child", currency: "USD", calendar: "gregorian", month: "2026-07",
      amountMinor: 20_00, createdAt: timestamp, updatedAt: timestamp
    };
    await store.upsertBudget(budget);
    const rule: RecurringRule = {
      id: "child-rule", kind: "bill", type: "expense", frequency: "monthly", interval: 1,
      accountId: account.id, amountMinor: 10_00, currency: "USD", categoryId: "child", description: "Child bill",
      anchorDueDate: "2026-07-01", nextDueDate: "2026-07-01", reminderLeadDays: 0,
      calendar: "gregorian", active: true, createdAt: timestamp, updatedAt: timestamp
    };
    await store.upsertRecurringRule(rule);
    const transaction: SimpleTransaction = {
      id: "child-transaction", type: "expense", accountId: account.id, amountMinor: 10_00, currency: "USD", categoryId: "child",
      date: "2026-07-01", createdAt: timestamp, updatedAt: timestamp
    };
    await store.resolveRecurringOccurrence(rule.id, rule.nextDueDate, "recorded", transaction);
    await store.archiveCategory("child");
    expect(store.snapshot().recurringRules[0]?.active).toBe(false);
    await store.archiveCategory("parent");

    const snapshot = store.snapshot();
    expect(persisted).toEqual(snapshot);
    const saveOnReload = async (): Promise<void> => { throw new Error("schema v4 reload must not save"); };
    const reloaded = new FinanceStore(saveOnReload);
    await reloaded.load(snapshot);
    expect(reloaded.snapshot()).toEqual(snapshot);
    expect(categoryLabel(reloaded.snapshot().categories, "child")).toBe("Parent › Child — archived");
    expect(reloaded.snapshot().transactions[0]).toEqual(transaction);
    expect(reloaded.snapshot().budgets[0]).toEqual(budget);
    expect(reloaded.snapshot().recurringResolutions[0]?.transactionId).toBe(transaction.id);
  });
});
