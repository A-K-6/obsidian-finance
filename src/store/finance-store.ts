import { isCanonicalDate } from "@/domain/calendar";
import { validateBudget } from "@/domain/budgets";
import { validateAccount, validateTransaction } from "@/domain/finance";
import { normalizeLocale } from "@/domain/money";
import { isRecurringRuleCompleted, nextOccurrenceDate, recurringOccurrenceKey, validateRecurringRule } from "@/domain/recurrence";
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
    if (typeof sourceVersion !== "number" || sourceVersion < 1 || sourceVersion > 4) {
      const versionLabel = typeof sourceVersion === "string" || typeof sourceVersion === "number" ? sourceVersion : "unknown";
      throw new Error(`Finance data uses unsupported schema version ${versionLabel}. Update the plugin before continuing.`);
    }

    const migration = migrateSchema(raw);
    if (!isRecord(migration.data) || migration.data.schemaVersion !== 4) throw new Error("Finance data could not be migrated to schema version 4.");
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
      if (account.statementDueDate !== undefined && !isCanonicalDate(account.statementDueDate)) throw new Error("Statement due date is invalid.");
      if ((account.statementBalanceMinor ?? 0) > 0 && account.statementDueDate === undefined) {
        throw new Error("A statement due date is required when a statement balance is set.");
      }
      const existing = draft.accounts.find((item) => item.id === account.id);
      const hasDependents = draft.transactions.some((transaction) => transactionAccountIds(transaction).includes(account.id))
        || draft.recurringRules.some((rule) => rule.accountId === account.id);
      if (existing && hasDependents && (existing.currency !== account.currency || existing.kind !== account.kind)) {
        throw new Error("Account type and currency cannot change after transactions or recurring items have been recorded.");
      }
      if (existing && existing.currency !== account.currency
        && (account.openingBalanceMinor !== 0 || account.creditLimitMinor !== undefined
          || account.statementBalanceMinor !== undefined || account.minimumPaymentMinor !== undefined)) {
        throw new Error("Reset the opening balance, credit limit, statement balance, and minimum payment before changing currency.");
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
      const proposed = draft.categories.filter((item) => item.id !== category.id);
      proposed.push(clone(category));
      this.validateCategoryHierarchy(proposed);
      const used = draft.transactions.some((transaction) => !isTransferTransaction(transaction) && transaction.categoryId === category.id)
        || draft.budgets.some((budget) => budget.categoryId === category.id)
        || draft.recurringRules.some((rule) => rule.categoryId === category.id);
      if (existing && used && existing.type !== category.type) throw new Error("Category type cannot change while it is in use.");
      const duplicate = draft.categories.find((item) => item.id !== category.id && item.type === category.type
        && item.parentCategoryId === category.parentCategoryId
        && item.name.localeCompare(category.name, undefined, { sensitivity: "base" }) === 0);
      if (duplicate) throw new Error("A sibling category with this name and type already exists.");
      const index = draft.categories.findIndex((item) => item.id === category.id);
      if (index >= 0) draft.categories[index] = clone(category);
      else draft.categories.push(clone(category));
    });
  }

  async archiveCategory(categoryId: string): Promise<void> {
    await this.mutate((draft) => {
      const category = draft.categories.find((item) => item.id === categoryId);
      if (!category) return;
      if (draft.categories.some((item) => item.parentCategoryId === categoryId && !item.archived)) {
        throw new Error("Archive active subcategories before archiving their parent category.");
      }
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
      const existing = draft.recurringRules.find((item) => item.id === rule.id);
      const scheduleChanged = existing !== undefined && (existing.nextDueDate !== rule.nextDueDate
        || existing.frequency !== rule.frequency || existing.interval !== rule.interval || existing.calendar !== rule.calendar);
      const normalized = clone(rule);
      if (existing) {
        normalized.active = existing.active;
        if (scheduleChanged) normalized.anchorDueDate = normalized.nextDueDate;
        else {
          normalized.anchorDueDate = existing.anchorDueDate;
          normalized.nextDueDate = existing.nextDueDate;
        }
      } else {
        normalized.active = true;
        normalized.anchorDueDate = normalized.nextDueDate;
      }
      validateRecurringRule(normalized, draft.accounts, draft.categories);
      const hasRecordedOccurrences = draft.recurringResolutions.some((resolution) => resolution.ruleId === normalized.id && resolution.action === "recorded");
      if (existing && hasRecordedOccurrences
        && (existing.type !== normalized.type || existing.accountId !== normalized.accountId || existing.currency !== normalized.currency)) {
        throw new Error("A scheduled item's type, account, and currency cannot change after an occurrence has been recorded.");
      }
      if (scheduleChanged && draft.recurringResolutions.some((resolution) => recurringOccurrenceKey(resolution.ruleId, resolution.occurrenceDate)
        === recurringOccurrenceKey(normalized.id, normalized.nextDueDate))) {
        throw new Error("That next due date was already used by this scheduled item.");
      }
      const index = draft.recurringRules.findIndex((item) => item.id === normalized.id);
      if (index >= 0) draft.recurringRules[index] = normalized;
      else draft.recurringRules.push(normalized);
    });
  }

  async setRecurringRuleActive(ruleId: string, active: boolean): Promise<void> {
    await this.mutate((draft) => {
      const rule = draft.recurringRules.find((item) => item.id === ruleId);
      if (!rule) return;
      if (active && isRecurringRuleCompleted(rule, draft.recurringResolutions)) {
        throw new Error("This scheduled item is completed. Edit its end date or occurrence limit before resuming it.");
      }
      rule.active = active;
      validateRecurringRule(rule, draft.accounts, draft.categories);
      rule.updatedAt = new Date().toISOString();
    });
  }

  async resolveRecurringOccurrence(
    ruleId: string,
    occurrenceDate: string,
    action: Exclude<RecurringResolutionAction, "rescheduled">,
    transaction?: FinanceTransaction
  ): Promise<void> {
    await this.mutate((draft) => {
      const rule = draft.recurringRules.find((item) => item.id === ruleId);
      if (!rule) throw new Error("Scheduled item was not found.");
      if (!rule.active || isRecurringRuleCompleted(rule, draft.recurringResolutions)) throw new Error("This scheduled item is paused or completed.");
      if (!isCanonicalDate(occurrenceDate) || occurrenceDate !== rule.nextDueDate) throw new Error("This scheduled occurrence is no longer current.");
      const occurrenceKey = recurringOccurrenceKey(ruleId, occurrenceDate);
      if (draft.recurringResolutions.some((item) => recurringOccurrenceKey(item.ruleId, item.occurrenceDate) === occurrenceKey)) {
        throw new Error("This scheduled occurrence has already been resolved.");
      }
      const nextDate = nextOccurrenceDate(rule, occurrenceDate);
      if (draft.recurringResolutions.some((item) => recurringOccurrenceKey(item.ruleId, item.occurrenceDate) === recurringOccurrenceKey(ruleId, nextDate))) {
        throw new Error("The next scheduled date was already used. Edit the schedule before resolving this occurrence.");
      }
      if (action === "recorded") {
        if (!transaction || isTransferTransaction(transaction)) throw new Error("A transaction is required to record this occurrence.");
        if (transaction.date !== occurrenceDate) throw new Error("Recorded transaction date must match the occurrence date.");
        if (draft.transactions.some((item) => item.id === transaction.id)) throw new Error("Transaction ID already exists.");
        if (transaction.type !== rule.type || transaction.accountId !== rule.accountId || transaction.currency !== rule.currency) {
          throw new Error("The recorded transaction type, account, and currency must match the scheduled item.");
        }
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
      rule.nextDueDate = nextDate;
      rule.updatedAt = resolvedAt;
    });
  }

  async rescheduleRecurringOccurrence(ruleId: string, occurrenceDate: string, rescheduledToDate: string): Promise<void> {
    await this.mutate((draft) => {
      const rule = draft.recurringRules.find((item) => item.id === ruleId);
      if (!rule) throw new Error("Scheduled item was not found.");
      if (!rule.active || isRecurringRuleCompleted(rule, draft.recurringResolutions)) throw new Error("This scheduled item is paused or completed.");
      if (!isCanonicalDate(occurrenceDate) || occurrenceDate !== rule.nextDueDate) throw new Error("This scheduled occurrence is no longer current.");
      if (!isCanonicalDate(rescheduledToDate)) throw new Error("Rescheduled date is invalid.");
      if (rescheduledToDate === occurrenceDate) throw new Error("Choose a different date to reschedule this occurrence.");
      const occurrenceKey = recurringOccurrenceKey(ruleId, occurrenceDate);
      const targetKey = recurringOccurrenceKey(ruleId, rescheduledToDate);
      if (draft.recurringResolutions.some((item) => {
        const key = recurringOccurrenceKey(item.ruleId, item.occurrenceDate);
        return key === occurrenceKey || key === targetKey;
      })) throw new Error("This scheduled date has already been resolved or rescheduled.");
      const updated = { ...rule, anchorDueDate: rescheduledToDate, nextDueDate: rescheduledToDate };
      validateRecurringRule(updated, draft.accounts, draft.categories);
      const resolvedAt = new Date().toISOString();
      draft.recurringResolutions.push({
        id: `resolution-${ruleId}-${occurrenceDate}`,
        ruleId,
        occurrenceDate,
        action: "rescheduled",
        rescheduledToDate,
        resolvedAt
      });
      Object.assign(rule, updated, { updatedAt: resolvedAt });
    });
  }

  async upsertTransaction(transaction: FinanceTransaction): Promise<void> {
    await this.mutate((draft) => {
      const existing = draft.transactions.find((item) => item.id === transaction.id);
      const resolution = draft.recurringResolutions.find((item) => item.transactionId === transaction.id);
      if (resolution) {
        const rule = draft.recurringRules.find((item) => item.id === resolution.ruleId);
        if (!rule || isTransferTransaction(transaction) || transaction.date !== resolution.occurrenceDate
          || transaction.type !== rule.type || transaction.accountId !== rule.accountId || transaction.currency !== rule.currency) {
          throw new Error("A recurring transaction's date, type, account, and currency cannot be changed.");
        }
      }
      const allowedArchivedIds = new Set(existing ? transactionAccountIds(existing) : []);
      validateTransaction(transaction, draft.accounts, allowedArchivedIds, draft.categories);
      const index = draft.transactions.findIndex((item) => item.id === transaction.id);
      if (index >= 0) draft.transactions[index] = clone(transaction);
      else draft.transactions.push(clone(transaction));
    });
  }

  async deleteTransaction(transactionId: string): Promise<void> {
    await this.mutate((draft) => {
      if (draft.recurringResolutions.some((resolution) => resolution.transactionId === transactionId)) {
        throw new Error("Recurring transactions cannot be deleted because their occurrence history must be preserved.");
      }
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

  private decodeData(raw: Record<string, unknown>): FinanceData {
    const requiredArrays = ["accounts", "categories", "budgets", "recurringRules", "recurringResolutions", "transactions"] as const;
    for (const key of requiredArrays) if (!Array.isArray(raw[key])) throw new Error(`Finance data is missing its ${key} list. Restore data.json from a backup.`);
    const accounts = (raw.accounts as unknown[]).map((value, index) => this.decodeAccount(value, index));
    requireUniqueIds(accounts, "account");
    const categories = (raw.categories as unknown[]).map((value, index) => this.decodeCategory(value, index));
    requireUniqueIds(categories, "category");
    this.validateCategoryHierarchy(categories);
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
      schemaVersion: 4,
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
    if (account.statementDueDate !== undefined && !isCanonicalDate(account.statementDueDate)) throw new Error(`Account ${index + 1} has an invalid statement due date.`);
    return clone(account);
  }

  private validateCategory(category: Category): void {
    if (typeof category.id !== "string" || !category.id || typeof category.name !== "string" || !category.name.trim()) throw new Error("Category name is required.");
    if (category.type !== "expense" && category.type !== "income") throw new Error("Category type is invalid.");
    if (category.parentCategoryId !== undefined && (typeof category.parentCategoryId !== "string" || !category.parentCategoryId)) {
      throw new Error("Parent category identity is invalid.");
    }
    if (typeof category.archived !== "boolean" || typeof category.createdAt !== "string" || typeof category.updatedAt !== "string") {
      throw new Error("Category metadata is invalid.");
    }
  }

  private validateCategoryHierarchy(categories: Category[]): void {
    for (const category of categories) {
      this.validateCategory(category);
      if (category.parentCategoryId === undefined) continue;
      if (category.parentCategoryId === category.id) throw new Error("A category cannot be its own parent.");
      const parent = categories.find((item) => item.id === category.parentCategoryId);
      if (!parent) throw new Error(`Parent category for ${category.name} was not found.`);
      if (parent.type !== category.type) throw new Error("Parent and subcategory types must match.");
      if (parent.parentCategoryId !== undefined) throw new Error("Category hierarchy supports only one subcategory level.");
      if (!category.archived && parent.archived) throw new Error("An active subcategory cannot use an archived parent category.");
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
      || !( ["weekly", "monthly", "yearly"] as const).includes(rule.frequency)
      || !( ["bill", "subscription", "recurring-income"] as const).includes(rule.kind)) throw new Error(`Scheduled item ${index + 1} has invalid metadata.`);
    try { validateRecurringRule(rule, accounts, categories); }
    catch (error) { throw new Error(`Recurring rule ${index + 1} is invalid: ${error instanceof Error ? error.message : "invalid rule"}`); }
    return clone(rule);
  }

  private decodeResolution(value: unknown, index: number, rules: RecurringRule[], transactions: FinanceTransaction[]): RecurringResolution {
    if (!isRecord(value)) throw new Error(`Scheduled resolution ${index + 1} is invalid.`);
    const resolution = value as unknown as RecurringResolution;
    if (!resolution.id || !rules.some((rule) => rule.id === resolution.ruleId) || !isCanonicalDate(resolution.occurrenceDate)
      || !( ["recorded", "skipped", "rescheduled"] as const).includes(resolution.action) || typeof resolution.resolvedAt !== "string") {
      throw new Error(`Scheduled resolution ${index + 1} is invalid.`);
    }
    if (resolution.action === "recorded" && (!resolution.transactionId || !transactions.some((item) => item.id === resolution.transactionId))) {
      throw new Error(`Scheduled resolution ${index + 1} is missing its transaction.`);
    }
    if (resolution.action !== "recorded" && resolution.transactionId !== undefined) throw new Error(`Scheduled resolution ${index + 1} cannot reference a transaction.`);
    if (resolution.action === "rescheduled" && (!resolution.rescheduledToDate || !isCanonicalDate(resolution.rescheduledToDate))) {
      throw new Error(`Scheduled resolution ${index + 1} is missing its rescheduled date.`);
    }
    if (resolution.action !== "rescheduled" && resolution.rescheduledToDate !== undefined) {
      throw new Error(`Scheduled resolution ${index + 1} cannot include a rescheduled date.`);
    }
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
