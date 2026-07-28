import { isCanonicalDate } from "@/domain/calendar";
import { validateBudget } from "@/domain/budgets";
import { validateAccount, validateTransaction } from "@/domain/finance";
import { normalizeLocale } from "@/domain/money";
import { nextOccurrenceDate, recurringOccurrenceKey, validateRecurringRule } from "@/domain/recurrence";
import { migrateSchema } from "@/store/migrations";
import type {
  Account,
  Category,
  FinanceData,
  FinanceSettings,
  FinanceTransaction,
  MonthlyBudget,
  RecurringResolution,
  RecurringResolutionAction,
  RecurringRule
} from "@/types";
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
  return isTransferTransaction(transaction) ? [transaction.fromAccountId, transaction.toAccountId] : [transaction.accountId];
}

function requireUniqueIds<T extends { id: string }>(items: T[], label: string): void {
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error(`Finance data contains duplicate ${label} IDs.`);
}

export class FinanceStore {
  private data: FinanceData = clone(DEFAULT_DATA);
  private readonly listeners = new Set<() => void>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly saveData: SaveData) {}

  async load(raw: unknown): Promise<void> {
    if (raw === null || raw === undefined) {
      this.data = clone(DEFAULT_DATA);
      return;
    }
    if (!isRecord(raw)) throw new Error("Finance data is not a valid object. Restore data.json from a backup.");
    const sourceVersion = raw.schemaVersion ?? 1;
    if (typeof sourceVersion !== "number" || sourceVersion < 1 || sourceVersion > 2) {
      const versionLabel = typeof sourceVersion === "string" || typeof sourceVersion === "number" ? sourceVersion : "unknown";
      throw new Error(`Finance data uses unsupported schema version ${versionLabel}. Update the plugin before continuing.`);
    }

    const migration = migrateSchema(raw);
    if (!isRecord(migration.data) || migration.data.schemaVersion !== 2) throw new Error("Finance data could not be migrated to schema version 2.");
    const decoded = this.decodeData(migration.data);
    if (migration.migrated) await this.saveData(clone(decoded));
    this.data = decoded;
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
    if (next.calendar !== undefined && next.calendar !== "gregorian" && next.calendar !== "persian") throw new Error("Calendar setting is invalid.");
    await this.mutate((draft) => { draft.settings = { ...draft.settings, ...next }; });
  }

  async upsertAccount(account: Account): Promise<void> {
    await this.mutate((draft) => {
      validateAccount(account);
      const existing = draft.accounts.find((item) => item.id === account.id);
      if (existing && draft.transactions.some((transaction) => transactionAccountIds(transaction).includes(account.id))
        && (existing.currency !== account.currency || existing.kind !== account.kind)) {
        throw new Error("Account type and currency cannot change after transactions have been recorded.");
      }
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
      for (const rule of draft.recurringRules.filter((item) => item.accountId === accountId)) rule.active = false;
    });
  }

  async upsertCategory(category: Category): Promise<void> {
    await this.mutate((draft) => {
      this.validateCategory(category);
      const existing = draft.categories.find((item) => item.id === category.id);
      const used = draft.transactions.some((transaction) => !isTransferTransaction(transaction) && transaction.categoryId === category.id)
        || draft.budgets.some((budget) => budget.categoryId === category.id)
        || draft.recurringRules.some((rule) => rule.categoryId === category.id);
      if (existing && used && existing.type !== category.type) throw new Error("Category type cannot change while it is in use.");
      const duplicate = draft.categories.find((item) => item.id !== category.id && item.type === category.type && item.name.localeCompare(category.name, undefined, { sensitivity: "base" }) === 0);
      if (duplicate) throw new Error("A category with this name and type already exists.");
      const index = draft.categories.findIndex((item) => item.id === category.id);
      if (index >= 0) draft.categories[index] = clone(category);
      else draft.categories.push(clone(category));
    });
  }

  async archiveCategory(categoryId: string): Promise<void> {
    await this.mutate((draft) => {
      const category = draft.categories.find((item) => item.id === categoryId);
      if (!category) return;
      category.archived = true;
      category.updatedAt = new Date().toISOString();
      for (const rule of draft.recurringRules.filter((item) => item.categoryId === categoryId)) rule.active = false;
    });
  }

  async upsertBudget(budget: MonthlyBudget): Promise<void> {
    await this.mutate((draft) => {
      validateBudget(budget, draft.categories);
      const duplicate = draft.budgets.find((item) => item.id !== budget.id && item.categoryId === budget.categoryId
        && item.currency === budget.currency && item.calendar === budget.calendar && item.month === budget.month);
      if (duplicate) throw new Error("A budget already exists for this category, currency, and month.");
      const index = draft.budgets.findIndex((item) => item.id === budget.id);
      if (index >= 0) draft.budgets[index] = clone(budget);
      else draft.budgets.push(clone(budget));
    });
  }

  async deleteBudget(budgetId: string): Promise<void> {
    await this.mutate((draft) => { draft.budgets = draft.budgets.filter((item) => item.id !== budgetId); });
  }

  async upsertRecurringRule(rule: RecurringRule): Promise<void> {
    await this.mutate((draft) => {
      validateRecurringRule(rule, draft.accounts, draft.categories);
      const index = draft.recurringRules.findIndex((item) => item.id === rule.id);
      if (index >= 0) draft.recurringRules[index] = clone(rule);
      else draft.recurringRules.push(clone(rule));
    });
  }

  async setRecurringRuleActive(ruleId: string, active: boolean): Promise<void> {
    await this.mutate((draft) => {
      const rule = draft.recurringRules.find((item) => item.id === ruleId);
      if (!rule) return;
      if (active) validateRecurringRule({ ...rule, active }, draft.accounts, draft.categories);
      rule.active = active;
      rule.updatedAt = new Date().toISOString();
    });
  }

  async resolveRecurringOccurrence(
    ruleId: string,
    occurrenceDate: string,
    action: RecurringResolutionAction,
    transaction?: FinanceTransaction
  ): Promise<void> {
    await this.mutate((draft) => {
      const rule = draft.recurringRules.find((item) => item.id === ruleId);
      if (!rule) throw new Error("Recurring rule was not found.");
      if (!isCanonicalDate(occurrenceDate) || occurrenceDate !== rule.nextDueDate) throw new Error("This recurring occurrence is no longer current.");
      if (draft.recurringResolutions.some((item) => recurringOccurrenceKey(item.ruleId, item.occurrenceDate) === recurringOccurrenceKey(ruleId, occurrenceDate))) {
        throw new Error("This recurring occurrence has already been resolved.");
      }
      if (action === "recorded") {
        if (!transaction || isTransferTransaction(transaction)) throw new Error("A transaction is required to record this occurrence.");
        if (transaction.date !== occurrenceDate) throw new Error("Recorded transaction date must match the occurrence date.");
        if (draft.transactions.some((item) => item.id === transaction.id)) throw new Error("Transaction ID already exists.");
        validateTransaction(transaction, draft.accounts, new Set(), draft.categories);
        draft.transactions.push(clone(transaction));
      } else if (transaction !== undefined) {
        throw new Error("Skipped occurrences cannot include a transaction.");
      }
      const resolvedAt = new Date().toISOString();
      draft.recurringResolutions.push({
        id: `resolution-${ruleId}-${occurrenceDate}`,
        ruleId,
        occurrenceDate,
        action,
        transactionId: action === "recorded" ? transaction?.id : undefined,
        resolvedAt
      });
      rule.nextDueDate = nextOccurrenceDate(rule, occurrenceDate);
      rule.updatedAt = resolvedAt;
    });
  }

  async upsertTransaction(transaction: FinanceTransaction): Promise<void> {
    await this.mutate((draft) => {
      const existing = draft.transactions.find((item) => item.id === transaction.id);
      const allowedArchivedIds = new Set(existing ? transactionAccountIds(existing) : []);
      validateTransaction(transaction, draft.accounts, allowedArchivedIds, draft.categories);
      const index = draft.transactions.findIndex((item) => item.id === transaction.id);
      if (index >= 0) draft.transactions[index] = clone(transaction);
      else draft.transactions.push(clone(transaction));
    });
  }

  async deleteTransaction(transactionId: string): Promise<void> {
    await this.mutate((draft) => { draft.transactions = draft.transactions.filter((item) => item.id !== transactionId); });
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

  private decodeData(raw: Record<string, unknown>): FinanceData {
    const requiredArrays = ["accounts", "categories", "budgets", "recurringRules", "recurringResolutions", "transactions"] as const;
    for (const key of requiredArrays) if (!Array.isArray(raw[key])) throw new Error(`Finance data is missing its ${key} list. Restore data.json from a backup.`);
    const accounts = (raw.accounts as unknown[]).map((value, index) => this.decodeAccount(value, index));
    requireUniqueIds(accounts, "account");
    const categories = (raw.categories as unknown[]).map((value, index) => this.decodeCategory(value, index));
    requireUniqueIds(categories, "category");
    const allowedArchivedIds = new Set(accounts.filter((account) => account.archived).map((account) => account.id));
    const transactions = (raw.transactions as unknown[]).map((value, index) => this.decodeTransaction(value, index, accounts, categories, allowedArchivedIds));
    requireUniqueIds(transactions, "transaction");
    const budgets = (raw.budgets as unknown[]).map((value, index) => this.decodeBudget(value, index, categories));
    requireUniqueIds(budgets, "budget");
    const recurringRules = (raw.recurringRules as unknown[]).map((value, index) => this.decodeRecurringRule(value, index, accounts, categories));
    requireUniqueIds(recurringRules, "recurring rule");
    const recurringResolutions = (raw.recurringResolutions as unknown[]).map((value, index) => this.decodeResolution(value, index, recurringRules, transactions));
    requireUniqueIds(recurringResolutions, "recurring resolution");
    const resolutionKeys = recurringResolutions.map((item) => recurringOccurrenceKey(item.ruleId, item.occurrenceDate));
    if (new Set(resolutionKeys).size !== resolutionKeys.length) throw new Error("Finance data contains duplicate recurring occurrence resolutions.");
    return {
      schemaVersion: 2,
      settings: this.decodeSettings(raw.settings, accounts),
      accounts,
      categories,
      budgets,
      recurringRules,
      recurringResolutions,
      transactions
    };
  }

  private decodeAccount(value: unknown, index: number): Account {
    if (!isRecord(value)) throw new Error(`Account ${index + 1} is invalid.`);
    const account = value as unknown as Account;
    if (typeof account.id !== "string" || !account.id || typeof account.createdAt !== "string" || typeof account.updatedAt !== "string") {
      throw new Error(`Account ${index + 1} has invalid identity metadata.`);
    }
    if (!( ["cash", "bank", "credit-card"] as const).includes(account.kind)) throw new Error(`Account ${index + 1} has an invalid type.`);
    if (typeof account.archived !== "boolean") throw new Error(`Account ${index + 1} has an invalid archive status.`);
    validateAccount(account);
    return clone(account);
  }

  private validateCategory(category: Category): void {
    if (!category.id || !category.name.trim()) throw new Error("Category name is required.");
    if (category.type !== "expense" && category.type !== "income") throw new Error("Category type is invalid.");
    if (typeof category.archived !== "boolean" || typeof category.createdAt !== "string" || typeof category.updatedAt !== "string") {
      throw new Error("Category metadata is invalid.");
    }
  }

  private decodeCategory(value: unknown, index: number): Category {
    if (!isRecord(value)) throw new Error(`Category ${index + 1} is invalid.`);
    const category = value as unknown as Category;
    try { this.validateCategory(category); }
    catch (error) { throw new Error(`Category ${index + 1} is invalid: ${error instanceof Error ? error.message : "invalid category"}`); }
    return clone(category);
  }

  private decodeTransaction(value: unknown, index: number, accounts: Account[], categories: Category[], allowedArchivedIds: ReadonlySet<string>): FinanceTransaction {
    if (!isRecord(value)) throw new Error(`Transaction ${index + 1} is invalid.`);
    const transaction = value as unknown as FinanceTransaction;
    if (typeof transaction.id !== "string" || !transaction.id || typeof transaction.createdAt !== "string" || typeof transaction.updatedAt !== "string") {
      throw new Error(`Transaction ${index + 1} has invalid identity metadata.`);
    }
    if (!( ["expense", "income", "refund", "transfer", "card-payment"] as const).includes(transaction.type)) throw new Error(`Transaction ${index + 1} has an invalid type.`);
    try { validateTransaction(transaction, accounts, allowedArchivedIds, categories); }
    catch (error) { throw new Error(`Transaction ${index + 1} is invalid: ${error instanceof Error ? error.message : "invalid transaction"}`); }
    return clone(transaction);
  }

  private decodeBudget(value: unknown, index: number, categories: Category[]): MonthlyBudget {
    if (!isRecord(value)) throw new Error(`Budget ${index + 1} is invalid.`);
    const budget = value as unknown as MonthlyBudget;
    if (typeof budget.createdAt !== "string" || typeof budget.updatedAt !== "string") throw new Error(`Budget ${index + 1} has invalid timestamps.`);
    try { validateBudget(budget, categories); }
    catch (error) { throw new Error(`Budget ${index + 1} is invalid: ${error instanceof Error ? error.message : "invalid budget"}`); }
    return clone(budget);
  }

  private decodeRecurringRule(value: unknown, index: number, accounts: Account[], categories: Category[]): RecurringRule {
    if (!isRecord(value)) throw new Error(`Recurring rule ${index + 1} is invalid.`);
    const rule = value as unknown as RecurringRule;
    if (typeof rule.createdAt !== "string" || typeof rule.updatedAt !== "string" || typeof rule.active !== "boolean"
      || !( ["weekly", "monthly", "yearly"] as const).includes(rule.frequency)) throw new Error(`Recurring rule ${index + 1} has invalid metadata.`);
    try { validateRecurringRule(rule, accounts, categories); }
    catch (error) { throw new Error(`Recurring rule ${index + 1} is invalid: ${error instanceof Error ? error.message : "invalid rule"}`); }
    return clone(rule);
  }

  private decodeResolution(value: unknown, index: number, rules: RecurringRule[], transactions: FinanceTransaction[]): RecurringResolution {
    if (!isRecord(value)) throw new Error(`Recurring resolution ${index + 1} is invalid.`);
    const resolution = value as unknown as RecurringResolution;
    if (!resolution.id || !rules.some((rule) => rule.id === resolution.ruleId) || !isCanonicalDate(resolution.occurrenceDate)
      || (resolution.action !== "recorded" && resolution.action !== "skipped") || typeof resolution.resolvedAt !== "string") {
      throw new Error(`Recurring resolution ${index + 1} is invalid.`);
    }
    if (resolution.action === "recorded" && (!resolution.transactionId || !transactions.some((item) => item.id === resolution.transactionId))) {
      throw new Error(`Recurring resolution ${index + 1} is missing its transaction.`);
    }
    if (resolution.action === "skipped" && resolution.transactionId !== undefined) throw new Error(`Recurring resolution ${index + 1} cannot reference a transaction.`);
    return clone(resolution);
  }

  private decodeSettings(value: unknown, accounts: Account[]): FinanceSettings {
    const candidate = isRecord(value) ? value : {};
    let locale = DEFAULT_DATA.settings.locale;
    try { if (typeof candidate.locale === "string") locale = normalizeLocale(candidate.locale); }
    catch { locale = DEFAULT_DATA.settings.locale; }
    const weekStartsOn = typeof candidate.weekStartsOn === "number" && Number.isInteger(candidate.weekStartsOn) && candidate.weekStartsOn >= 0 && candidate.weekStartsOn <= 6
      ? candidate.weekStartsOn : DEFAULT_DATA.settings.weekStartsOn;
    const defaultCurrency = typeof candidate.defaultCurrency === "string" && /^[A-Z]{3}$/.test(candidate.defaultCurrency)
      ? candidate.defaultCurrency : DEFAULT_DATA.settings.defaultCurrency;
    const defaultAccountId = typeof candidate.defaultAccountId === "string" && accounts.some((account) => account.id === candidate.defaultAccountId && !account.archived)
      ? candidate.defaultAccountId : undefined;
    const calendar = candidate.calendar === "persian" ? "persian" : "gregorian";
    return { locale, weekStartsOn, defaultCurrency, defaultAccountId, calendar };
  }
}
