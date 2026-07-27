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
import type { Account, AccountKind, FinanceTransaction, TransactionType } from "@/types";
import { isTransferTransaction } from "@/types";
import { CURRENCIES, formatMoney, minorToInput, normalizeLocale, parseMoney, parseNonNegativeMoney } from "@/domain/money";
import {
  accountBalances,
  localDate,
  monthRange,
  netBalancesByCurrency,
  summarize,
  transactionLabel,
  weekRange
} from "@/domain/finance";
import { FinanceStore } from "@/store/finance-store";

const DASHBOARD_VIEW = "vault-finance-dashboard";
const HISTORY_VIEW = "vault-finance-history";
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
  try {
    return `Preview: ${formatMoney(parseMoney(value, currency), currency, locale)}`;
  } catch {
    return "Thousands are separated with commas while you type.";
  }
}

function groupAmountInput(value: string): string {
  const compact = value.replace(/[,_'\s\u00a0\u202f]/g, "");
  if (!/^\d*(?:\.\d*)?$/.test(compact)) return value;
  const [whole = "", fraction] = compact.split(".");
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? groupedWhole : `${groupedWhole}.${fraction}`;
}

abstract class FinanceView extends ItemView {
  private unsubscribe?: () => void;

  constructor(leaf: WorkspaceLeaf, protected readonly plugin: VaultFinancePlugin) {
    super(leaf);
  }

  async onOpen(): Promise<void> {
    this.unsubscribe = this.plugin.store.subscribe(() => this.render());
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
  }

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
    const addButton = actions.createEl("button", { text: "Add transaction", cls: "mod-cta" });
    addButton.addEventListener("click", () => this.plugin.openTransactionModal());
    const accountButton = actions.createEl("button", { text: "Add account" });
    accountButton.addEventListener("click", () => this.plugin.openAccountModal());
    const historyButton = actions.createEl("button", { text: "History" });
    historyButton.addEventListener("click", () => void this.plugin.activateView(HISTORY_VIEW));

    if (data.accounts.length === 0) {
      const empty = container.createDiv({ cls: "obsidian-finance-empty" });
      empty.createEl("h3", { text: "Add your first account" });
      empty.createEl("p", { text: "Create a cash, bank, or credit-card account. Only descriptive card details are stored." });
      const button = empty.createEl("button", { text: "Add account", cls: "mod-cta" });
      button.addEventListener("click", () => this.plugin.openAccountModal());
      return;
    }

    const balances = accountBalances(data.accounts, data.transactions);
    const netTotals = netBalancesByCurrency(data.accounts, data.transactions);
    const balanceSection = container.createDiv({ cls: "obsidian-finance-section" });
    balanceSection.createEl("h3", { text: "Current balance" });
    balanceSection.createEl("p", { text: "Cash and bank balances minus credit-card balances, kept separate by currency.", cls: "obsidian-finance-muted" });
    const balanceGrid = balanceSection.createDiv({ cls: "obsidian-finance-grid" });
    for (const [currency, total] of netTotals) {
      const card = balanceGrid.createDiv({ cls: "obsidian-finance-card obsidian-finance-total-card" });
      card.createSpan({ text: currency, cls: "obsidian-finance-eyebrow" });
      card.createEl("strong", { text: formatMoney(total, currency, data.settings.locale), cls: total < 0 ? "obsidian-finance-negative" : "obsidian-finance-positive" });
      card.createEl("small", { text: "Net across active accounts" });
    }

    const accountSection = container.createDiv({ cls: "obsidian-finance-section" });
    accountSection.createEl("h3", { text: "Accounts" });
    const accountGrid = accountSection.createDiv({ cls: "obsidian-finance-grid" });
    for (const account of data.accounts.filter((item) => !item.archived)) {
      const balance = balances.get(account.id) ?? 0;
      const card = accountGrid.createDiv({ cls: "obsidian-finance-card" });
      card.createSpan({ text: account.kind === "credit-card" ? "Credit card" : account.kind, cls: "obsidian-finance-eyebrow" });
      card.createEl("h4", { text: account.name });
      card.createEl("strong", { text: formatMoney(balance, account.currency, data.settings.locale), cls: balance < 0 ? "obsidian-finance-negative" : "" });
      card.createEl("small", { text: account.kind === "credit-card" ? "Current amount owed" : "Current balance" });
      if (account.kind === "credit-card" && account.creditLimitMinor !== undefined) {
        card.createEl("small", { text: `${formatMoney(account.creditLimitMinor - balance, account.currency, data.settings.locale)} credit available` });
      }
    }

    const now = new Date();
    const [weekStart, weekEnd] = weekRange(now, data.settings.weekStartsOn);
    const [monthStart, monthEnd] = monthRange(now);
    const periodGrid = container.createDiv({ cls: "obsidian-finance-grid obsidian-finance-periods" });
    this.renderSummary(periodGrid, "This week", weekStart, weekEnd, summarize(data.transactions, weekStart, weekEnd), data.settings.locale);
    this.renderSummary(periodGrid, "This month", monthStart, monthEnd, summarize(data.transactions, monthStart, monthEnd), data.settings.locale);

    const recentSection = container.createDiv({ cls: "obsidian-finance-section" });
    recentSection.createEl("h3", { text: "Recent transactions" });
    const recent = [...data.transactions].sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
    if (recent.length === 0) recentSection.createEl("p", { text: "No transactions yet.", cls: "obsidian-finance-muted" });
    else for (const transaction of recent) this.plugin.renderTransactionRow(recentSection, transaction);
  }

  private renderSummary(container: HTMLElement, title: string, start: string, end: string, summaries: ReturnType<typeof summarize>, locale: string): void {
    const card = container.createDiv({ cls: "obsidian-finance-card" });
    card.createEl("h3", { text: title });
    card.createEl("small", { text: `${start} – ${end}` });
    if (summaries.size === 0) {
      card.createEl("p", { text: "No activity", cls: "obsidian-finance-muted" });
      return;
    }
    for (const [currency, summary] of summaries) {
      const block = card.createDiv({ cls: "obsidian-finance-summary-currency" });
      block.createEl("strong", { text: currency });
      block.createSpan({ text: `Spent ${formatMoney(summary.expenses - summary.refunds, currency, locale)}` });
      block.createSpan({ text: `Income ${formatMoney(summary.income, currency, locale)}` });
      block.createSpan({ text: `Net ${formatMoney(summary.net, currency, locale)}`, cls: summary.net < 0 ? "obsidian-finance-negative" : "obsidian-finance-positive" });
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
    const button = header.createEl("button", { text: "Add transaction", cls: "mod-cta" });
    button.addEventListener("click", () => this.plugin.openTransactionModal());

    const filters = container.createDiv({ cls: "obsidian-finance-filters" });
    const search = filters.createEl("input", { type: "search", placeholder: "Search payee, category, or note", value: this.query, attr: { "aria-label": "Search transactions" } });
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
      .filter((transaction) => !query || [transaction.note, !isTransferTransaction(transaction) ? transaction.payee : "", !isTransferTransaction(transaction) ? transaction.category : ""].some((value) => value?.toLowerCase().includes(query)))
      .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt));
    if (transactions.length === 0) rows.createEl("p", { text: "No matching transactions.", cls: "obsidian-finance-muted" });
    else for (const transaction of transactions) this.plugin.renderTransactionRow(rows, transaction);
  }
}

class AccountModal extends Modal {
  private name = "";
  private kind: AccountKind = "bank";
  private currency: string;
  private openingBalance = "0.00";
  private lastFour = "";
  private creditLimit = "";
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
    }
  }

  onOpen(): void { this.render(); }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.account ? "Edit account" : "Add account" });
    new Setting(this.contentEl).setName("Name").addText((text) => text.setPlaceholder("Everyday card").setValue(this.name).onChange((value) => this.name = value));
    const accountingFieldsLocked = this.account !== undefined && this.plugin.accountHasTransactions(this.account.id);
    new Setting(this.contentEl).setName("Type").setDesc(accountingFieldsLocked ? "Cannot change after transactions have been recorded." : "").addDropdown((dropdown) => dropdown.addOptions({ cash: "Cash", bank: "Bank", "credit-card": "Credit card" }).setValue(this.kind).setDisabled(accountingFieldsLocked).onChange((value) => { this.kind = value as AccountKind; this.render(); }));
    new Setting(this.contentEl).setName("Currency").setDesc(accountingFieldsLocked ? "Cannot change after transactions have been recorded." : "An account always uses one currency.").addDropdown((dropdown) => dropdown.addOptions(currencyOptions()).setValue(this.currency).setDisabled(accountingFieldsLocked).onChange((value) => { this.currency = value; this.openingBalance = "0"; this.creditLimit = ""; this.render(); }));
    new Setting(this.contentEl).setName(this.kind === "credit-card" ? "Opening amount owed" : "Opening balance").addText((text) => text.setValue(this.openingBalance).onChange((value) => {
      const grouped = groupAmountInput(value);
      this.openingBalance = grouped;
      if (grouped !== value) text.setValue(grouped);
    }));
    if (this.kind === "credit-card") {
      new Setting(this.contentEl).setName("Last four digits (optional)").setDesc("Never enter the full card number or security credentials.").addText((text) => text.setPlaceholder("1234").setValue(this.lastFour).onChange((value) => this.lastFour = value));
      new Setting(this.contentEl).setName("Credit limit (optional)").addText((text) => text.setValue(this.creditLimit).onChange((value) => {
        const grouped = groupAmountInput(value);
        this.creditLimit = grouped;
        if (grouped !== value) text.setValue(grouped);
      }));
    }
    const footer = this.contentEl.createDiv({ cls: "modal-button-container" });
    footer.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    footer.createEl("button", { text: "Save account", cls: "mod-cta" }).addEventListener("click", () => void this.save());
  }

  private async save(): Promise<void> {
    if (this.isSaving) return;
    this.isSaving = true;
    try {
      const now = new Date().toISOString();
      const openingBalanceMinor = parseNonNegativeMoney(this.openingBalance, this.currency);
      const creditLimitMinor = this.kind === "credit-card" && this.creditLimit.trim() ? parseMoney(this.creditLimit, this.currency) : undefined;
      await this.plugin.store.upsertAccount({
        id: this.account?.id ?? id(), name: this.name.trim(), kind: this.kind, currency: this.currency,
        openingBalanceMinor, archived: this.account?.archived ?? false,
        lastFour: this.kind === "credit-card" && this.lastFour.trim() ? this.lastFour.trim() : undefined,
        creditLimitMinor, createdAt: this.account?.createdAt ?? now, updatedAt: now
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

class TransactionModal extends Modal {
  private type: TransactionType = "expense";
  private date = localDate();
  private accountId = "";
  private fromAccountId = "";
  private toAccountId = "";
  private amount = "";
  private destinationAmount = "";
  private payee = "";
  private category = "";
  private note = "";
  private isSaving = false;
  private showAdvanced = false;

  constructor(app: App, private readonly plugin: VaultFinancePlugin, private readonly transaction?: FinanceTransaction) {
    super(app);
    const data = plugin.store.snapshot();
    this.accountId = data.settings.defaultAccountId ?? data.accounts.find((account) => !account.archived)?.id ?? "";
    if (transaction) {
      this.showAdvanced = true;
      this.type = transaction.type;
      this.date = transaction.date;
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
        this.category = transaction.category ?? "";
      }
    }
  }

  onOpen(): void { this.render(); }

  private render(): void {
    const accounts = this.plugin.store.snapshot().accounts;
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.transaction ? "Edit transaction" : "Add transaction" });
    if (this.showAdvanced) {
      new Setting(this.contentEl).setName("Type").addDropdown((dropdown) => dropdown.addOptions(Object.fromEntries(TRANSACTION_TYPES.map((type) => [type, transactionLabel(type)]))).setValue(this.type).onChange((value) => { this.type = value as TransactionType; this.render(); }));
      const dateSetting = new Setting(this.contentEl).setName("Date").addText((text) => text.setValue(this.date).onChange((value) => this.date = value));
      dateSetting.controlEl.querySelector("input")?.setAttribute("type", "date");
    }

    if (this.type === "transfer" || this.type === "card-payment") this.renderTransferFields(accounts);
    else this.renderSimpleFields(accounts);

    if (this.showAdvanced) {
      new Setting(this.contentEl).setName("Note (optional)").addTextArea((text) => text.setPlaceholder("Add details").setValue(this.note).onChange((value) => this.note = value));
    }
    const advancedButton = this.contentEl.createEl("button", {
      text: this.showAdvanced ? "Hide advanced options" : "Advanced options",
      cls: "obsidian-finance-advanced-toggle"
    });
    advancedButton.addEventListener("click", () => { this.showAdvanced = !this.showAdvanced; this.render(); });
    const footer = this.contentEl.createDiv({ cls: "modal-button-container" });
    footer.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    footer.createEl("button", { text: this.transaction ? "Save changes" : "Add transaction", cls: "mod-cta" }).addEventListener("click", () => void this.save());
  }

  private renderSimpleFields(accounts: Account[]): void {
    const currentAccountIds = new Set(!this.transaction || isTransferTransaction(this.transaction) ? [] : [this.transaction.accountId]);
    const options = accountOptions(accounts, (account) => this.type !== "income" || account.kind !== "credit-card", currentAccountIds);
    if (!options[this.accountId]) this.accountId = Object.keys(options)[0] ?? "";
    const account = accounts.find((item) => item.id === this.accountId);
    const locale = this.plugin.store.snapshot().settings.locale;
    const amountSetting = new Setting(this.contentEl)
      .setName(`Amount${account ? ` (${account.currency})` : ""}`)
      .setDesc(account ? amountDescription(this.amount, account.currency, locale) : "Select an account.");
    amountSetting.addText((text) => text.setPlaceholder("1,000,000").setValue(this.amount).onChange((value) => {
      const grouped = groupAmountInput(value);
      this.amount = grouped;
      if (grouped !== value) text.setValue(grouped);
      if (account) amountSetting.setDesc(amountDescription(grouped, account.currency, locale));
    }));
    new Setting(this.contentEl).setName("Description (optional)").addText((text) => text.setPlaceholder("Coffee, groceries, salary…").setValue(this.payee).onChange((value) => this.payee = value));
    new Setting(this.contentEl).setName("Account").addDropdown((dropdown) => dropdown.addOptions(options).setValue(this.accountId).onChange((value) => { this.accountId = value; this.render(); }));
    if (this.showAdvanced) {
      new Setting(this.contentEl).setName("Category (optional)").addText((text) => text.setPlaceholder("Groceries").setValue(this.category).onChange((value) => this.category = value));
    }
  }

  private renderTransferFields(accounts: Account[]): void {
    const currentAccountIds = new Set(this.transaction && isTransferTransaction(this.transaction) ? [this.transaction.fromAccountId, this.transaction.toAccountId] : []);
    const sourceOptions = accountOptions(accounts, (account) => account.kind !== "credit-card", currentAccountIds);
    const destinationOptions = accountOptions(accounts, (account) => this.type === "card-payment" ? account.kind === "credit-card" : account.kind !== "credit-card", currentAccountIds);
    if (!sourceOptions[this.fromAccountId]) this.fromAccountId = Object.keys(sourceOptions)[0] ?? "";
    if (!destinationOptions[this.toAccountId] || this.toAccountId === this.fromAccountId) this.toAccountId = Object.keys(destinationOptions).find((key) => key !== this.fromAccountId) ?? "";
    new Setting(this.contentEl).setName("From account").addDropdown((dropdown) => dropdown.addOptions(sourceOptions).setValue(this.fromAccountId).onChange((value) => { this.fromAccountId = value; this.render(); }));
    new Setting(this.contentEl).setName("To account").addDropdown((dropdown) => dropdown.addOptions(destinationOptions).setValue(this.toAccountId).onChange((value) => { this.toAccountId = value; this.render(); }));
    const from = accounts.find((account) => account.id === this.fromAccountId);
    const to = accounts.find((account) => account.id === this.toAccountId);
    const locale = this.plugin.store.snapshot().settings.locale;
    const sourceAmountSetting = new Setting(this.contentEl)
      .setName(`Amount sent${from ? ` (${from.currency})` : ""}`)
      .setDesc(from ? amountDescription(this.amount, from.currency, locale) : "Select a source account.");
    sourceAmountSetting.addText((text) => text.setPlaceholder("1,000,000").setValue(this.amount).onChange((value) => {
      const grouped = groupAmountInput(value);
      this.amount = grouped;
      if (grouped !== value) text.setValue(grouped);
      if (from) sourceAmountSetting.setDesc(amountDescription(grouped, from.currency, locale));
    }));
    if (from && to && from.currency !== to.currency) {
      const destinationAmountSetting = new Setting(this.contentEl)
        .setName(`Amount received (${to.currency})`)
        .setDesc(amountDescription(this.destinationAmount, to.currency, locale));
      destinationAmountSetting.addText((text) => text.setPlaceholder("1,000,000").setValue(this.destinationAmount).onChange((value) => {
        const grouped = groupAmountInput(value);
        this.destinationAmount = grouped;
        if (grouped !== value) text.setValue(grouped);
        destinationAmountSetting.setDesc(amountDescription(grouped, to.currency, locale));
      }));
    }
  }

  private async save(): Promise<void> {
    if (this.isSaving) return;
    this.isSaving = true;
    try {
      const data = this.plugin.store.snapshot();
      const now = new Date().toISOString();
      const common = { id: this.transaction?.id ?? id(), type: this.type, date: this.date, note: this.note.trim() || undefined, createdAt: this.transaction?.createdAt ?? now, updatedAt: now };
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
        result = { ...common, type: this.type, accountId: account.id, amountMinor: parseMoney(this.amount, account.currency), currency: account.currency, payee: this.payee.trim() || undefined, category: this.category.trim() || undefined };
      }
      await this.plugin.store.upsertTransaction(result);
      new Notice("Transaction saved");
      this.close();
    } catch (error) {
      this.isSaving = false;
      new Notice(error instanceof Error ? error.message : "Could not save transaction");
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
    const normalizedQuery = query.trim().toLowerCase();
    return [...data.transactions]
      .sort((first, second) => second.date.localeCompare(first.date) || second.updatedAt.localeCompare(first.updatedAt))
      .filter((transaction) => {
        if (!normalizedQuery) return true;
        const accountNames = isTransferTransaction(transaction)
          ? data.accounts.filter((account) => account.id === transaction.fromAccountId || account.id === transaction.toAccountId).map((account) => account.name)
          : [data.accounts.find((account) => account.id === transaction.accountId)?.name ?? ""];
        const details = isTransferTransaction(transaction) ? [] : [transaction.payee ?? "", transaction.category ?? ""];
        return [transaction.date, transaction.type, transaction.note ?? "", ...accountNames, ...details]
          .some((value) => value.toLowerCase().includes(normalizedQuery));
      });
  }

  renderSuggestion(transaction: FinanceTransaction, element: HTMLElement): void {
    const data = this.plugin.store.snapshot();
    const accountName = isTransferTransaction(transaction)
      ? `${data.accounts.find((account) => account.id === transaction.fromAccountId)?.name ?? "Unknown"} → ${data.accounts.find((account) => account.id === transaction.toAccountId)?.name ?? "Unknown"}`
      : data.accounts.find((account) => account.id === transaction.accountId)?.name ?? "Unknown";
    const amount = isTransferTransaction(transaction)
      ? formatMoney(transaction.sourceAmountMinor, transaction.sourceCurrency, data.settings.locale)
      : formatMoney(transaction.amountMinor, transaction.currency, data.settings.locale);
    element.createDiv({ text: `${transactionLabel(transaction.type)} · ${amount}` });
    element.createEl("small", { text: `${transaction.date} · ${accountName}` });
  }

  onChooseSuggestion(transaction: FinanceTransaction): void {
    this.editor.replaceSelection(transactionReference(transaction.id));
  }
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
    const accountItems = [
      {
        name: "Add an account",
        desc: "Store only a nickname and optional last four digits for cards.",
        render: (setting: Setting) => {
          setting.addButton((button) => button.setButtonText("Add account").setCta().onClick(() => {
            this.plugin.openAccountModal(undefined, () => this.refreshSettingsTab());
          }));
        }
      },
      ...data.accounts.map((account) => ({
        name: account.name,
        desc: `${account.kind} · ${account.currency}${account.archived ? " · archived" : ""}`,
        render: (setting: Setting) => {
          setting.addButton((button) => button.setIcon("pencil").setTooltip("Edit account").onClick(() => {
            this.plugin.openAccountModal(account, () => this.refreshSettingsTab());
          }));
          if (!account.archived) {
            setting.addButton((button) => button.setIcon("archive").setTooltip("Archive account").onClick(async () => {
              await this.plugin.store.archiveAccount(account.id);
              this.refreshSettingsTab();
            }));
          }
        }
      }))
    ];

    return [
      {
        name: "Default currency",
        desc: "Used when creating a new account. Reports remain separated by currency.",
        render: (setting: Setting) => {
          setting.addDropdown((dropdown) => dropdown.addOptions(currencyOptions()).setValue(data.settings.defaultCurrency).onChange(async (value) => {
            await this.plugin.store.updateSettings({ defaultCurrency: value });
          }));
        }
      },
      {
        name: "Display locale",
        desc: "Controls number and currency formatting.",
        render: (setting: Setting) => {
          setting.addText((text) => text.setValue(data.settings.locale).onChange(async (value) => {
            if (!value.trim()) return;
            try { await this.plugin.store.updateSettings({ locale: normalizeLocale(value) }); }
            catch (error) { new Notice(error instanceof Error ? error.message : "Invalid locale"); }
          }));
        }
      },
      {
        name: "First day of week",
        render: (setting: Setting) => {
          setting.addDropdown((dropdown) => dropdown.addOptions({ "0": "Sunday", "1": "Monday", "6": "Saturday" }).setValue(String(data.settings.weekStartsOn)).onChange(async (value) => {
            await this.plugin.store.updateSettings({ weekStartsOn: Number(value) });
          }));
        }
      },
      {
        name: "Default account",
        render: (setting: Setting) => {
          setting.addDropdown((dropdown) => dropdown.addOption("", "None").addOptions(accountOptions(data.accounts)).setValue(data.settings.defaultAccountId ?? "").onChange(async (value) => {
            await this.plugin.store.updateSettings({ defaultAccountId: value || undefined });
          }));
        }
      },
      { type: "group", heading: "Accounts", items: accountItems },
      {
        type: "group",
        heading: "Privacy",
        items: [{
          name: "Local-only storage",
          desc: "Finance data stays in this plugin's data.json. The plugin has no network or clipboard access. Never enter full card numbers, security codes, PINs, or banking passwords."
        }]
      }
    ];
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const data = this.plugin.store.snapshot();
    new Setting(containerEl).setName("Default currency").setDesc("Used when creating a new account. Reports remain separated by currency.").addDropdown((dropdown) => dropdown.addOptions(currencyOptions()).setValue(data.settings.defaultCurrency).onChange(async (value) => { await this.plugin.store.updateSettings({ defaultCurrency: value }); }));
    new Setting(containerEl).setName("Display locale").setDesc("Controls number and currency formatting.").addText((text) => text.setValue(data.settings.locale).onChange(async (value) => {
      if (!value.trim()) return;
      try { await this.plugin.store.updateSettings({ locale: normalizeLocale(value) }); }
      catch (error) { new Notice(error instanceof Error ? error.message : "Invalid locale"); }
    }));
    new Setting(containerEl).setName("First day of week").addDropdown((dropdown) => dropdown.addOptions({ "0": "Sunday", "1": "Monday", "6": "Saturday" }).setValue(String(data.settings.weekStartsOn)).onChange(async (value) => { await this.plugin.store.updateSettings({ weekStartsOn: Number(value) }); }));
    new Setting(containerEl).setName("Default account").addDropdown((dropdown) => dropdown.addOption("", "None").addOptions(accountOptions(data.accounts)).setValue(data.settings.defaultAccountId ?? "").onChange(async (value) => { await this.plugin.store.updateSettings({ defaultAccountId: value || undefined }); }));

    new Setting(containerEl).setName("Accounts").setHeading();
    new Setting(containerEl).setName("Add an account").setDesc("Store only a nickname and optional last four digits for cards.").addButton((button) => button.setButtonText("Add account").setCta().onClick(() => this.plugin.openAccountModal(undefined, () => this.display())));
    for (const account of data.accounts) {
      const setting = new Setting(containerEl).setName(account.name).setDesc(`${account.kind} · ${account.currency}${account.archived ? " · archived" : ""}`);
      setting.addButton((button) => button.setIcon("pencil").setTooltip("Edit account").onClick(() => this.plugin.openAccountModal(account, () => this.display())));
      if (!account.archived) setting.addButton((button) => button.setIcon("archive").setTooltip("Archive account").onClick(async () => { await this.plugin.store.archiveAccount(account.id); this.display(); }));
    }

    new Setting(containerEl).setName("Privacy").setHeading();
    containerEl.createEl("p", { text: "All finance data is stored locally in this plugin's data.json inside your vault configuration. The plugin has no network or clipboard access. Do not enter full card numbers, security codes, PINs, or banking passwords." });
  }

}

export default class VaultFinancePlugin extends Plugin {
  store = new FinanceStore((data) => this.saveData(data));

  async onload(): Promise<void> {
    try {
      this.store.load(await this.loadData());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Finance data could not be loaded.";
      new Notice(message, 0);
      throw error;
    }
    this.registerView(DASHBOARD_VIEW, (leaf) => new DashboardView(leaf, this));
    this.registerView(HISTORY_VIEW, (leaf) => new HistoryView(leaf, this));
    this.addRibbonIcon("circle-dollar-sign", "Open finance dashboard", () => void this.activateView(DASHBOARD_VIEW));
    this.addCommand({ id: "open-dashboard", name: "Open dashboard", callback: () => void this.activateView(DASHBOARD_VIEW) });
    this.addCommand({ id: "open-history", name: "Open transaction history", callback: () => void this.activateView(HISTORY_VIEW) });
    this.addCommand({ id: "add-transaction", name: "Add transaction", callback: () => this.openTransactionModal() });
    this.addCommand({ id: "add-account", name: "Add account", callback: () => this.openAccountModal() });
    this.addCommand({
      id: "insert-transaction-reference",
      name: "Insert transaction reference",
      editorCallback: (editor) => new TransactionReferenceModal(this.app, this, editor).open()
    });
    this.registerMarkdownCodeBlockProcessor("vault-finance", (source, element) => this.renderTransactionReference(source, element));
    this.addSettingTab(new FinanceSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      if (this.app.workspace.getLeavesOfType(DASHBOARD_VIEW).length === 0) {
        void this.activateView(DASHBOARD_VIEW, false);
      }
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

  openAccountModal(account?: Account, afterSave?: () => void): void {
    new AccountModal(this.app, this, account, afterSave).open();
  }

  accountHasTransactions(accountId: string): boolean {
    return this.store.snapshot().transactions.some((transaction) => isTransferTransaction(transaction)
      ? transaction.fromAccountId === accountId || transaction.toAccountId === accountId
      : transaction.accountId === accountId);
  }

  renderTransactionReference(source: string, element: HTMLElement): void {
    element.empty();
    const transactionId = source.split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("transaction:"))
      ?.slice("transaction:".length).trim();
    const data = this.store.snapshot();
    const transaction = data.transactions.find((item) => item.id === transactionId);
    if (!transaction) {
      element.createDiv({ text: "Transaction reference not found.", cls: "obsidian-finance-muted" });
      return;
    }

    const card = element.createDiv({ cls: "obsidian-finance-card obsidian-finance-reference" });
    const heading = card.createDiv({ cls: "obsidian-finance-reference-heading" });
    heading.createEl("strong", { text: transactionLabel(transaction.type) });
    heading.createSpan({ text: transaction.date });
    const accountName = isTransferTransaction(transaction)
      ? `${data.accounts.find((account) => account.id === transaction.fromAccountId)?.name ?? "Unknown"} → ${data.accounts.find((account) => account.id === transaction.toAccountId)?.name ?? "Unknown"}`
      : data.accounts.find((account) => account.id === transaction.accountId)?.name ?? "Unknown";
    card.createDiv({ text: accountName, cls: "obsidian-finance-muted" });
    const amount = isTransferTransaction(transaction)
      ? formatMoney(transaction.sourceAmountMinor, transaction.sourceCurrency, data.settings.locale)
      : formatMoney(transaction.amountMinor, transaction.currency, data.settings.locale);
    card.createEl("strong", { text: amount });
    if (!isTransferTransaction(transaction) && transaction.payee) card.createDiv({ text: transaction.payee });
    const editButton = card.createEl("button", { text: "Edit transaction" });
    editButton.addEventListener("click", () => this.openTransactionModal(transaction));
  }

  insertTransactionReference(transactionId: string): void {
    const editor = this.app.workspace.activeEditor?.editor;
    if (!editor) {
      new Notice("Open a note in editing mode before inserting a transaction reference");
      return;
    }
    editor.replaceSelection(transactionReference(transactionId));
    new Notice("Transaction reference inserted");
  }

  renderTransactionRow(container: HTMLElement, transaction: FinanceTransaction): void {
    const data = this.store.snapshot();
    const row = container.createDiv({ cls: "obsidian-finance-transaction" });
    const main = row.createDiv({ cls: "obsidian-finance-transaction-main" });
    main.createEl("strong", { text: transactionLabel(transaction.type) });
    const accounts = isTransferTransaction(transaction)
      ? `${data.accounts.find((account) => account.id === transaction.fromAccountId)?.name ?? "Unknown"} → ${data.accounts.find((account) => account.id === transaction.toAccountId)?.name ?? "Unknown"}`
      : data.accounts.find((account) => account.id === transaction.accountId)?.name ?? "Unknown";
    main.createSpan({ text: `${transaction.date} · ${accounts}${!isTransferTransaction(transaction) && transaction.payee ? ` · ${transaction.payee}` : ""}` });
    const amount = row.createDiv({ cls: "obsidian-finance-transaction-amount" });
    if (isTransferTransaction(transaction)) {
      amount.createEl("strong", { text: formatMoney(transaction.sourceAmountMinor, transaction.sourceCurrency, data.settings.locale) });
      if (transaction.sourceCurrency !== transaction.destinationCurrency) amount.createEl("small", { text: `→ ${formatMoney(transaction.destinationAmountMinor, transaction.destinationCurrency, data.settings.locale)}` });
    } else amount.createEl("strong", { text: formatMoney(transaction.amountMinor, transaction.currency, data.settings.locale) });
    const buttons = row.createDiv({ cls: "obsidian-finance-row-actions" });
    addIconButton(buttons, "link", "Insert transaction reference", () => this.insertTransactionReference(transaction.id));
    addIconButton(buttons, "pencil", "Edit transaction", () => this.openTransactionModal(transaction));
    addIconButton(buttons, "trash-2", "Delete transaction", () => {
      const modal = new ConfirmModal(this.app, "Delete transaction?", "This action cannot be undone.", async () => {
        await this.store.deleteTransaction(transaction.id);
        new Notice("Transaction deleted");
      });
      modal.open();
    });
  }
}

class ConfirmModal extends Modal {
  constructor(app: App, private readonly title: string, private readonly message: string, private readonly confirm: () => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.createEl("h2", { text: this.title });
    this.contentEl.createEl("p", { text: this.message });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    buttons.createEl("button", { text: "Delete", cls: "mod-warning" }).addEventListener("click", () => void this.confirm().then(() => this.close()));
  }
}
