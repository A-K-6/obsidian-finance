import { describe, expect, it, vi } from "vitest";
import { FinanceStore } from "@/store/finance-store";
import type { Account } from "@/types";

const account: Account = {
  id: "cash", name: "Cash", kind: "cash", currency: "USD", openingBalanceMinor: 0,
  archived: false, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z"
};

describe("FinanceStore", () => {
  it("loads defaults from missing data and persists account changes", async () => {
    const save = vi.fn(async () => undefined);
    const store = new FinanceStore(save);
    await store.load(null);
    await store.upsertAccount(account);
    expect(store.snapshot().accounts).toEqual([account]);
    expect(save).toHaveBeenCalledOnce();
  });

  it("notifies subscribers after persistence", async () => {
    const store = new FinanceStore(async () => undefined);
    await store.load(null);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    await store.updateSettings({ locale: "de-DE" });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    await store.updateSettings({ locale: "en-US" });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("recovers after a failed persistence attempt without committing failed data", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const store = new FinanceStore(save);
    await store.load(null);
    await expect(store.updateSettings({ locale: "de-DE" })).rejects.toThrow("disk full");
    expect(store.snapshot().settings.locale).toBe("en-US");
    await store.updateSettings({ locale: "fr-FR" });
    expect(store.snapshot().settings.locale).toBe("fr-FR");
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("prevents changing account currency after transactions exist", async () => {
    const store = new FinanceStore(async () => undefined);
    await store.load(null);
    await store.upsertAccount(account);
    await store.upsertTransaction({
      id: "expense", type: "expense", accountId: "cash", amountMinor: 100, currency: "USD", date: "2026-07-01",
      createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z"
    });
    await expect(store.upsertAccount({ ...account, currency: "EUR" })).rejects.toThrow("cannot change");
  });

  it("rejects unsupported future schemas without overwriting them", async () => {
    const save = vi.fn(async () => undefined);
    const store = new FinanceStore(save);
    await expect(store.load({ schemaVersion: 3, settings: {}, accounts: [], transactions: [] })).rejects.toThrow("unsupported schema version");
    expect(save).not.toHaveBeenCalled();
  });
});
