import {
  App,
  Editor,
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SuggestModal,
  WorkspaceLeaf,
  setIcon
} from "obsidian";
import { budgetStatuses, safeAddMinor } from "@/domain/budgets";
import {
  addCalendarPeriod,
  calendarMonthKey,
  calendarMonthRange,
  formatCalendarDate,
  parseCalendarDate,
  todayCanonical,
  weekRangeForDate
} from "@/domain/calendar";
import { cardPaymentReminders, creditCardUtilization, nextCardScheduleDate } from "@/domain/credit-cards";
import { accountBalances, netBalancesByCurrency, summarize, transactionLabel } from "@/domain/finance";
import { CURRENCIES, formatMoney, minorToInput, normalizeLocale, parseMoney, parseNonNegativeMoney } from "@/domain/money";
import { recurringTransactionForOccurrence, upcomingOccurrences } from "@/domain/recurrence";
import { FinanceStore } from "@/store/finance-store";
import type {
  Account,
  AccountKind,
  CalendarSystem,
  Category,
  CategoryType,
  FinanceTransaction,
  MonthlyBudget,
  RecurrenceFrequency,
  RecurringRule,
  TransactionType
} from "@/types";
import { categoryTypeForTransaction, isTransferTransaction } from "@/types";

const DASHBOARD_VIEW = "vault-finance-dashboard";
const HISTORY_VIEW = "vault-finance-history";
const PLANNING_VIEW = "vault-finance-planning";
const TRANSACTION_TYPES: TransactionType[] = ["expense", "income", "refund", "transfer", "card-payment"];

function id(): string {
  const bytes = new Uint8Array(16);
  if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function currencyOptions(): Record<string, string> {
  return Object.fromEntries(CURRENCIES.map((currency) => [currency.code, `${currency.code} — ${currency.name}`]));
}

function accountOptions(accounts: Account[], predicate: (account: Account) => boolean = () => true, includeArchivedIds: ReadonlySet<string> = new Set()): Record<string, string> {
  return Object.fromEntries(accounts
    .filter((account) => (!account.archived || includeArchivedIds.has(account.id)) && predicate(account))
    .map((account) => [account.id, `${account.name} (${account.currency})${account.archived ? " — archived" : ""}`]));
}

function categoryOptions(categories: Category[], type: CategoryType, includeArchivedId?: string): Record<string, string> {
  return Object.fromEntries(categories
    .filter((category) => category.type === type && (!category.archived || category.id === includeArchivedId))
    .map((category) => [category.id, `${category.name}${category.archived ? " — archived" : ""}`]));
}

function addIconButton(container: HTMLElement, icon: string, label: string, action: () => void): void {
  const button = container.createEl("button", { cls: "clickable-icon obsidian-finance-icon-button", attr: { "aria-label": label } });
  setIcon(button, icon);
  button.addEventListener("click", action);
}

function transactionReference(transactionId: string): string {
  return `\`\`\`vault-finance\ntransaction: ${transactionId}\n\`\`\``;
}

function amountDescription(value: string, currency: string, locale: string): string {
  if (!value.trim()) return "Thousands are separated with commas while you type.";
  try { return `Preview: ${formatMoney(parseMoney(value, currency), currency, locale)}`; }
  catch { return "Thousands are separated with commas while you type."; }
}

function groupAmountInput(value: string): string {
  const compact = value.replace(/[,_'\s\u00a0\u202f]/g, "");
  if (!/^\d*(?:\.\d*)?$/.test(compact)) return value;
  const [whole = "", fraction] = compact.split(".");
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? groupedWhole : `${groupedWhole}.${fraction}`;
}

function displayDate(canonical: string, calendar: CalendarSystem): string {
  return `${formatCalendarDate(canonical, calendar)} (${calendar === "persian" ? "Persian" : "Gregorian"})`;
}

function categoryName(categories: Category[], categoryId?: string): string {
  return categories.find((category) => category.id === categoryId)?.name ?? "Uncategorized";
}

abstract class FinanceView extends ItemView {
  private unsubscribe?: () => void;

  constructor(leaf: WorkspaceLeaf, protected readonly plugin: VaultFinancePlugin) { super(leaf); }

  async onOpen(): Promise<void> {
    this.unsubscribe = this.plugin.store.subscribe(() => this.render());
    this.render();
  }

  async onClose(): Promise<void> { this.unsubscribe?.(); }
  protected abstract render(): void;
}

class DashboardView extends FinanceView {
  getViewType(): string { return DASHBOARD_VIEW; }
  getDisplayText(): string { return "Finance dashboard"; }
  getIcon(): string { return "circle-dollar-sign"; }

  protected render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("obsidian-finance-view");
    const data = this.plugin.store.snapshot();
    const header = container.createDiv({ cls: "obsidian-finance-header" });
    header.createEl("h2", { text: "Finance dashboard" });
    const actions = header.createDiv({ cls: "obsidian-finance-actions" });
    actions.createEl("button", { text: "Add transaction", cls: "mod-cta" }).addEventListener("click", () => this.plugin.openTransactionModal());
    actions.createEl("button", { text: "Add account" }).addEventListener("click", () => this.plugin.openAccountModal());
    actions.createEl("button", { text: "History" }).addEventListener("click", () => void this.plugin.activateView(HISTORY_VIEW));
    actions.createEl("button", { text: "Planning" }).addEventListener("click", () => void this.plugin.activateView(PLANNING_VIEW));

    if (data.accounts.length === 0) {
      const empty = container.createDiv({ cls: "obsidian-finance-empty" });
      empty.createEl("h3", { text: "Add your first account" });
      empty.createEl("p", { text: "Create a cash, bank, or credit-card account. Sensitive card credentials should never be stored." });
      empty.createEl("button", { text: "Add account", cls: "mod-cta" }).addEventListener("click", () => this.plugin.openAccountModal());
      return;
    }

    const balances = accountBalances(data.accounts, data.transactions);
    const balanceSection = container.createDiv({ cls: "obsidian-finance-section" });
    balanceSection.createEl("h3", { text: "Current balance" });
    balanceSection.createEl("p", { text: "Cash and bank balances minus credit-card balances, kept separate by currency.", cls: "obsidian-finance-muted" });
    const netGrid = balanceSection.createDiv({ cls: "obsidian-finance-grid" });
    for (const [currency, total] of netBalancesByCurrency(data.accounts, data.transactions)) {
      const card = netGrid.createDiv({ cls: "obsidian-finance-card obsidian-finance-total-card" });
      card.createSpan({ text: currency, cls: "obsidian-finance-eyebrow" });
      card.createEl("strong", { text: formatMoney(total, currency, data.settings.locale) });
      card.createEl("small", { text: total < 0 ? "Negative net balance" : "Net across active accounts" });
    }

    const accountSection = container.createDiv({ cls: "obsidian-finance-section" });
    accountSection.createEl("h3", { text: "Accounts" });
    const accountGrid = accountSection.createDiv({ cls: "obsidian-finance-grid" });
    for (const account of data.accounts.filter((item) => !item.archived)) {
      const balance = balances.get(account.id) ?? 0;
      const card = accountGrid.createDiv({ cls: "obsidian-finance-card" });
      card.createSpan({ text: account.kind === "credit-card" ? "Credit card" : account.kind, cls: "obsidian-finance-eyebrow" });
      card.createEl("h4", { text: account.name });
      card.createEl("strong", { text: formatMoney(balance, account.currency, data.settings.locale) });
      card.createEl("small", { text: account.kind === "credit-card" ? "Current amount owed" : "Current balance" });
      if (account.kind === "credit-card" && account.creditLimitMinor !== undefined) {
        const utilization = creditCardUtilization(balance, account.creditLimitMinor) ?? 0;
        card.createEl("small", { text: `Utilization ${(utilization * 100).toFixed(1)}% of ${formatMoney(account.creditLimitMinor, account.currency, data.settings.locale)}` });
      }
    }

    const today = todayCanonical();
    const [weekStart, weekEnd] = weekRangeForDate(today, data.settings.weekStartsOn);
    const month = calendarMonthKey(today, data.settings.calendar);
    const [monthStart, monthEnd] = calendarMonthRange(month, data.settings.calendar);
    const periodGrid = container.createDiv({ cls: "obsidian-finance-grid obsidian-finance-periods" });
    this.renderSummary(periodGrid, "This week", weekStart, weekEnd, summarize(data.transactions, weekStart, weekEnd), data.settings.locale, data.settings.calendar);
    this.renderSummary(periodGrid, "This month", monthStart, monthEnd, summarize(data.transactions, monthStart, monthEnd), data.settings.locale, data.settings.calendar);

    const dueThrough = addCalendarPeriod(today, "weekly", 2);
    const occurrences = upcomingOccurrences(data.recurringRules, data.recurringResolutions, today, dueThrough);
    const cardReminders = cardPaymentReminders(data.accounts, today, dueThrough, data.settings.calendar);
    if (occurrences.length > 0 || cardReminders.length > 0) {
      const planning = container.createDiv({ cls: "obsidian-finance-section" });
      planning.createEl("h3", { text: "Planning reminders" });
      planning.createEl("p", { text: `${occurrences.filter((item) => item.due).length} recurring occurrence(s) due and ${cardReminders.length} card payment reminder(s). Nothing is posted automatically.` });
      planning.createEl("button", { text: "Open planning" }).addEventListener("click", () => void this.plugin.activateView(PLANNING_VIEW));
    }

    const recentSection = container.createDiv({ cls: "obsidian-finance-section" });
    recentSection.createEl("h3", { text: "Recent transactions" });
    const recent = [...data.transactions].sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
    if (recent.length === 0) recentSection.createEl("p", { text: "No transactions yet.", cls: "obsidian-finance-muted" });
    else for (const transaction of recent) this.plugin.renderTransactionRow(recentSection, transaction);
  }

  private renderSummary(container: HTMLElement, title: string, start: string, end: string, summaries: ReturnType<typeof summarize>, locale: string, calendar: CalendarSystem): void {
    const card = container.createDiv({ cls: "obsidian-finance-card" });
    card.createEl("h3", { text: title });
    card.createEl("small", { text: `${formatCalendarDate(start, calendar)} – ${formatCalendarDate(end, calendar)}` });
    if (summaries.size === 0) {
      card.createEl("p", { text: "No activity", cls: "obsidian-finance-muted" });
      return;
    }
    for (const [currency, summary] of summaries) {
      const block = card.createDiv({ cls: "obsidian-finance-summary-currency" });
      block.createEl("strong", { text: currency });
      block.createSpan({ text: `Spent ${formatMoney(safeAddMinor(summary.expenses, -summary.refunds), currency, locale)}` });
      block.createSpan({ text: `Income ${formatMoney(summary.income, currency, locale)}` });
      block.createSpan({ text: `Net ${formatMoney(summary.net, currency, locale)}${summary.net < 0 ? " — negative" : ""}` });
    }
  }
}

class HistoryView extends FinanceView {
  private query = "";
  private typeFilter = "all";

  getViewType(): string { return HISTORY_VIEW; }
  getDisplayText(): string { return "Finance history"; }
  getIcon(): string { return "list"; }

  protected render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("obsidian-finance-view");
    const header = container.createDiv({ cls: "obsidian-finance-header" });
    header.createEl("h2", { text: "Transaction history" });
    header.createEl("button", { text: "Add transaction", cls: "mod-cta" }).addEventListener("click", () => this.plugin.openTransactionModal());
    const filters = container.createDiv({ cls: "obsidian-finance-filters" });
    const search = filters.createEl("input", { type: "search", placeholder: "Search description, category, or note", value: this.query, attr: { "aria-label": "Search transactions" } });
    search.addEventListener("input", () => { this.query = search.value; this.renderRows(container); });
    const select = filters.createEl("select", { attr: { "aria-label": "Filter by transaction type" } });
    select.createEl("option", { text: "All types", value: "all" });
    for (const type of TRANSACTION_TYPES) select.createEl("option", { text: transactionLabel(type), value: type });
    select.value = this.typeFilter;
    select.addEventListener("change", () => { this.typeFilter = select.value; this.renderRows(container); });
    this.renderRows(container);
  }

  private renderRows(container: HTMLElement): void {
    container.querySelector(".obsidian-finance-history-rows")?.remove();
    const rows = container.createDiv({ cls: "obsidian-finance-history-rows obsidian-finance-section" });
    const data = this.plugin.store.snapshot();
    const query = this.query.trim().toLowerCase();
    const transactions = [...data.transactions]
      .filter((transaction) => this.typeFilter === "all" || transaction.type === this.typeFilter)
      .filter((transaction) => !query || [
        transaction.note,
        !isTransferTransaction(transaction) ? transaction.payee : "",
        !isTransferTransaction(transaction) ? categoryName(data.categories, transaction.categoryId) : ""
      ].some((value) => value?.toLowerCase().includes(query)))
      .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt));
    if (transactions.length === 0) rows.createEl("p", { text: "No matching transactions.", cls: "obsidian-finance-muted" });
    else for (const transaction of transactions) this.plugin.renderTransactionRow(rows, transaction);
  }
}

class PlanningView extends FinanceView {
  getViewType(): string { return PLANNING_VIEW; }
  getDisplayText(): string { return "Finance planning"; }
  getIcon(): string { return "calendar-range"; }

  protected render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("obsidian-finance-view");
    const data = this.plugin.store.snapshot();
    const today = todayCanonical();
    const header = container.createDiv({ cls: "obsidian-finance-header" });
    header.createEl("h2", { text: "Planning" });
    header.createEl("p", { text: `Dates use the ${data.settings.calendar === "persian" ? "Persian" : "Gregorian"} calendar. Nothing is posted automatically.`, cls: "obsidian-finance-muted" });

    const budgetsSection = container.createDiv({ cls: "obsidian-finance-section" });
    const budgetsHeader = budgetsSection.createDiv({ cls: "obsidian-finance-header" });
    budgetsHeader.createEl("h3", { text: "Budgets" });
    const budgetActions = budgetsHeader.createDiv({ cls: "obsidian-finance-actions" });
    budgetActions.createEl("button", { text: "Add budget" }).addEventListener("click", () => this.plugin.openBudgetModal());
    budgetActions.createEl("button", { text: "Add category" }).addEventListener("click", () => this.plugin.openCategoryModal());
    const month = calendarMonthKey(today, data.settings.calendar);
    budgetsSection.createEl("p", { text: `Calendar month ${month}. Each currency is calculated separately.`, cls: "obsidian-finance-muted" });
    const statuses = budgetStatuses(data.budgets, data.transactions, data.settings.calendar, month);
    if (statuses.length === 0) budgetsSection.createEl("p", { text: "No budgets for this month." });
    for (const status of statuses) {
      const row = budgetsSection.createDiv({ cls: "obsidian-finance-card" });
      row.createEl("h4", { text: categoryName(data.categories, status.budget.categoryId) });
      row.createEl("p", { text: `Budget ${formatMoney(status.budget.amountMinor, status.budget.currency, data.settings.locale)}` });
      row.createEl("p", { text: `Spent ${formatMoney(status.spentMinor, status.budget.currency, data.settings.locale)}` });
      row.createEl("p", { text: `Remaining ${formatMoney(status.remainingMinor, status.budget.currency, data.settings.locale)}` });
      row.createEl("strong", { text: status.overspent ? `Overspent by ${formatMoney(-status.remainingMinor, status.budget.currency, data.settings.locale)}` : "Within budget" });
      const actions = row.createDiv({ cls: "obsidian-finance-actions" });
      actions.createEl("button", { text: "Edit budget" }).addEventListener("click", () => this.plugin.openBudgetModal(status.budget));
      actions.createEl("button", { text: "Delete budget" }).addEventListener("click", () => new ConfirmModal(this.app, "Delete budget?", "Transactions are not changed.", "Delete budget", async () => this.plugin.store.deleteBudget(status.budget.id)).open());
    }
    const categoryList = budgetsSection.createEl("details");
    categoryList.createEl("summary", { text: "Manage categories" });
    for (const category of data.categories) {
      const row = categoryList.createDiv({ cls: "obsidian-finance-compact-row" });
      row.createSpan({ text: `${category.name} — ${category.type}${category.archived ? " — archived" : ""}` });
      row.createEl("button", { text: "Edit" }).addEventListener("click", () => this.plugin.openCategoryModal(category));
      if (!category.archived) row.createEl("button", { text: "Archive" }).addEventListener("click", () => new ConfirmModal(this.app, "Archive category?", "Existing transactions keep this category. Related recurring rules are paused.", "Archive category", async () => this.plugin.store.archiveCategory(category.id)).open());
    }

    const recurringSection = container.createDiv({ cls: "obsidian-finance-section" });
    const recurringHeader = recurringSection.createDiv({ cls: "obsidian-finance-header" });
    recurringHeader.createEl("h3", { text: "Recurring" });
    recurringHeader.createEl("button", { text: "Add recurring item" }).addEventListener("click", () => this.plugin.openRecurringRuleModal());
    if (data.recurringRules.length === 0) recurringSection.createEl("p", { text: "No recurring rules." });
    for (const rule of data.recurringRules) {
      const row = recurringSection.createDiv({ cls: "obsidian-finance-card" });
      row.createEl("h4", { text: rule.description });
      row.createEl("p", { text: `${rule.type === "expense" ? "Expense" : "Income"} · ${rule.frequency} · ${formatMoney(rule.amountMinor, rule.currency, data.settings.locale)}` });
      row.createEl("p", { text: `Next due ${displayDate(rule.nextDueDate, data.settings.calendar)} · ${rule.active ? "Active" : "Paused"}` });
      const actions = row.createDiv({ cls: "obsidian-finance-actions" });
      actions.createEl("button", { text: "Edit recurring item" }).addEventListener("click", () => this.plugin.openRecurringRuleModal(rule));
      actions.createEl("button", { text: rule.active ? "Pause" : "Activate" }).addEventListener("click", () => void this.plugin.store.setRecurringRuleActive(rule.id, !rule.active));
    }

    const cardsSection = container.createDiv({ cls: "obsidian-finance-section" });
    cardsSection.createEl("h3", { text: "Credit cards" });
    const balances = accountBalances(data.accounts, data.transactions);
    const cards = data.accounts.filter((account) => account.kind === "credit-card" && !account.archived);
    if (cards.length === 0) cardsSection.createEl("p", { text: "No active credit cards." });
    for (const card of cards) {
      const owed = balances.get(card.id) ?? 0;
      const block = cardsSection.createDiv({ cls: "obsidian-finance-card" });
      block.createEl("h4", { text: card.name });
      block.createEl("p", { text: `Current amount owed ${formatMoney(owed, card.currency, data.settings.locale)}` });
      const utilization = creditCardUtilization(owed, card.creditLimitMinor);
      block.createEl("p", { text: utilization === undefined ? "Utilization unavailable until a credit limit is set." : `Current utilization ${(utilization * 100).toFixed(1)}%` });
      if (card.statementBalanceMinor !== undefined) block.createEl("p", { text: `Statement balance ${formatMoney(card.statementBalanceMinor, card.currency, data.settings.locale)}` });
      if (card.minimumPaymentMinor !== undefined) block.createEl("p", { text: `Minimum payment ${formatMoney(card.minimumPaymentMinor, card.currency, data.settings.locale)}` });
      if (card.statementClosingDay !== undefined) block.createEl("p", { text: `Next statement closes ${displayDate(nextCardScheduleDate(today, card.statementClosingDay, data.settings.calendar), data.settings.calendar)}` });
      if (card.paymentDueDay !== undefined) block.createEl("p", { text: `Payment due day ${card.paymentDueDay}` });
      block.createEl("button", { text: "Edit card" }).addEventListener("click", () => this.plugin.openAccountModal(card));
    }

    const upcomingSection = container.createDiv({ cls: "obsidian-finance-section" });
    upcomingSection.createEl("h3", { text: "Upcoming" });
    const through = addCalendarPeriod(today, "weekly", 8);
    const occurrences = upcomingOccurrences(data.recurringRules, data.recurringResolutions, today, through);
    for (const occurrence of occurrences) {
      const rule = data.recurringRules.find((item) => item.id === occurrence.ruleId);
      if (!rule) continue;
      const row = upcomingSection.createDiv({ cls: "obsidian-finance-card" });
      row.createEl("h4", { text: rule.description });
      row.createEl("p", { text: `${occurrence.due ? "Due" : "Upcoming"} ${displayDate(occurrence.date, data.settings.calendar)} · ${formatMoney(rule.amountMinor, rule.currency, data.settings.locale)}` });
      row.createEl("p", { text: "Manual confirmation required; this is not posted yet.", cls: "obsidian-finance-muted" });
      const actions = row.createDiv({ cls: "obsidian-finance-actions" });
      actions.createEl("button", { text: "Record", cls: "mod-cta" }).addEventListener("click", () => this.plugin.openRecurringOccurrence(rule, occurrence.date));
      actions.createEl("button", { text: "Skip" }).addEventListener("click", () => new ConfirmModal(this.app, "Skip occurrence?", "Skipping records a resolution but creates no transaction.", "Skip occurrence", async () => this.plugin.store.resolveRecurringOccurrence(rule.id, occurrence.date, "skipped")).open());
    }
    for (const reminder of cardPaymentReminders(data.accounts, today, through, data.settings.calendar)) {
      const account = data.accounts.find((item) => item.id === reminder.accountId);
      if (!account) continue;
      const row = upcomingSection.createDiv({ cls: "obsidian-finance-card" });
      row.createEl("h4", { text: `${account.name} payment` });
      row.createEl("p", { text: `${reminder.status === "overdue" ? "Overdue" : reminder.status === "due" ? "Due today" : "Upcoming"} ${displayDate(reminder.dueDate, data.settings.calendar)} · ${formatMoney(reminder.amountMinor, account.currency, data.settings.locale)}` });
      row.createEl("p", { text: "In-app reminder only. No payment is initiated.", cls: "obsidian-finance-muted" });
    }
    if (occurrences.length === 0 && cardPaymentReminders(data.accounts, today, through, data.settings.calendar).length === 0) upcomingSection.createEl("p", { text: "Nothing due in the next eight weeks." });
  }
}

class AccountModal extends Modal {
  private name = "";
  private kind: AccountKind = "bank";
  private currency: string;
  private openingBalance = "0.00";
  private lastFour = "";
  private creditLimit = "";
  private statementClosingDay = "";
  private paymentDueDay = "";
  private statementBalance = "";
  private minimumPayment = "";
  private isSaving = false;

  constructor(app: App, private readonly plugin: VaultFinancePlugin, private readonly account?: Account, private readonly afterSave?: () => void) {
    super(app);
    this.currency = plugin.store.snapshot().settings.defaultCurrency;
    if (account) {
      this.name = account.name;
      this.kind = account.kind;
      this.currency = account.currency;
      this.openingBalance = groupAmountInput(minorToInput(account.openingBalanceMinor, account.currency));
      this.lastFour = account.lastFour ?? "";
      this.creditLimit = account.creditLimitMinor === undefined ? "" : groupAmountInput(minorToInput(account.creditLimitMinor, account.currency));
      this.statementClosingDay = account.statementClosingDay?.toString() ?? "";
      this.paymentDueDay = account.paymentDueDay?.toString() ?? "";
      this.statementBalance = account.statementBalanceMinor === undefined ? "" : groupAmountInput(minorToInput(account.statementBalanceMinor, account.currency));
      this.minimumPayment = account.minimumPaymentMinor === undefined ? "" : groupAmountInput(minorToInput(account.minimumPaymentMinor, account.currency));
    }
  }

  onOpen(): void { this.render(); }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.account ? "Edit account" : "Add account" });
    new Setting(this.contentEl).setName("Name").addText((text) => text.setPlaceholder("Everyday card").setValue(this.name).onChange((value) => this.name = value));
    const locked = this.account !== undefined && this.plugin.accountHasTransactions(this.account.id);
    new Setting(this.contentEl).setName("Type").setDesc(locked ? "Cannot change after transactions have been recorded." : "").addDropdown((dropdown) => dropdown.addOptions({ cash: "Cash", bank: "Bank", "credit-card": "Credit card" }).setValue(this.kind).setDisabled(locked).onChange((value) => { this.kind = value as AccountKind; this.render(); }));
    new Setting(this.contentEl).setName("Currency").setDesc(locked ? "Cannot change after transactions have been recorded." : "An account always uses one currency.").addDropdown((dropdown) => dropdown.addOptions(currencyOptions()).setValue(this.currency).setDisabled(locked).onChange((value) => { this.currency = value; this.openingBalance = "0"; this.creditLimit = ""; this.render(); }));
    this.addMoneyField(this.kind === "credit-card" ? "Opening amount owed" : "Opening balance", this.openingBalance, (value) => this.openingBalance = value);
    if (this.kind === "credit-card") {
      new Setting(this.contentEl).setName("Last four digits (optional)").setDesc("Never enter a full card number or security credentials.").addText((text) => text.setPlaceholder("1234").setValue(this.lastFour).onChange((value) => this.lastFour = value));
      this.addMoneyField("Credit limit (optional)", this.creditLimit, (value) => this.creditLimit = value);
      new Setting(this.contentEl).setName("Statement closing day (optional)").setDesc("Day 1 through 31; shorter months clamp to month end.").addText((text) => text.setPlaceholder("25").setValue(this.statementClosingDay).onChange((value) => this.statementClosingDay = value));
      new Setting(this.contentEl).setName("Payment due day (optional)").setDesc("Day 1 through 31; shorter months clamp to month end.").addText((text) => text.setPlaceholder("15").setValue(this.paymentDueDay).onChange((value) => this.paymentDueDay = value));
      this.addMoneyField(`Statement balance (${this.currency}, optional)`, this.statementBalance, (value) => this.statementBalance = value);
      this.addMoneyField(`Minimum payment (${this.currency}, optional)`, this.minimumPayment, (value) => this.minimumPayment = value);
    }
    const footer = this.contentEl.createDiv({ cls: "modal-button-container" });
    footer.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    footer.createEl("button", { text: "Save account", cls: "mod-cta" }).addEventListener("click", () => void this.save());
  }

  private addMoneyField(name: string, value: string, update: (value: string) => void): void {
    new Setting(this.contentEl).setName(name).addText((text) => text.setValue(value).onChange((next) => {
      const grouped = groupAmountInput(next);
      update(grouped);
      if (grouped !== next) text.setValue(grouped);
    }));
  }

  private optionalDay(value: string): number | undefined {
    if (!value.trim()) return undefined;
    const result = Number(value);
    if (!Number.isInteger(result)) throw new Error("Card schedule days must be whole numbers.");
    return result;
  }

  private async save(): Promise<void> {
    if (this.isSaving) return;
    this.isSaving = true;
    try {
      const now = new Date().toISOString();
      const card = this.kind === "credit-card";
      await this.plugin.store.upsertAccount({
        id: this.account?.id ?? id(),
        name: this.name.trim(),
        kind: this.kind,
        currency: this.currency,
        openingBalanceMinor: parseNonNegativeMoney(this.openingBalance, this.currency),
        archived: this.account?.archived ?? false,
        lastFour: card && this.lastFour.trim() ? this.lastFour.trim() : undefined,
        creditLimitMinor: card && this.creditLimit.trim() ? parseMoney(this.creditLimit, this.currency) : undefined,
        statementClosingDay: card ? this.optionalDay(this.statementClosingDay) : undefined,
        paymentDueDay: card ? this.optionalDay(this.paymentDueDay) : undefined,
        statementBalanceMinor: card && this.statementBalance.trim() ? parseNonNegativeMoney(this.statementBalance, this.currency) : undefined,
        minimumPaymentMinor: card && this.minimumPayment.trim() ? parseNonNegativeMoney(this.minimumPayment, this.currency) : undefined,
        createdAt: this.account?.createdAt ?? now,
        updatedAt: now
      });
      new Notice("Account saved");
      this.afterSave?.();
      this.close();
    } catch (error) {
      this.isSaving = false;
      new Notice(error instanceof Error ? error.message : "Could not save account");
    }
  }
}

interface RecurringConfirmation {
  ruleId: string;
  occurrenceDate: string;
}

class TransactionModal extends Modal {
  private type: TransactionType = "expense";
  private date: string;
  private accountId = "";
  private fromAccountId = "";
  private toAccountId = "";
  private amount = "";
  private destinationAmount = "";
  private payee = "";
  private categoryId = "";
  private note = "";
  private isSaving = false;
  private showAdvanced = false;

  constructor(app: App, private readonly plugin: VaultFinancePlugin, private readonly transaction?: FinanceTransaction, private readonly recurring?: RecurringConfirmation) {
    super(app);
    const data = plugin.store.snapshot();
    this.date = formatCalendarDate(todayCanonical(), data.settings.calendar);
    this.accountId = data.settings.defaultAccountId ?? data.accounts.find((account) => !account.archived)?.id ?? "";
    if (transaction) {
      this.showAdvanced = true;
      this.type = transaction.type;
      this.date = formatCalendarDate(transaction.date, data.settings.calendar);
      this.note = transaction.note ?? "";
      if (isTransferTransaction(transaction)) {
        this.fromAccountId = transaction.fromAccountId;
        this.toAccountId = transaction.toAccountId;
        this.amount = groupAmountInput(minorToInput(transaction.sourceAmountMinor, transaction.sourceCurrency));
        this.destinationAmount = groupAmountInput(minorToInput(transaction.destinationAmountMinor, transaction.destinationCurrency));
      } else {
        this.accountId = transaction.accountId;
        this.amount = groupAmountInput(minorToInput(transaction.amountMinor, transaction.currency));
        this.payee = transaction.payee ?? "";
        this.categoryId = transaction.categoryId ?? "";
      }
    }
  }

  onOpen(): void { this.render(); }

  private render(): void {
    const accounts = this.plugin.store.snapshot().accounts;
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.recurring ? "Confirm recurring transaction" : this.transaction ? "Edit transaction" : "Add transaction" });
    if (this.recurring) this.contentEl.createEl("p", { text: "Review the prefilled transaction. It is created only after you select save transaction.", cls: "obsidian-finance-muted" });
    if (this.showAdvanced && !this.recurring) new Setting(this.contentEl).setName("Type").addDropdown((dropdown) => dropdown.addOptions(Object.fromEntries(TRANSACTION_TYPES.map((type) => [type, transactionLabel(type)]))).setValue(this.type).onChange((value) => { this.type = value as TransactionType; this.render(); }));
    if (this.showAdvanced) new Setting(this.contentEl).setName(`Date (${this.plugin.store.snapshot().settings.calendar === "persian" ? "Persian" : "Gregorian"} YYYY-MM-DD)`).addText((text) => text.setValue(this.date).onChange((value) => this.date = value));
    if (this.type === "transfer" || this.type === "card-payment") this.renderTransferFields(accounts);
    else this.renderSimpleFields(accounts);
    if (this.showAdvanced) new Setting(this.contentEl).setName("Note (optional)").addTextArea((text) => text.setPlaceholder("Add details").setValue(this.note).onChange((value) => this.note = value));
    if (!this.recurring) {
      const advancedButton = this.contentEl.createEl("button", { text: this.showAdvanced ? "Hide advanced options" : "Advanced options", cls: "obsidian-finance-advanced-toggle" });
      advancedButton.addEventListener("click", () => { this.showAdvanced = !this.showAdvanced; this.render(); });
    }
    const footer = this.contentEl.createDiv({ cls: "modal-button-container" });
    footer.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    footer.createEl("button", { text: this.recurring ? "Save transaction" : this.transaction ? "Save changes" : "Add transaction", cls: "mod-cta" }).addEventListener("click", () => void this.save());
  }

  private renderSimpleFields(accounts: Account[]): void {
    const data = this.plugin.store.snapshot();
    const currentAccountIds = new Set(!this.transaction || isTransferTransaction(this.transaction) ? [] : [this.transaction.accountId]);
    const options = accountOptions(accounts, (account) => this.type !== "income" || account.kind !== "credit-card", currentAccountIds);
    if (!options[this.accountId]) this.accountId = Object.keys(options)[0] ?? "";
    const account = accounts.find((item) => item.id === this.accountId);
    const amountSetting = new Setting(this.contentEl).setName(`Amount${account ? ` (${account.currency})` : ""}`).setDesc(account ? amountDescription(this.amount, account.currency, data.settings.locale) : "Select an account.");
    amountSetting.addText((text) => text.setPlaceholder("1,000,000").setValue(this.amount).onChange((value) => {
      const grouped = groupAmountInput(value);
      this.amount = grouped;
      if (grouped !== value) text.setValue(grouped);
      if (account) amountSetting.setDesc(amountDescription(grouped, account.currency, data.settings.locale));
    }));
    new Setting(this.contentEl).setName("Description (optional)").addText((text) => text.setPlaceholder("Coffee, groceries, salary…").setValue(this.payee).onChange((value) => this.payee = value));
    new Setting(this.contentEl).setName("Account").addDropdown((dropdown) => dropdown.addOptions(options).setValue(this.accountId).onChange((value) => { this.accountId = value; this.render(); }));
    const categoryType = categoryTypeForTransaction(this.type as "expense" | "income" | "refund");
    const categories = categoryOptions(data.categories, categoryType, this.categoryId || undefined);
    new Setting(this.contentEl).setName("Category (optional)").addDropdown((dropdown) => dropdown.addOption("", "Uncategorized").addOptions(categories).setValue(this.categoryId).onChange((value) => this.categoryId = value));
  }

  private renderTransferFields(accounts: Account[]): void {
    const current = new Set(this.transaction && isTransferTransaction(this.transaction) ? [this.transaction.fromAccountId, this.transaction.toAccountId] : []);
    const sourceOptions = accountOptions(accounts, (account) => account.kind !== "credit-card", current);
    const destinationOptions = accountOptions(accounts, (account) => this.type === "card-payment" ? account.kind === "credit-card" : account.kind !== "credit-card", current);
    if (!sourceOptions[this.fromAccountId]) this.fromAccountId = Object.keys(sourceOptions)[0] ?? "";
    if (!destinationOptions[this.toAccountId] || this.toAccountId === this.fromAccountId) this.toAccountId = Object.keys(destinationOptions).find((key) => key !== this.fromAccountId) ?? "";
    new Setting(this.contentEl).setName("From account").addDropdown((dropdown) => dropdown.addOptions(sourceOptions).setValue(this.fromAccountId).onChange((value) => { this.fromAccountId = value; this.render(); }));
    new Setting(this.contentEl).setName("To account").addDropdown((dropdown) => dropdown.addOptions(destinationOptions).setValue(this.toAccountId).onChange((value) => { this.toAccountId = value; this.render(); }));
    const from = accounts.find((account) => account.id === this.fromAccountId);
    const to = accounts.find((account) => account.id === this.toAccountId);
    const locale = this.plugin.store.snapshot().settings.locale;
    const sourceSetting = new Setting(this.contentEl).setName(`Amount sent${from ? ` (${from.currency})` : ""}`).setDesc(from ? amountDescription(this.amount, from.currency, locale) : "Select a source account.");
    sourceSetting.addText((text) => text.setPlaceholder("1,000,000").setValue(this.amount).onChange((value) => {
      const grouped = groupAmountInput(value);
      this.amount = grouped;
      if (grouped !== value) text.setValue(grouped);
      if (from) sourceSetting.setDesc(amountDescription(grouped, from.currency, locale));
    }));
    if (from && to && from.currency !== to.currency) {
      const destinationSetting = new Setting(this.contentEl).setName(`Amount received (${to.currency})`).setDesc(amountDescription(this.destinationAmount, to.currency, locale));
      destinationSetting.addText((text) => text.setPlaceholder("1,000,000").setValue(this.destinationAmount).onChange((value) => {
        const grouped = groupAmountInput(value);
        this.destinationAmount = grouped;
        if (grouped !== value) text.setValue(grouped);
        destinationSetting.setDesc(amountDescription(grouped, to.currency, locale));
      }));
    }
  }

  private async save(): Promise<void> {
    if (this.isSaving) return;
    this.isSaving = true;
    try {
      const data = this.plugin.store.snapshot();
      const now = new Date().toISOString();
      const canonicalDate = parseCalendarDate(this.date, data.settings.calendar);
      const common = { id: this.transaction?.id ?? id(), type: this.type, date: canonicalDate, note: this.note.trim() || undefined, createdAt: this.transaction?.createdAt ?? now, updatedAt: now };
      let result: FinanceTransaction;
      if (this.type === "transfer" || this.type === "card-payment") {
        const from = data.accounts.find((account) => account.id === this.fromAccountId);
        const to = data.accounts.find((account) => account.id === this.toAccountId);
        if (!from || !to) throw new Error("Create the required accounts before recording this transaction.");
        const sourceAmountMinor = parseMoney(this.amount, from.currency);
        const destinationAmountMinor = from.currency === to.currency ? sourceAmountMinor : parseMoney(this.destinationAmount, to.currency);
        result = { ...common, type: this.type, fromAccountId: from.id, toAccountId: to.id, sourceAmountMinor, sourceCurrency: from.currency, destinationAmountMinor, destinationCurrency: to.currency };
      } else {
        const account = data.accounts.find((item) => item.id === this.accountId);
        if (!account) throw new Error("Create an account before adding a transaction.");
        result = { ...common, type: this.type, accountId: account.id, amountMinor: parseMoney(this.amount, account.currency), currency: account.currency, payee: this.payee.trim() || undefined, categoryId: this.categoryId || undefined };
      }
      if (this.recurring) await this.plugin.store.resolveRecurringOccurrence(this.recurring.ruleId, this.recurring.occurrenceDate, "recorded", result);
      else await this.plugin.store.upsertTransaction(result);
      new Notice("Transaction saved");
      this.close();
    } catch (error) {
      this.isSaving = false;
      new Notice(error instanceof Error ? error.message : "Could not save transaction");
    }
  }
}

class CategoryModal extends Modal {
  private name: string;
  private type: CategoryType;
  private isSaving = false;

  constructor(app: App, private readonly plugin: VaultFinancePlugin, private readonly category?: Category) {
    super(app);
    this.name = category?.name ?? "";
    this.type = category?.type ?? "expense";
  }

  onOpen(): void {
    this.contentEl.createEl("h2", { text: this.category ? "Edit category" : "Add category" });
    new Setting(this.contentEl).setName("Name").addText((text) => text.setValue(this.name).onChange((value) => this.name = value));
    new Setting(this.contentEl).setName("Type").addDropdown((dropdown) => dropdown.addOptions({ expense: "Expense and refund", income: "Income" }).setValue(this.type).onChange((value) => this.type = value as CategoryType));
    const footer = this.contentEl.createDiv({ cls: "modal-button-container" });
    footer.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    footer.createEl("button", { text: "Save category", cls: "mod-cta" }).addEventListener("click", () => void this.save());
  }

  private async save(): Promise<void> {
    if (this.isSaving) return;
    this.isSaving = true;
    const now = new Date().toISOString();
    try {
      await this.plugin.store.upsertCategory({ id: this.category?.id ?? id(), name: this.name.trim(), type: this.type, archived: this.category?.archived ?? false, createdAt: this.category?.createdAt ?? now, updatedAt: now });
      new Notice("Category saved");
      this.close();
    } catch (error) {
      this.isSaving = false;
      new Notice(error instanceof Error ? error.message : "Could not save category");
    }
  }
}

class BudgetModal extends Modal {
  private categoryId: string;
  private currency: string;
  private calendar: CalendarSystem;
  private month: string;
  private amount: string;
  private isSaving = false;

  constructor(app: App, private readonly plugin: VaultFinancePlugin, private readonly budget?: MonthlyBudget) {
    super(app);
    const data = plugin.store.snapshot();
    this.categoryId = budget?.categoryId ?? data.categories.find((category) => category.type === "expense" && !category.archived)?.id ?? "";
    this.currency = budget?.currency ?? data.settings.defaultCurrency;
    this.calendar = budget?.calendar ?? data.settings.calendar;
    this.month = budget?.month ?? calendarMonthKey(todayCanonical(), this.calendar);
    this.amount = budget ? groupAmountInput(minorToInput(budget.amountMinor, budget.currency)) : "";
  }

  onOpen(): void {
    const data = this.plugin.store.snapshot();
    this.contentEl.createEl("h2", { text: this.budget ? "Edit budget" : "Add budget" });
    new Setting(this.contentEl).setName("Expense category").addDropdown((dropdown) => dropdown.addOptions(categoryOptions(data.categories, "expense", this.categoryId)).setValue(this.categoryId).onChange((value) => this.categoryId = value));
    new Setting(this.contentEl).setName("Currency").setDesc("Spending is matched only in this currency.").addDropdown((dropdown) => dropdown.addOptions(currencyOptions()).setValue(this.currency).onChange((value) => { this.currency = value; this.amount = ""; }));
    new Setting(this.contentEl).setName("Calendar").addDropdown((dropdown) => dropdown.addOptions({ gregorian: "Gregorian", persian: "Persian" }).setValue(this.calendar).onChange((value) => { this.calendar = value as CalendarSystem; this.month = calendarMonthKey(todayCanonical(), this.calendar); }));
    new Setting(this.contentEl).setName("Calendar month").setDesc("Use yyyy-mm in the selected calendar.").addText((text) => text.setValue(this.month).onChange((value) => this.month = value));
    new Setting(this.contentEl).setName(`Budget amount (${this.currency})`).addText((text) => text.setValue(this.amount).onChange((value) => { const grouped = groupAmountInput(value); this.amount = grouped; if (grouped !== value) text.setValue(grouped); }));
    const footer = this.contentEl.createDiv({ cls: "modal-button-container" });
    footer.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    footer.createEl("button", { text: "Save budget", cls: "mod-cta" }).addEventListener("click", () => void this.save());
  }

  private async save(): Promise<void> {
    if (this.isSaving) return;
    this.isSaving = true;
    const now = new Date().toISOString();
    try {
      await this.plugin.store.upsertBudget({ id: this.budget?.id ?? id(), categoryId: this.categoryId, currency: this.currency, calendar: this.calendar, month: this.month.trim(), amountMinor: parseMoney(this.amount, this.currency), createdAt: this.budget?.createdAt ?? now, updatedAt: now });
      new Notice("Budget saved");
      this.close();
    } catch (error) {
      this.isSaving = false;
      new Notice(error instanceof Error ? error.message : "Could not save budget");
    }
  }
}

class RecurringRuleModal extends Modal {
  private type: CategoryType;
  private frequency: RecurrenceFrequency;
  private accountId: string;
  private amount: string;
  private categoryId: string;
  private description: string;
  private dueDate: string;
  private note: string;
  private calendar: CalendarSystem;
  private active: boolean;
  private isSaving = false;

  constructor(app: App, private readonly plugin: VaultFinancePlugin, private readonly rule?: RecurringRule) {
    super(app);
    const data = plugin.store.snapshot();
    this.type = rule?.type ?? "expense";
    this.frequency = rule?.frequency ?? "monthly";
    this.accountId = rule?.accountId ?? data.accounts.find((account) => !account.archived)?.id ?? "";
    this.amount = rule ? groupAmountInput(minorToInput(rule.amountMinor, rule.currency)) : "";
    this.categoryId = rule?.categoryId ?? data.categories.find((category) => category.type === this.type && !category.archived)?.id ?? "";
    this.description = rule?.description ?? "";
    this.calendar = rule?.calendar ?? data.settings.calendar;
    this.dueDate = formatCalendarDate(rule?.nextDueDate ?? todayCanonical(), this.calendar);
    this.note = rule?.note ?? "";
    this.active = rule?.active ?? true;
  }

  onOpen(): void { this.render(); }

  private render(): void {
    const data = this.plugin.store.snapshot();
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.rule ? "Edit recurring item" : "Add recurring item" });
    new Setting(this.contentEl).setName("Type").addDropdown((dropdown) => dropdown.addOptions({ expense: "Expense", income: "Income" }).setValue(this.type).onChange((value) => { this.type = value as CategoryType; this.categoryId = ""; this.render(); }));
    new Setting(this.contentEl).setName("Frequency").addDropdown((dropdown) => dropdown.addOptions({ weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" }).setValue(this.frequency).onChange((value) => this.frequency = value as RecurrenceFrequency));
    const accounts = accountOptions(data.accounts, (account) => this.type !== "income" || account.kind !== "credit-card", new Set(this.rule ? [this.rule.accountId] : []));
    if (!accounts[this.accountId]) this.accountId = Object.keys(accounts)[0] ?? "";
    const account = data.accounts.find((item) => item.id === this.accountId);
    new Setting(this.contentEl).setName("Account").addDropdown((dropdown) => dropdown.addOptions(accounts).setValue(this.accountId).onChange((value) => { this.accountId = value; this.amount = ""; this.render(); }));
    new Setting(this.contentEl).setName(`Amount${account ? ` (${account.currency})` : ""}`).addText((text) => text.setValue(this.amount).onChange((value) => { const grouped = groupAmountInput(value); this.amount = grouped; if (grouped !== value) text.setValue(grouped); }));
    new Setting(this.contentEl).setName("Category").addDropdown((dropdown) => dropdown.addOptions(categoryOptions(data.categories, this.type, this.rule?.categoryId)).setValue(this.categoryId).onChange((value) => this.categoryId = value));
    new Setting(this.contentEl).setName("Description").addText((text) => text.setValue(this.description).onChange((value) => this.description = value));
    new Setting(this.contentEl).setName("Calendar").setDesc("Monthly and yearly arithmetic follows this calendar. Weekly always means seven days.").addDropdown((dropdown) => dropdown.addOptions({ gregorian: "Gregorian", persian: "Persian" }).setValue(this.calendar).onChange((value) => { const canonical = parseCalendarDate(this.dueDate, this.calendar); this.calendar = value as CalendarSystem; this.dueDate = formatCalendarDate(canonical, this.calendar); this.render(); }));
    new Setting(this.contentEl).setName("Next and anchor due date").setDesc(`Use ${this.calendar === "persian" ? "Persian" : "Gregorian"} YYYY-MM-DD.`).addText((text) => text.setValue(this.dueDate).onChange((value) => this.dueDate = value));
    new Setting(this.contentEl).setName("Note (optional)").addTextArea((text) => text.setValue(this.note).onChange((value) => this.note = value));
    new Setting(this.contentEl).setName("Active").addToggle((toggle) => toggle.setValue(this.active).onChange((value) => this.active = value));
    const footer = this.contentEl.createDiv({ cls: "modal-button-container" });
    footer.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    footer.createEl("button", { text: "Save recurring item", cls: "mod-cta" }).addEventListener("click", () => void this.save());
  }

  private async save(): Promise<void> {
    if (this.isSaving) return;
    this.isSaving = true;
    try {
      const data = this.plugin.store.snapshot();
      const account = data.accounts.find((item) => item.id === this.accountId);
      if (!account) throw new Error("Recurring account is required.");
      const now = new Date().toISOString();
      const due = parseCalendarDate(this.dueDate, this.calendar);
      await this.plugin.store.upsertRecurringRule({
        id: this.rule?.id ?? id(), type: this.type, frequency: this.frequency, accountId: account.id,
        amountMinor: parseMoney(this.amount, account.currency), currency: account.currency, categoryId: this.categoryId,
        description: this.description.trim(), anchorDueDate: this.rule?.anchorDueDate ?? due, nextDueDate: due,
        note: this.note.trim() || undefined, calendar: this.calendar, active: this.active,
        createdAt: this.rule?.createdAt ?? now, updatedAt: now
      });
      new Notice("Recurring item saved");
      this.close();
    } catch (error) {
      this.isSaving = false;
      new Notice(error instanceof Error ? error.message : "Could not save recurring item");
    }
  }
}

class TransactionReferenceModal extends SuggestModal<FinanceTransaction> {
  constructor(app: App, private readonly plugin: VaultFinancePlugin, private readonly editor: Editor) {
    super(app);
    this.setPlaceholder("Search transactions by date, description, category, or account");
  }

  getSuggestions(query: string): FinanceTransaction[] {
    const data = this.plugin.store.snapshot();
    const normalized = query.trim().toLowerCase();
    return [...data.transactions]
      .sort((first, second) => second.date.localeCompare(first.date) || second.updatedAt.localeCompare(first.updatedAt))
      .filter((transaction) => {
        if (!normalized) return true;
        const accountNames = isTransferTransaction(transaction)
          ? data.accounts.filter((account) => account.id === transaction.fromAccountId || account.id === transaction.toAccountId).map((account) => account.name)
          : [data.accounts.find((account) => account.id === transaction.accountId)?.name ?? ""];
        const details = isTransferTransaction(transaction) ? [] : [transaction.payee ?? "", categoryName(data.categories, transaction.categoryId)];
        return [transaction.date, formatCalendarDate(transaction.date, data.settings.calendar), transaction.type, transaction.note ?? "", ...accountNames, ...details].some((value) => value.toLowerCase().includes(normalized));
      });
  }

  renderSuggestion(transaction: FinanceTransaction, element: HTMLElement): void {
    const data = this.plugin.store.snapshot();
    const accountName = isTransferTransaction(transaction)
      ? `${data.accounts.find((account) => account.id === transaction.fromAccountId)?.name ?? "Unknown"} → ${data.accounts.find((account) => account.id === transaction.toAccountId)?.name ?? "Unknown"}`
      : data.accounts.find((account) => account.id === transaction.accountId)?.name ?? "Unknown";
    const amount = isTransferTransaction(transaction) ? formatMoney(transaction.sourceAmountMinor, transaction.sourceCurrency, data.settings.locale) : formatMoney(transaction.amountMinor, transaction.currency, data.settings.locale);
    element.createDiv({ text: `${transactionLabel(transaction.type)} · ${amount}` });
    element.createEl("small", { text: `${displayDate(transaction.date, data.settings.calendar)} · ${accountName}` });
  }

  onChooseSuggestion(transaction: FinanceTransaction): void { this.editor.replaceSelection(transactionReference(transaction.id)); }
}

class FinanceSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: VaultFinancePlugin) { super(app, plugin); }

  private refreshSettingsTab(): void {
    const update = Reflect.get(this, "update") as unknown;
    if (typeof update === "function") Reflect.apply(update, this, []);
    else this.display();
  }

  getSettingDefinitions(): ReturnType<PluginSettingTab["getSettingDefinitions"]> {
    const data = this.plugin.store.snapshot();
    return [
      { name: "Default currency", desc: "Used when creating new accounts and budgets. Reports remain separated by currency.", render: (setting: Setting) => { setting.addDropdown((dropdown) => dropdown.addOptions(currencyOptions()).setValue(data.settings.defaultCurrency).onChange(async (value) => this.plugin.store.updateSettings({ defaultCurrency: value }))); } },
      { name: "Display locale", desc: "Controls number and currency formatting.", render: (setting: Setting) => { setting.addText((text) => text.setValue(data.settings.locale).onChange(async (value) => { if (!value.trim()) return; try { await this.plugin.store.updateSettings({ locale: normalizeLocale(value) }); } catch (error) { new Notice(error instanceof Error ? error.message : "Invalid locale"); } })); } },
      { name: "Calendar", desc: "Controls displayed dates, monthly grouping, planning, and new recurring rules.", render: (setting: Setting) => { setting.addDropdown((dropdown) => dropdown.addOptions({ gregorian: "Gregorian", persian: "Persian" }).setValue(data.settings.calendar).onChange(async (value) => this.plugin.store.updateSettings({ calendar: value as CalendarSystem }))); } },
      { name: "First day of week", render: (setting: Setting) => { setting.addDropdown((dropdown) => dropdown.addOptions({ "0": "Sunday", "1": "Monday", "6": "Saturday" }).setValue(String(data.settings.weekStartsOn)).onChange(async (value) => this.plugin.store.updateSettings({ weekStartsOn: Number(value) }))); } },
      { name: "Default account", render: (setting: Setting) => { setting.addDropdown((dropdown) => dropdown.addOption("", "None").addOptions(accountOptions(data.accounts)).setValue(data.settings.defaultAccountId ?? "").onChange(async (value) => this.plugin.store.updateSettings({ defaultAccountId: value || undefined }))); } },
      {
        type: "group", heading: "Accounts", items: [
          { name: "Add an account", desc: "Store only a nickname and optional card details.", render: (setting: Setting) => setting.addButton((button) => button.setButtonText("Add account").setCta().onClick(() => this.plugin.openAccountModal(undefined, () => this.refreshSettingsTab()))) },
          ...data.accounts.map((account) => ({ name: account.name, desc: `${account.kind} · ${account.currency}${account.archived ? " · archived" : ""}`, render: (setting: Setting) => {
            setting.addButton((button) => button.setIcon("pencil").setTooltip("Edit account").onClick(() => this.plugin.openAccountModal(account, () => this.refreshSettingsTab())));
            if (!account.archived) setting.addButton((button) => button.setIcon("archive").setTooltip("Archive account").onClick(async () => { await this.plugin.store.archiveAccount(account.id); this.refreshSettingsTab(); }));
          } }))
        ]
      },
      { type: "group", heading: "Privacy", items: [{ name: "Local-only storage", desc: "Finance data stays in this plugin's data.json. There are no network requests, telemetry, bank connections, system notifications, or silent posting." }] }
    ];
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const data = this.plugin.store.snapshot();
    new Setting(containerEl).setName("Default currency").setDesc("Used for new accounts and budgets. Reports remain separated by currency.").addDropdown((dropdown) => dropdown.addOptions(currencyOptions()).setValue(data.settings.defaultCurrency).onChange(async (value) => { await this.plugin.store.updateSettings({ defaultCurrency: value }); }));
    new Setting(containerEl).setName("Display locale").setDesc("Controls number and currency formatting.").addText((text) => text.setValue(data.settings.locale).onChange(async (value) => { if (!value.trim()) return; try { await this.plugin.store.updateSettings({ locale: normalizeLocale(value) }); } catch (error) { new Notice(error instanceof Error ? error.message : "Invalid locale"); } }));
    new Setting(containerEl).setName("Calendar").setDesc("Controls displayed dates, monthly grouping, planning, and new recurring rules.").addDropdown((dropdown) => dropdown.addOptions({ gregorian: "Gregorian", persian: "Persian" }).setValue(data.settings.calendar).onChange(async (value) => { await this.plugin.store.updateSettings({ calendar: value as CalendarSystem }); }));
    new Setting(containerEl).setName("First day of week").addDropdown((dropdown) => dropdown.addOptions({ "0": "Sunday", "1": "Monday", "6": "Saturday" }).setValue(String(data.settings.weekStartsOn)).onChange(async (value) => { await this.plugin.store.updateSettings({ weekStartsOn: Number(value) }); }));
    new Setting(containerEl).setName("Default account").addDropdown((dropdown) => dropdown.addOption("", "None").addOptions(accountOptions(data.accounts)).setValue(data.settings.defaultAccountId ?? "").onChange(async (value) => { await this.plugin.store.updateSettings({ defaultAccountId: value || undefined }); }));
    new Setting(containerEl).setName("Accounts").setHeading();
    new Setting(containerEl).setName("Add an account").addButton((button) => button.setButtonText("Add account").setCta().onClick(() => this.plugin.openAccountModal(undefined, () => this.display())));
    for (const account of data.accounts) {
      const setting = new Setting(containerEl).setName(account.name).setDesc(`${account.kind} · ${account.currency}${account.archived ? " · archived" : ""}`);
      setting.addButton((button) => button.setIcon("pencil").setTooltip("Edit account").onClick(() => this.plugin.openAccountModal(account, () => this.display())));
      if (!account.archived) setting.addButton((button) => button.setIcon("archive").setTooltip("Archive account").onClick(async () => { await this.plugin.store.archiveAccount(account.id); this.display(); }));
    }
    new Setting(containerEl).setName("Privacy").setHeading();
    containerEl.createEl("p", { text: "All finance data stays in this plugin's data.json. There are no network requests, telemetry, bank connections, system notifications, or silent posting. Never enter full card numbers, security codes, pins, or banking passwords." });
  }
}

export default class VaultFinancePlugin extends Plugin {
  store = new FinanceStore((data) => this.saveData(data));
  private reminderDate?: string;

  async onload(): Promise<void> {
    try { await this.store.load(await this.loadData()); }
    catch (error) {
      const message = error instanceof Error ? error.message : "Finance data could not be loaded.";
      new Notice(message, 0);
      throw error;
    }
    this.registerView(DASHBOARD_VIEW, (leaf) => new DashboardView(leaf, this));
    this.registerView(HISTORY_VIEW, (leaf) => new HistoryView(leaf, this));
    this.registerView(PLANNING_VIEW, (leaf) => new PlanningView(leaf, this));
    this.addRibbonIcon("circle-dollar-sign", "Open finance dashboard", () => void this.activateView(DASHBOARD_VIEW));
    this.addCommand({ id: "open-dashboard", name: "Open dashboard", callback: () => void this.activateView(DASHBOARD_VIEW) });
    this.addCommand({ id: "open-history", name: "Open transaction history", callback: () => void this.activateView(HISTORY_VIEW) });
    this.addCommand({ id: "open-planning", name: "Open planning", callback: () => void this.activateView(PLANNING_VIEW) });
    this.addCommand({ id: "add-transaction", name: "Add transaction", callback: () => this.openTransactionModal() });
    this.addCommand({ id: "add-account", name: "Add account", callback: () => this.openAccountModal() });
    this.addCommand({ id: "insert-transaction-reference", name: "Insert transaction reference", editorCallback: (editor) => new TransactionReferenceModal(this.app, this, editor).open() });
    this.registerMarkdownCodeBlockProcessor("vault-finance", (source, element) => this.renderTransactionReference(source, element));
    this.addSettingTab(new FinanceSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      if (this.app.workspace.getLeavesOfType(DASHBOARD_VIEW).length === 0) void this.activateView(DASHBOARD_VIEW, false);
      this.showReminderSummary();
    });
  }

  async activateView(type: string, reveal = true): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(type)[0];
    const leaf = existing ?? (type === DASHBOARD_VIEW ? this.app.workspace.getRightLeaf(false) : this.app.workspace.getLeaf(true));
    if (!leaf) return;
    if (!existing) await leaf.setViewState({ type, active: true });
    if (reveal) await this.app.workspace.revealLeaf(leaf);
  }

  openTransactionModal(transaction?: FinanceTransaction): void {
    if (this.store.snapshot().accounts.filter((account) => !account.archived).length === 0) {
      new Notice("Add an account first");
      this.openAccountModal(undefined, () => this.openTransactionModal(transaction));
      return;
    }
    new TransactionModal(this.app, this, transaction).open();
  }

  openRecurringOccurrence(rule: RecurringRule, occurrenceDate: string): void {
    const transaction = recurringTransactionForOccurrence(rule, occurrenceDate, id(), new Date().toISOString());
    new TransactionModal(this.app, this, transaction, { ruleId: rule.id, occurrenceDate }).open();
  }

  openAccountModal(account?: Account, afterSave?: () => void): void { new AccountModal(this.app, this, account, afterSave).open(); }
  openCategoryModal(category?: Category): void { new CategoryModal(this.app, this, category).open(); }
  openBudgetModal(budget?: MonthlyBudget): void { new BudgetModal(this.app, this, budget).open(); }
  openRecurringRuleModal(rule?: RecurringRule): void { new RecurringRuleModal(this.app, this, rule).open(); }

  accountHasTransactions(accountId: string): boolean {
    return this.store.snapshot().transactions.some((transaction) => isTransferTransaction(transaction)
      ? transaction.fromAccountId === accountId || transaction.toAccountId === accountId
      : transaction.accountId === accountId);
  }

  private showReminderSummary(): void {
    const today = todayCanonical();
    if (this.reminderDate === today) return;
    this.reminderDate = today;
    const data = this.store.snapshot();
    const dueRecurring = upcomingOccurrences(data.recurringRules, data.recurringResolutions, today, today).filter((item) => item.due).length;
    const dueCards = cardPaymentReminders(data.accounts, today, today, data.settings.calendar).filter((item) => item.status !== "upcoming").length;
    if (dueRecurring + dueCards > 0) new Notice(`Vault Finance: ${dueRecurring} recurring item(s) and ${dueCards} card payment(s) need attention. Open Planning to review. Nothing was posted or paid automatically.`, 10_000);
  }

  renderTransactionReference(source: string, element: HTMLElement): void {
    element.empty();
    const transactionId = source.split("\n").map((line) => line.trim()).find((line) => line.startsWith("transaction:"))?.slice("transaction:".length).trim();
    const data = this.store.snapshot();
    const transaction = data.transactions.find((item) => item.id === transactionId);
    if (!transaction) { element.createDiv({ text: "Transaction reference not found.", cls: "obsidian-finance-muted" }); return; }
    const card = element.createDiv({ cls: "obsidian-finance-card obsidian-finance-reference" });
    const heading = card.createDiv({ cls: "obsidian-finance-reference-heading" });
    heading.createEl("strong", { text: transactionLabel(transaction.type) });
    heading.createSpan({ text: displayDate(transaction.date, data.settings.calendar) });
    const accountName = isTransferTransaction(transaction)
      ? `${data.accounts.find((account) => account.id === transaction.fromAccountId)?.name ?? "Unknown"} → ${data.accounts.find((account) => account.id === transaction.toAccountId)?.name ?? "Unknown"}`
      : data.accounts.find((account) => account.id === transaction.accountId)?.name ?? "Unknown";
    card.createDiv({ text: accountName, cls: "obsidian-finance-muted" });
    card.createEl("strong", { text: isTransferTransaction(transaction) ? formatMoney(transaction.sourceAmountMinor, transaction.sourceCurrency, data.settings.locale) : formatMoney(transaction.amountMinor, transaction.currency, data.settings.locale) });
    if (!isTransferTransaction(transaction) && transaction.payee) card.createDiv({ text: transaction.payee });
    card.createEl("button", { text: "Edit transaction" }).addEventListener("click", () => this.openTransactionModal(transaction));
  }

  async insertTransactionReference(transactionId: string): Promise<void> {
    const reference = transactionReference(transactionId);
    const editor = this.app.workspace.activeEditor?.editor;
    if (editor) { editor.replaceSelection(reference); new Notice("Transaction reference inserted"); return; }
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") { new Notice("Open the journal note where you want to add this transaction"); return; }
    try {
      await this.app.vault.process(file, (content) => {
        const separator = content.length === 0 || content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
        return `${content}${separator}${reference}\n`;
      });
      new Notice(`Transaction reference added to ${file.basename}`);
    } catch { new Notice(`Could not add the transaction reference to ${file.basename}`); }
  }

  renderTransactionRow(container: HTMLElement, transaction: FinanceTransaction): void {
    const data = this.store.snapshot();
    const row = container.createDiv({ cls: "obsidian-finance-transaction" });
    const main = row.createDiv({ cls: "obsidian-finance-transaction-main" });
    main.createEl("strong", { text: transactionLabel(transaction.type) });
    const accounts = isTransferTransaction(transaction)
      ? `${data.accounts.find((account) => account.id === transaction.fromAccountId)?.name ?? "Unknown"} → ${data.accounts.find((account) => account.id === transaction.toAccountId)?.name ?? "Unknown"}`
      : data.accounts.find((account) => account.id === transaction.accountId)?.name ?? "Unknown";
    const details = !isTransferTransaction(transaction) ? ` · ${categoryName(data.categories, transaction.categoryId)}${transaction.payee ? ` · ${transaction.payee}` : ""}` : "";
    main.createSpan({ text: `${displayDate(transaction.date, data.settings.calendar)} · ${accounts}${details}` });
    const amount = row.createDiv({ cls: "obsidian-finance-transaction-amount" });
    if (isTransferTransaction(transaction)) {
      amount.createEl("strong", { text: formatMoney(transaction.sourceAmountMinor, transaction.sourceCurrency, data.settings.locale) });
      if (transaction.sourceCurrency !== transaction.destinationCurrency) amount.createEl("small", { text: `→ ${formatMoney(transaction.destinationAmountMinor, transaction.destinationCurrency, data.settings.locale)}` });
    } else amount.createEl("strong", { text: formatMoney(transaction.amountMinor, transaction.currency, data.settings.locale) });
    const buttons = row.createDiv({ cls: "obsidian-finance-row-actions" });
    addIconButton(buttons, "file-plus-2", "Add reference to current note", () => void this.insertTransactionReference(transaction.id));
    addIconButton(buttons, "pencil", "Edit transaction", () => this.openTransactionModal(transaction));
    addIconButton(buttons, "trash-2", "Delete transaction", () => new ConfirmModal(this.app, "Delete transaction?", "This action cannot be undone.", "Delete transaction", async () => { await this.store.deleteTransaction(transaction.id); new Notice("Transaction deleted"); }).open());
  }
}

class ConfirmModal extends Modal {
  constructor(app: App, private readonly title: string, private readonly message: string, private readonly confirmLabel: string, private readonly confirm: () => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.createEl("h2", { text: this.title });
    this.contentEl.createEl("p", { text: this.message });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    buttons.createEl("button", { text: this.confirmLabel, cls: "mod-warning" }).addEventListener("click", () => void this.confirm().then(() => this.close()).catch((error: unknown) => new Notice(error instanceof Error ? error.message : "Action failed")));
  }
}
