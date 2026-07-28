import { calendarMonthRange } from "@/domain/calendar";
import type { Category, FinanceTransaction, MonthlyBudget } from "@/types";
import { isTransferTransaction } from "@/types";

export interface BudgetStatus {
  budget: MonthlyBudget;
  spentMinor: number;
  remainingMinor: number;
  overspent: boolean;
}

export function safeAddMinor(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) throw new Error("Money amount is outside the supported range.");
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new Error("Money total is outside the supported range.");
  return total;
}

export function validateBudget(budget: MonthlyBudget, categories: Category[]): void {
  if (!budget.id) throw new Error("Budget identity is required.");
  const category = categories.find((item) => item.id === budget.categoryId);
  if (!category || category.type !== "expense") throw new Error("An expense category is required for a budget.");
  if (!/^[A-Z]{3}$/.test(budget.currency)) throw new Error("Budget currency is invalid.");
  calendarMonthRange(budget.month, budget.calendar);
  if (!Number.isSafeInteger(budget.amountMinor) || budget.amountMinor <= 0) throw new Error("Budget must be greater than zero.");
}

export function budgetStatus(budget: MonthlyBudget, transactions: FinanceTransaction[]): BudgetStatus {
  const [start, end] = calendarMonthRange(budget.month, budget.calendar);
  let spentMinor = 0;
  for (const transaction of transactions) {
    if (isTransferTransaction(transaction) || transaction.currency !== budget.currency || transaction.categoryId !== budget.categoryId) continue;
    if (transaction.date < start || transaction.date > end) continue;
    if (transaction.type === "expense") spentMinor = safeAddMinor(spentMinor, transaction.amountMinor);
    if (transaction.type === "refund") spentMinor = safeAddMinor(spentMinor, -transaction.amountMinor);
  }
  const remainingMinor = safeAddMinor(budget.amountMinor, -spentMinor);
  return { budget, spentMinor, remainingMinor, overspent: remainingMinor < 0 };
}

export function budgetStatuses(budgets: MonthlyBudget[], transactions: FinanceTransaction[], calendar: MonthlyBudget["calendar"], month: string): BudgetStatus[] {
  return budgets
    .filter((budget) => budget.calendar === calendar && budget.month === month)
    .map((budget) => budgetStatus(budget, transactions));
}
