import type { Account, FinanceTransaction, SimpleTransaction, TransactionType } from "@/types";
import { isTransferTransaction } from "@/types";

export interface CurrencySummary {
  income: number;
  expenses: number;
  refunds: number;
  net: number;
}

export function validateAccount(account: Account): void {
  if (!account.name.trim()) throw new Error("Account name is required.");
  if (!account.currency.trim()) throw new Error("Account currency is required.");
  if (!Number.isSafeInteger(account.openingBalanceMinor) || account.openingBalanceMinor < 0) {
    throw new Error("Opening balance must be zero or greater.");
  }
  if (account.lastFour && !/^\d{4}$/.test(account.lastFour)) throw new Error("Last four digits must contain exactly four numbers.");
  if (account.creditLimitMinor !== undefined && (!Number.isSafeInteger(account.creditLimitMinor) || account.creditLimitMinor <= 0)) {
    throw new Error("Credit limit must be greater than zero.");
  }
}

export function validateTransaction(transaction: FinanceTransaction, accounts: Account[], allowedArchivedAccountIds: ReadonlySet<string> = new Set()): void {
  if (!isValidLocalDate(transaction.date)) throw new Error("A valid transaction date is required.");
  if (isTransferTransaction(transaction)) {
    const from = accounts.find((account) => account.id === transaction.fromAccountId);
    const to = accounts.find((account) => account.id === transaction.toAccountId);
    if (!from || !to) throw new Error("Both transfer accounts are required.");
    if (from.id === to.id) throw new Error("Source and destination accounts must be different.");
    if ((from.archived && !allowedArchivedAccountIds.has(from.id)) || (to.archived && !allowedArchivedAccountIds.has(to.id))) {
      throw new Error("Archived accounts cannot receive new transactions.");
    }
    if (transaction.sourceCurrency !== from.currency || transaction.destinationCurrency !== to.currency) {
      throw new Error("Transfer currencies must match their accounts.");
    }
    if (transaction.sourceAmountMinor <= 0 || transaction.destinationAmountMinor <= 0) throw new Error("Transfer amounts must be greater than zero.");
    if (!Number.isSafeInteger(transaction.sourceAmountMinor) || !Number.isSafeInteger(transaction.destinationAmountMinor)) {
      throw new Error("Transfer amount is outside the supported range.");
    }
    if (transaction.type === "card-payment") {
      if (from.kind === "credit-card" || to.kind !== "credit-card") throw new Error("A card payment must go from a cash or bank account to a credit card.");
    } else if (from.kind === "credit-card" || to.kind === "credit-card") {
      throw new Error("Use Card payment for credit-card transfers.");
    }
    if (from.currency === to.currency && transaction.sourceAmountMinor !== transaction.destinationAmountMinor) {
      throw new Error("Same-currency transfers must use the same source and destination amount.");
    }
    return;
  }

  const account = accounts.find((candidate) => candidate.id === transaction.accountId);
  if (!account) throw new Error("Transaction account is required.");
  if (account.archived && !allowedArchivedAccountIds.has(account.id)) throw new Error("Archived accounts cannot receive new transactions.");
  if (account.currency !== transaction.currency) throw new Error("Transaction currency must match its account.");
  if (!Number.isSafeInteger(transaction.amountMinor) || transaction.amountMinor <= 0) throw new Error("Amount must be greater than zero.");
  if (transaction.type === "income" && account.kind === "credit-card") throw new Error("Income cannot be posted to a credit card. Use a refund or card payment.");
}

export function accountBalances(accounts: Account[], transactions: FinanceTransaction[]): Map<string, number> {
  const balances = new Map(accounts.map((account) => [account.id, account.openingBalanceMinor]));
  for (const transaction of transactions) {
    if (isTransferTransaction(transaction)) {
      const from = accounts.find((account) => account.id === transaction.fromAccountId);
      const to = accounts.find((account) => account.id === transaction.toAccountId);
      if (!from || !to) continue;
      balances.set(from.id, (balances.get(from.id) ?? 0) - transaction.sourceAmountMinor);
      const destinationChange = transaction.type === "card-payment" ? -transaction.destinationAmountMinor : transaction.destinationAmountMinor;
      balances.set(to.id, (balances.get(to.id) ?? 0) + destinationChange);
      continue;
    }
    const account = accounts.find((candidate) => candidate.id === transaction.accountId);
    if (!account) continue;
    const direction = simpleBalanceDirection(transaction, account);
    balances.set(account.id, (balances.get(account.id) ?? 0) + direction * transaction.amountMinor);
  }
  return balances;
}

export function netBalancesByCurrency(accounts: Account[], transactions: FinanceTransaction[]): Map<string, number> {
  const balances = accountBalances(accounts, transactions);
  const totals = new Map<string, number>();
  for (const account of accounts) {
    if (account.archived) continue;
    const balance = balances.get(account.id) ?? 0;
    const contribution = account.kind === "credit-card" ? -balance : balance;
    totals.set(account.currency, (totals.get(account.currency) ?? 0) + contribution);
  }
  return totals;
}

function simpleBalanceDirection(transaction: SimpleTransaction, account: Account): number {
  if (account.kind === "credit-card") return transaction.type === "expense" ? 1 : -1;
  return transaction.type === "expense" ? -1 : 1;
}

export function summarize(transactions: FinanceTransaction[], startDate: string, endDate: string): Map<string, CurrencySummary> {
  const result = new Map<string, CurrencySummary>();
  for (const transaction of transactions) {
    if (transaction.date < startDate || transaction.date > endDate || isTransferTransaction(transaction)) continue;
    const summary = result.get(transaction.currency) ?? { income: 0, expenses: 0, refunds: 0, net: 0 };
    if (transaction.type === "income") summary.income += transaction.amountMinor;
    if (transaction.type === "expense") summary.expenses += transaction.amountMinor;
    if (transaction.type === "refund") summary.refunds += transaction.amountMinor;
    summary.net = summary.income - summary.expenses + summary.refunds;
    result.set(transaction.currency, summary);
  }
  return result;
}

export function isValidLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

export function localDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function weekRange(now: Date, weekStartsOn: number): [string, string] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const distance = (start.getDay() - weekStartsOn + 7) % 7;
  start.setDate(start.getDate() - distance);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return [localDate(start), localDate(end)];
}

export function monthRange(now: Date): [string, string] {
  return [localDate(new Date(now.getFullYear(), now.getMonth(), 1)), localDate(new Date(now.getFullYear(), now.getMonth() + 1, 0))];
}

export function transactionLabel(type: TransactionType): string {
  return ({ expense: "Expense", income: "Income", refund: "Refund", transfer: "Transfer", "card-payment": "Card payment" })[type];
}
