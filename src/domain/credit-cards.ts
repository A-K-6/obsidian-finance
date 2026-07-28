import { addCalendarPeriod, calendarDateParts, compareCanonicalDates, parseCalendarDate } from "@/domain/calendar";
import type { Account, CalendarSystem } from "@/types";

export interface CardPaymentReminder {
  accountId: string;
  dueDate: string;
  amountMinor: number;
  status: "overdue" | "due" | "upcoming";
}

const CARD_ONLY_FIELDS: (keyof Account)[] = [
  "lastFour",
  "creditLimitMinor",
  "statementClosingDay",
  "paymentDueDay",
  "statementBalanceMinor",
  "minimumPaymentMinor"
];

function validateOptionalPositiveInteger(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`${label} must be greater than zero.`);
}

function validateOptionalDay(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 31)) throw new Error(`${label} must be between 1 and 31.`);
}

export function validateCreditCardFields(account: Account): void {
  if (account.kind !== "credit-card") {
    if (CARD_ONLY_FIELDS.some((field) => account[field] !== undefined)) throw new Error("Credit-card fields are only available for credit-card accounts.");
    return;
  }
  validateOptionalPositiveInteger(account.creditLimitMinor, "Credit limit");
  validateOptionalDay(account.statementClosingDay, "Statement closing day");
  validateOptionalDay(account.paymentDueDay, "Payment due day");
  if (account.statementBalanceMinor !== undefined && (!Number.isSafeInteger(account.statementBalanceMinor) || account.statementBalanceMinor < 0)) {
    throw new Error("Statement balance must be zero or greater.");
  }
  if (account.minimumPaymentMinor !== undefined && (!Number.isSafeInteger(account.minimumPaymentMinor) || account.minimumPaymentMinor < 0)) {
    throw new Error("Minimum payment must be zero or greater.");
  }
  if (account.minimumPaymentMinor !== undefined && account.statementBalanceMinor !== undefined && account.minimumPaymentMinor > account.statementBalanceMinor) {
    throw new Error("Minimum payment cannot exceed the statement balance.");
  }
}

export function creditCardUtilization(currentOwedMinor: number, creditLimitMinor?: number): number | undefined {
  if (creditLimitMinor === undefined) return undefined;
  if (!Number.isSafeInteger(currentOwedMinor) || !Number.isSafeInteger(creditLimitMinor) || creditLimitMinor <= 0) {
    throw new Error("Credit-card utilization values are invalid.");
  }
  return Math.max(0, currentOwedMinor) / creditLimitMinor;
}

function scheduledDayInMonth(referenceDate: string, day: number, calendar: CalendarSystem): string {
  const { year, month } = calendarDateParts(referenceDate, calendar);
  for (let candidateDay = day; candidateDay >= 1; candidateDay -= 1) {
    try {
      return parseCalendarDate(`${year}-${String(month).padStart(2, "0")}-${String(candidateDay).padStart(2, "0")}`, calendar);
    } catch {
      // Clamp a configured day such as 31 to the final day of a shorter month.
    }
  }
  throw new Error("Could not calculate the card schedule date.");
}

export function nextCardScheduleDate(today: string, day: number, calendar: CalendarSystem): string {
  const thisMonth = scheduledDayInMonth(today, day, calendar);
  if (compareCanonicalDates(thisMonth, today) >= 0) return thisMonth;
  const firstOfNextMonth = addCalendarPeriod(parseCalendarDate(`${calendarDateParts(today, calendar).year}-${String(calendarDateParts(today, calendar).month).padStart(2, "0")}-01`, calendar), "monthly", 1, calendar);
  return scheduledDayInMonth(firstOfNextMonth, day, calendar);
}

export function cardPaymentReminders(accounts: Account[], today: string, throughDate: string, calendar: CalendarSystem): CardPaymentReminder[] {
  const reminders: CardPaymentReminder[] = [];
  for (const account of accounts) {
    if (account.archived || account.kind !== "credit-card" || account.paymentDueDay === undefined || !account.statementBalanceMinor) continue;
    const thisMonthDue = scheduledDayInMonth(today, account.paymentDueDay, calendar);
    const dueDate = compareCanonicalDates(thisMonthDue, today) < 0 ? thisMonthDue : nextCardScheduleDate(today, account.paymentDueDay, calendar);
    if (compareCanonicalDates(dueDate, throughDate) > 0 && compareCanonicalDates(dueDate, today) >= 0) continue;
    const comparison = compareCanonicalDates(dueDate, today);
    reminders.push({
      accountId: account.id,
      dueDate,
      amountMinor: account.minimumPaymentMinor ?? account.statementBalanceMinor,
      status: comparison < 0 ? "overdue" : comparison === 0 ? "due" : "upcoming"
    });
  }
  return reminders.sort((left, right) => left.dueDate.localeCompare(right.dueDate) || left.accountId.localeCompare(right.accountId));
}
