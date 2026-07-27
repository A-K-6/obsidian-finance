export type AccountKind = "cash" | "bank" | "credit-card";
export type SimpleTransactionType = "expense" | "income" | "refund";
export type TransferTransactionType = "transfer" | "card-payment";
export type TransactionType = SimpleTransactionType | TransferTransactionType;

export interface FinanceSettings {
  locale: string;
  weekStartsOn: number;
  defaultCurrency: string;
  defaultAccountId?: string;
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
  createdAt: string;
  updatedAt: string;
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
  category?: string;
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
  transactions: FinanceTransaction[];
}

export const DEFAULT_DATA: FinanceData = {
  schemaVersion: 1,
  settings: {
    locale: "en-US",
    weekStartsOn: 1,
    defaultCurrency: "USD"
  },
  accounts: [],
  transactions: []
};

export function isTransferTransaction(transaction: FinanceTransaction): transaction is TransferTransaction {
  return transaction.type === "transfer" || transaction.type === "card-payment";
}
