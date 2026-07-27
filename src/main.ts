import {
  App,
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
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
  summarize,
  transactionLabel,
  weekRange
} from "@/domain/finance";
import { FinanceStore } from "@/store/finance-store";

const DASHBOARD_VIEW = "obsidian-finance-dashboard";
const HISTORY_VIEW = "obsidian-finance-history";
const TRANSACTION_TYPES: TransactionType[] = ["expense", "income", "refund", "transfer", "card-payment"];

function id(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
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

abstract class FinanceView extends ItemView {
  private unsubscribe?: () => void;

  constructor(leaf: WorkspaceLeaf, protected readonly plugin: ObsidianFinancePlugin) {
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
    const accountSection = container.createDiv({ cls: "obsidian-finance-section" });
    accountSection.createEl("h3", { text: "Accounts" });
    const accountGrid = accountSection.createDiv({ cls: "obsidian-finance-grid" });
    for (const account of data.accounts.filter((item) => !item.archived)) {
      const balance = balances.get(account.id) ?? 0;
      const card = accountGrid.createDiv({ cls: "obsidian-finance-card" });
      card.createEl("span", { text: account.kind === "credit-card" ? "Credit card" : account.kind, cls: "obsidian-finance-eyebrow" });
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
      block.createEl("span", { text: `Spent ${formatMoney(summary.expenses - summary.refunds, currency, locale)}` });
      block.createEl("span", { text: `Income ${formatMoney(summary.income, currency, locale)}` });
      block.createEl("span", { text: `Net ${formatMoney(summary.net, currency, locale)}`, cls: summary.net < 0 ? "obsidian-finance-negative" : "obsidian-finance-positive" });
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

  constructor(app: App, private readonly plugin: ObsidianFinancePlugin, private readonly account?: Account, private readonly afterSave?: () => void) {
    super(app);
    this.currency = plugin.store.snapshot().settings.defaultCurrency;
    if (account) {
      this.name = account.name;
      this.kind = account.kind;
      this.currency = account.currency;
      this.openingBalance = minorToInput(account.openingBalanceMinor, account.currency);
      this.lastFour = account.lastFour ?? "";
      this.creditLimit = account.creditLimitMinor === undefined ? "" : minorToInput(account.creditLimitMinor, account.currency);
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
    new Setting(this.contentEl).setName(this.kind === "credit-card" ? "Opening amount owed" : "Opening balance").addText((text) => text.setValue(this.openingBalance).onChange((value) => this.openingBalance = value));
    if (this.kind === "credit-card") {
      new Setting(this.contentEl).setName("Last four digits (optional)").setDesc("Never enter the full card number, PIN, or CVV.").addText((text) => text.setPlaceholder("1234").setValue(this.lastFour).onChange((value) => this.lastFour = value));
      new Setting(this.contentEl).setName("Credit limit (optional)").addText((text) => text.setValue(this.creditLimit).onChange((value) => this.creditLimit = value));
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

  constructor(app: App, private readonly plugin: ObsidianFinancePlugin, private readonly transaction?: FinanceTransaction) {
    super(app);
    const data = plugin.store.snapshot();
    this.accountId = data.settings.defaultAccountId ?? data.accounts.find((account) => !account.archived)?.id ?? "";
    if (transaction) {
      this.type = transaction.type;
      this.date = transaction.date;
      this.note = transaction.note ?? "";
      if (isTransferTransaction(transaction)) {
        this.fromAccountId = transaction.fromAccountId;
        this.toAccountId = transaction.toAccountId;
        this.amount = minorToInput(transaction.sourceAmountMinor, transaction.sourceCurrency);
        this.destinationAmount = minorToInput(transaction.destinationAmountMinor, transaction.destinationCurrency);
      } else {
        this.accountId = transaction.accountId;
        this.amount = minorToInput(transaction.amountMinor, transaction.currency);
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
    new Setting(this.contentEl).setName("Type").addDropdown((dropdown) => dropdown.addOptions(Object.fromEntries(TRANSACTION_TYPES.map((type) => [type, transactionLabel(type)]))).setValue(this.type).onChange((value) => { this.type = value as TransactionType; this.render(); }));
    const dateSetting = new Setting(this.contentEl).setName("Date").addText((text) => text.setValue(this.date).onChange((value) => this.date = value));
    dateSetting.controlEl.querySelector("input")?.setAttribute("type", "date");

    if (this.type === "transfer" || this.type === "card-payment") this.renderTransferFields(accounts);
    else this.renderSimpleFields(accounts);

    new Setting(this.contentEl).setName("Note (optional)").addTextArea((text) => text.setPlaceholder("Add details").setValue(this.note).onChange((value) => this.note = value));
    const footer = this.contentEl.createDiv({ cls: "modal-button-container" });
    footer.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    footer.createEl("button", { text: "Save transaction", cls: "mod-cta" }).addEventListener("click", () => void this.save());
  }

  private renderSimpleFields(accounts: Account[]): void {
    const currentAccountIds = new Set(!this.transaction || isTransferTransaction(this.transaction) ? [] : [this.transaction.accountId]);
    const options = accountOptions(accounts, (account) => this.type !== "income" || account.kind !== "credit-card", currentAccountIds);
    if (!options[this.accountId]) this.accountId = Object.keys(options)[0] ?? "";
    new Setting(this.contentEl).setName("Account").addDropdown((dropdown) => dropdown.addOptions(options).setValue(this.accountId).onChange((value) => { this.accountId = value; this.render(); }));
    const account = accounts.find((item) => item.id === this.accountId);
    new Setting(this.contentEl).setName(`Amount${account ? ` (${account.currency})` : ""}`).addText((text) => text.setPlaceholder("0.00").setValue(this.amount).onChange((value) => this.amount = value));
    new Setting(this.contentEl).setName("Payee (optional)").addText((text) => text.setPlaceholder("Store or employer").setValue(this.payee).onChange((value) => this.payee = value));
    new Setting(this.contentEl).setName("Category (optional)").addText((text) => text.setPlaceholder("Groceries").setValue(this.category).onChange((value) => this.category = value));
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
    new Setting(this.contentEl).setName(`Amount sent${from ? ` (${from.currency})` : ""}`).addText((text) => text.setValue(this.amount).onChange((value) => this.amount = value));
    if (from && to && from.currency !== to.currency) {
      new Setting(this.contentEl).setName(`Amount received (${to.currency})`).setDesc("Enter the actual converted amount. No live exchange rate is used.").addText((text) => text.setValue(this.destinationAmount).onChange((value) => this.destinationAmount = value));
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

class FinanceSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ObsidianFinancePlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Obsidian Finance" });
    const data = this.plugin.store.snapshot();
    new Setting(containerEl).setName("Default currency").setDesc("Used when creating a new account. Reports remain separated by currency.").addDropdown((dropdown) => dropdown.addOptions(currencyOptions()).setValue(data.settings.defaultCurrency).onChange(async (value) => { await this.plugin.store.updateSettings({ defaultCurrency: value }); }));
    new Setting(containerEl).setName("Display locale").setDesc("Controls number and currency formatting, for example en-US or de-DE.").addText((text) => text.setValue(data.settings.locale).onChange(async (value) => {
      if (!value.trim()) return;
      try { await this.plugin.store.updateSettings({ locale: normalizeLocale(value) }); }
      catch (error) { new Notice(error instanceof Error ? error.message : "Invalid locale"); }
    }));
    new Setting(containerEl).setName("First day of week").addDropdown((dropdown) => dropdown.addOptions({ "0": "Sunday", "1": "Monday", "6": "Saturday" }).setValue(String(data.settings.weekStartsOn)).onChange(async (value) => { await this.plugin.store.updateSettings({ weekStartsOn: Number(value) }); }));
    new Setting(containerEl).setName("Default account").addDropdown((dropdown) => dropdown.addOption("", "None").addOptions(accountOptions(data.accounts)).setValue(data.settings.defaultAccountId ?? "").onChange(async (value) => { await this.plugin.store.updateSettings({ defaultAccountId: value || undefined }); }));

    containerEl.createEl("h3", { text: "Accounts" });
    new Setting(containerEl).setName("Add an account").setDesc("Store only a nickname and optional last four digits for cards.").addButton((button) => button.setButtonText("Add account").setCta().onClick(() => this.plugin.openAccountModal(undefined, () => this.display())));
    for (const account of data.accounts) {
      const setting = new Setting(containerEl).setName(account.name).setDesc(`${account.kind} · ${account.currency}${account.archived ? " · archived" : ""}`);
      setting.addButton((button) => button.setIcon("pencil").setTooltip("Edit account").onClick(() => this.plugin.openAccountModal(account, () => this.display())));
      if (!account.archived) setting.addButton((button) => button.setIcon("archive").setTooltip("Archive account").onClick(async () => { await this.plugin.store.archiveAccount(account.id); this.display(); }));
    }

    containerEl.createEl("h3", { text: "Privacy" });
    containerEl.createEl("p", { text: "All finance data is stored locally in this plugin's data.json inside your vault configuration. The plugin has no network access. Do not enter full card numbers, CVVs, PINs, or banking passwords." });
  }
}

export default class ObsidianFinancePlugin extends Plugin {
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
    this.addSettingTab(new FinanceSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(DASHBOARD_VIEW);
    this.app.workspace.detachLeavesOfType(HISTORY_VIEW);
  }

  async activateView(type: string): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(type)[0];
    const leaf = existing ?? this.app.workspace.getLeaf(true);
    if (!existing) await leaf.setViewState({ type, active: true });
    this.app.workspace.revealLeaf(leaf);
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

  renderTransactionRow(container: HTMLElement, transaction: FinanceTransaction): void {
    const data = this.store.snapshot();
    const row = container.createDiv({ cls: "obsidian-finance-transaction" });
    const main = row.createDiv({ cls: "obsidian-finance-transaction-main" });
    main.createEl("strong", { text: transactionLabel(transaction.type) });
    const accounts = isTransferTransaction(transaction)
      ? `${data.accounts.find((account) => account.id === transaction.fromAccountId)?.name ?? "Unknown"} → ${data.accounts.find((account) => account.id === transaction.toAccountId)?.name ?? "Unknown"}`
      : data.accounts.find((account) => account.id === transaction.accountId)?.name ?? "Unknown";
    main.createEl("span", { text: `${transaction.date} · ${accounts}${!isTransferTransaction(transaction) && transaction.payee ? ` · ${transaction.payee}` : ""}` });
    const amount = row.createDiv({ cls: "obsidian-finance-transaction-amount" });
    if (isTransferTransaction(transaction)) {
      amount.createEl("strong", { text: formatMoney(transaction.sourceAmountMinor, transaction.sourceCurrency, data.settings.locale) });
      if (transaction.sourceCurrency !== transaction.destinationCurrency) amount.createEl("small", { text: `→ ${formatMoney(transaction.destinationAmountMinor, transaction.destinationCurrency, data.settings.locale)}` });
    } else amount.createEl("strong", { text: formatMoney(transaction.amountMinor, transaction.currency, data.settings.locale) });
    const buttons = row.createDiv({ cls: "obsidian-finance-row-actions" });
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
