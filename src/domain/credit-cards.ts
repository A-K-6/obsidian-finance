import {
  addCalendarPeriod,
  calendarDateParts,
  compareCanonicalDates,
  isCanonicalDate,
  parseCalendarDate
} from "@/domain/calendar";
import type { Account, CalendarSystem } from "@/types";

export interface CardPaymentReminder {
  accountId: string;
  dueDate: string;
  amountMinor: number;
  status: "upcoming" | "due" | "overdue";
}

function validateOptionalNonNegativeInteger(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`${label} must be zero or greater.`);
}

function validateOptionalDay(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 31)) throw new Error(`${label} must be between 1 and 31.`);
}

export function validateCreditCardFields(account: Account): void {
  if (account.kind !== "credit-card") {
    if (account.lastFour !== undefined || account.creditLimitMinor !== undefined || account.statementClosingDay !== undefined
      || account.paymentDueDay !== undefined || account.statementBalanceMinor !== undefined || account.minimumPaymentMinor !== undefined
      || account.statementDueDate !== undefined) {
      throw new Error("Credit-card fields are only available for credit-card accounts.");
    }
    return;
  }
  if (account.lastFour !== undefined && !/^\d{4}$/.test(account.lastFour)) throw new Error("Last four digits must contain exactly four numbers.");
  if (account.creditLimitMinor !== undefined && (!Number.isSafeInteger(account.creditLimitMinor) || account.creditLimitMinor <= 0)) throw new Error("Credit limit must be greater than zero.");
  validateOptionalDay(account.statementClosingDay, "Statement closing day");
  validateOptionalDay(account.paymentDueDay, "Payment due day");
  validateOptionalNonNegativeInteger(account.statementBalanceMinor, "Statement balance");
  validateOptionalNonNegativeInteger(account.minimumPaymentMinor, "Minimum payment");
  if (account.statementBalanceMinor !== undefined && account.minimumPaymentMinor !== undefined
    && account.minimumPaymentMinor > account.statementBalanceMinor) throw new Error("Minimum payment cannot exceed the statement balance.");
  if (account.statementDueDate !== undefined && !isCanonicalDate(account.statementDueDate)) throw new Error("Statement due date is invalid.");
}

export function creditCardUtilization(currentOwedMinor: number, creditLimitMinor?: number): number | undefined {
  if (creditLimitMinor === undefined) return undefined;
  if (!Number.isSafeInteger(currentOwedMinor) || !Number.isSafeInteger(creditLimitMinor) || creditLimitMinor <= 0) throw new Error("Credit-card utilization values are invalid.");
  return Math.max(0, currentOwedMinor) / creditLimitMinor;
}

function clampedCalendarDate(year: number, month: number, day: number, calendar: CalendarSystem): string {
  for (let candidateDay = Math.min(day, 31); candidateDay >= 1; candidateDay -= 1) {
    try {
      return parseCalendarDate(`${year}-${month}-${candidateDay}`, calendar);
    } catch {
      // Try the preceding day for short months.
    }
  }
  throw new Error("Card schedule date is invalid.");
}

export function nextCardScheduleDate(today: string, day: number, calendar: CalendarSystem): string {
  validateOptionalDay(day, "Schedule day");
  const parts = calendarDateParts(today, calendar);
  let candidate = clampedCalendarDate(parts.year, parts.month, day, calendar);
  if (compareCanonicalDates(candidate, today) >= 0) return candidate;
  const currentMonthStart = clampedCalendarDate(parts.year, parts.month, 1, calendar);
  const nextMonth = calendarDateParts(addCalendarPeriod(currentMonthStart, "monthly", 1, calendar), calendar);
  candidate = clampedCalendarDate(nextMonth.year, nextMonth.month, day, calendar);
  return candidate;
}

export function cardPaymentReminders(accounts: Account[], today: string, throughDate: string, calendar: CalendarSystem): CardPaymentReminder[] {
  const reminders: CardPaymentReminder[] = [];
  for (const account of accounts) {
    if (account.kind !== "credit-card" || account.archived) continue;
    const amountMinor = account.minimumPaymentMinor ?? account.statementBalanceMinor ?? 0;
    if (amountMinor <= 0) continue;

    if (account.statementDueDate !== undefined) {
      if (compareCanonicalDates(account.statementDueDate, throughDate) <= 0) {
        reminders.push({
          accountId: account.id,
          dueDate: account.statementDueDate,
          amountMinor,
          status: compareCanonicalDates(account.statementDueDate, today) < 0 ? "overdue" : account.statementDueDate === today ? "due" : "upcoming"
        });
      }
      continue;
    }

    if (account.paymentDueDay === undefined) continue;
    const parts = calendarDateParts(today, calendar);
    const currentMonthDue = clampedCalendarDate(parts.year, parts.month, account.paymentDueDay, calendar);
    const previousMonth = calendarDateParts(addCalendarPeriod(clampedCalendarDate(parts.year, parts.month, 1, calendar), "monthly", -1, calendar), calendar);
    const dueDate = compareCanonicalDates(currentMonthDue, today) <= 0
      ? currentMonthDue
      : clampedCalendarDate(previousMonth.year, previousMonth.month, account.paymentDueDay, calendar);
    if (compareCanonicalDates(dueDate, throughDate) > 0) continue;
    reminders.push({
      accountId: account.id,
      dueDate,
      amountMinor,
      status: compareCanonicalDates(dueDate, today) < 0 ? "overdue" : dueDate === today ? "due" : "upcoming"
    });
  }
  return reminders;
}
