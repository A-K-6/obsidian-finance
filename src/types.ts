export type AccountKind = "cash" | "bank" | "credit-card";
export type SimpleTransactionType = "expense" | "income" | "refund";
export type TransferTransactionType = "transfer" | "card-payment";
export type TransactionType = SimpleTransactionType | TransferTransactionType;
export type CategoryType = "expense" | "income";
export type CalendarSystem = "gregorian" | "persian";
export type RecurrenceFrequency = "weekly" | "monthly" | "yearly";
export type ScheduledItemKind = "bill" | "subscription" | "recurring-income";
export type RecurringResolutionAction = "recorded" | "skipped" | "rescheduled";

export interface FinanceSettings {
  locale: string;
  weekStartsOn: number;
  defaultCurrency: string;
  defaultAccountId?: string;
  calendar: CalendarSystem;
}

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  currency: string;
  openingBalanceMinor: number;
  archived: boolean;
  lastFour?: string;
  creditLimitMinor?: number;
  statementClosingDay?: number;
  paymentDueDay?: number;
  statementBalanceMinor?: number;
  minimumPaymentMinor?: number;
  statementDueDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: string;
  name: string;
  type: CategoryType;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MonthlyBudget {
  id: string;
  categoryId: string;
  currency: string;
  calendar: CalendarSystem;
  month: string;
  amountMinor: number;
  createdAt: string;
  updatedAt: string;
}

export interface RecurringRule {
  id: string;
  kind: ScheduledItemKind;
  type: CategoryType;
  frequency: RecurrenceFrequency;
  interval: number;
  accountId: string;
  amountMinor: number;
  currency: string;
  categoryId: string;
  description: string;
  anchorDueDate: string;
  nextDueDate: string;
  endDate?: string;
  occurrenceLimit?: number;
  reminderLeadDays: number;
  note?: string;
  calendar: CalendarSystem;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RecurringResolution {
  id: string;
  ruleId: string;
  occurrenceDate: string;
  action: RecurringResolutionAction;
  transactionId?: string;
  rescheduledToDate?: string;
  resolvedAt: string;
}

interface TransactionBase {
  id: string;
  date: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SimpleTransaction extends TransactionBase {
  type: SimpleTransactionType;
  accountId: string;
  amountMinor: number;
  currency: string;
  categoryId?: string;
  payee?: string;
}

export interface TransferTransaction extends TransactionBase {
  type: TransferTransactionType;
  fromAccountId: string;
  toAccountId: string;
  sourceAmountMinor: number;
  sourceCurrency: string;
  destinationAmountMinor: number;
  destinationCurrency: string;
}

export type FinanceTransaction = SimpleTransaction | TransferTransaction;

export interface FinanceData {
  schemaVersion: number;
  settings: FinanceSettings;
  accounts: Account[];
  categories: Category[];
  budgets: MonthlyBudget[];
  recurringRules: RecurringRule[];
  recurringResolutions: RecurringResolution[];
  transactions: FinanceTransaction[];
}

export const DEFAULT_DATA: FinanceData = {
  schemaVersion: 3,
  settings: {
    locale: "en-US",
    weekStartsOn: 1,
    defaultCurrency: "USD",
    calendar: "gregorian"
  },
  accounts: [],
  categories: [],
  budgets: [],
  recurringRules: [],
  recurringResolutions: [],
  transactions: []
};

export function isTransferTransaction(transaction: FinanceTransaction): transaction is TransferTransaction {
  return transaction.type === "transfer" || transaction.type === "card-payment";
}

export function categoryTypeForTransaction(type: SimpleTransactionType): CategoryType {
  return type === "income" ? "income" : "expense";
}
