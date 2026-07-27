import { validateAccount, validateTransaction } from "@/domain/finance";
import { normalizeLocale } from "@/domain/money";
import type { Account, FinanceData, FinanceSettings, FinanceTransaction } from "@/types";
import { DEFAULT_DATA, isTransferTransaction } from "@/types";

export type SaveData = (data: FinanceData) => Promise<void>;

type DataMutation = (draft: FinanceData) => void;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function transactionAccountIds(transaction: FinanceTransaction): string[] {
  return isTransferTransaction(transaction)
    ? [transaction.fromAccountId, transaction.toAccountId]
    : [transaction.accountId];
}

export class FinanceStore {
  private data: FinanceData = clone(DEFAULT_DATA);
  private readonly listeners = new Set<() => void>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly saveData: SaveData) {}

  load(raw: unknown): void {
    if (raw === null || raw === undefined) {
      this.data = clone(DEFAULT_DATA);
      return;
    }
    if (!isRecord(raw)) throw new Error("Finance data is not a valid object. Restore data.json from a backup.");
    const schemaVersion = raw.schemaVersion ?? 1;
    if (schemaVersion !== 1) {
      throw new Error(`Finance data uses unsupported schema version ${String(schemaVersion)}. Update the plugin before continuing.`);
    }
    if (!Array.isArray(raw.accounts) || !Array.isArray(raw.transactions)) {
      throw new Error("Finance data is missing its accounts or transactions list. Restore data.json from a backup.");
    }

    const accounts = raw.accounts.map((value, index) => this.decodeAccount(value, index));
    if (new Set(accounts.map((account) => account.id)).size !== accounts.length) throw new Error("Finance data contains duplicate account IDs.");
    const allowedArchivedIds = new Set(accounts.filter((account) => account.archived).map((account) => account.id));
    const transactions = raw.transactions.map((value, index) => this.decodeTransaction(value, index, accounts, allowedArchivedIds));
    if (new Set(transactions.map((transaction) => transaction.id)).size !== transactions.length) throw new Error("Finance data contains duplicate transaction IDs.");

    const settings = this.decodeSettings(raw.settings, accounts);
    this.data = { schemaVersion: 1, settings, accounts, transactions };
  }

  snapshot(): FinanceData {
    return clone(this.data);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async updateSettings(settings: Partial<FinanceSettings>): Promise<void> {
    const next = { ...settings };
    if (next.locale !== undefined) next.locale = normalizeLocale(next.locale);
    if (next.weekStartsOn !== undefined && (!Number.isInteger(next.weekStartsOn) || next.weekStartsOn < 0 || next.weekStartsOn > 6)) {
      throw new Error("First day of week is invalid.");
    }
    await this.mutate((draft) => { draft.settings = { ...draft.settings, ...next }; });
  }

  async upsertAccount(account: Account): Promise<void> {
    validateAccount(account);
    const existing = this.data.accounts.find((item) => item.id === account.id);
    if (existing && this.data.transactions.some((transaction) => transactionAccountIds(transaction).includes(account.id))) {
      if (existing.currency !== account.currency || existing.kind !== account.kind) {
        throw new Error("Account type and currency cannot change after transactions have been recorded.");
      }
    }
    await this.mutate((draft) => {
      const index = draft.accounts.findIndex((item) => item.id === account.id);
      if (index >= 0) draft.accounts[index] = clone(account);
      else draft.accounts.push(clone(account));
    });
  }

  async archiveAccount(accountId: string): Promise<void> {
    await this.mutate((draft) => {
      const account = draft.accounts.find((item) => item.id === accountId);
      if (!account) return;
      account.archived = true;
      account.updatedAt = new Date().toISOString();
      if (draft.settings.defaultAccountId === accountId) draft.settings.defaultAccountId = undefined;
    });
  }

  async upsertTransaction(transaction: FinanceTransaction): Promise<void> {
    const existing = this.data.transactions.find((item) => item.id === transaction.id);
    const allowedArchivedIds = new Set(existing ? transactionAccountIds(existing) : []);
    validateTransaction(transaction, this.data.accounts, allowedArchivedIds);
    await this.mutate((draft) => {
      const index = draft.transactions.findIndex((item) => item.id === transaction.id);
      if (index >= 0) draft.transactions[index] = clone(transaction);
      else draft.transactions.push(clone(transaction));
    });
  }

  async deleteTransaction(transactionId: string): Promise<void> {
    await this.mutate((draft) => {
      draft.transactions = draft.transactions.filter((item) => item.id !== transactionId);
    });
  }

  private mutate(mutation: DataMutation): Promise<void> {
    const operation = this.mutationQueue.catch(() => undefined).then(async () => {
      const draft = this.snapshot();
      mutation(draft);
      await this.saveData(clone(draft));
      this.data = draft;
      for (const listener of this.listeners) listener();
    });
    this.mutationQueue = operation;
    return operation;
  }

  private decodeAccount(value: unknown, index: number): Account {
    if (!isRecord(value)) throw new Error(`Account ${index + 1} is invalid.`);
    const account = value as unknown as Account;
    if (typeof account.id !== "string" || !account.id || typeof account.createdAt !== "string" || typeof account.updatedAt !== "string") {
      throw new Error(`Account ${index + 1} has invalid identity metadata.`);
    }
    if (!(["cash", "bank", "credit-card"] as const).includes(account.kind)) throw new Error(`Account ${index + 1} has an invalid type.`);
    if (typeof account.archived !== "boolean") throw new Error(`Account ${index + 1} has an invalid archive status.`);
    validateAccount(account);
    return clone(account);
  }

  private decodeTransaction(value: unknown, index: number, accounts: Account[], allowedArchivedIds: ReadonlySet<string>): FinanceTransaction {
    if (!isRecord(value)) throw new Error(`Transaction ${index + 1} is invalid.`);
    const transaction = value as unknown as FinanceTransaction;
    if (typeof transaction.id !== "string" || !transaction.id || typeof transaction.createdAt !== "string" || typeof transaction.updatedAt !== "string") {
      throw new Error(`Transaction ${index + 1} has invalid identity metadata.`);
    }
    if (!(["expense", "income", "refund", "transfer", "card-payment"] as const).includes(transaction.type)) {
      throw new Error(`Transaction ${index + 1} has an invalid type.`);
    }
    try {
      validateTransaction(transaction, accounts, allowedArchivedIds);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid transaction";
      throw new Error(`Transaction ${index + 1} is invalid: ${message}`);
    }
    return clone(transaction);
  }

  private decodeSettings(value: unknown, accounts: Account[]): FinanceSettings {
    const candidate = isRecord(value) ? value : {};
    let locale = DEFAULT_DATA.settings.locale;
    try {
      if (typeof candidate.locale === "string") locale = normalizeLocale(candidate.locale);
    } catch {
      locale = DEFAULT_DATA.settings.locale;
    }
    const weekStartsOn = typeof candidate.weekStartsOn === "number" && Number.isInteger(candidate.weekStartsOn) && candidate.weekStartsOn >= 0 && candidate.weekStartsOn <= 6
      ? candidate.weekStartsOn
      : DEFAULT_DATA.settings.weekStartsOn;
    const defaultCurrency = typeof candidate.defaultCurrency === "string" && /^[A-Z]{3}$/.test(candidate.defaultCurrency)
      ? candidate.defaultCurrency
      : DEFAULT_DATA.settings.defaultCurrency;
    const defaultAccountId = typeof candidate.defaultAccountId === "string" && accounts.some((account) => account.id === candidate.defaultAccountId && !account.archived)
      ? candidate.defaultAccountId
      : undefined;
    return { locale, weekStartsOn, defaultCurrency, defaultAccountId };
  }
}
