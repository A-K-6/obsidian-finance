import { addCalendarPeriod, compareCanonicalDates, isCanonicalDate } from "@/domain/calendar";
import type { Account, Category, RecurringResolution, RecurringRule, SimpleTransaction } from "@/types";

export interface RecurringOccurrence {
  ruleId: string;
  date: string;
  due: boolean;
}

export function recurringOccurrenceKey(ruleId: string, occurrenceDate: string): string {
  return `${ruleId}:${occurrenceDate}`;
}

export function validateRecurringRule(rule: RecurringRule, accounts: Account[], categories: Category[]): void {
  if (!rule.id) throw new Error("Recurring rule identity is required.");
  const account = accounts.find((item) => item.id === rule.accountId);
  if (!account) throw new Error("Recurring account is required.");
  if (account.archived && rule.active) throw new Error("An archived account cannot be used for an active recurring rule.");
  if (account.currency !== rule.currency) throw new Error("Recurring currency must match its account.");
  if (rule.type === "income" && account.kind === "credit-card") throw new Error("Recurring income cannot use a credit card.");
  const category = categories.find((item) => item.id === rule.categoryId);
  if (!category || category.type !== rule.type) throw new Error(`A matching ${rule.type} category is required.`);
  if (!Number.isSafeInteger(rule.amountMinor) || rule.amountMinor <= 0) throw new Error("Recurring amount must be greater than zero.");
  if (!rule.description.trim()) throw new Error("Recurring description is required.");
  if (!isCanonicalDate(rule.anchorDueDate) || !isCanonicalDate(rule.nextDueDate)) throw new Error("Recurring dates must be valid Gregorian dates.");
  if (compareCanonicalDates(rule.nextDueDate, rule.anchorDueDate) < 0) throw new Error("Next due date cannot be before the anchor date.");
}

export function nextOccurrenceDate(rule: Pick<RecurringRule, "anchorDueDate" | "frequency" | "calendar">, afterDate: string): string {
  if (!isCanonicalDate(afterDate) || !isCanonicalDate(rule.anchorDueDate)) throw new Error("Recurring dates must be valid Gregorian dates.");
  for (let count = 1; count <= 20_000; count += 1) {
    const candidate = addCalendarPeriod(rule.anchorDueDate, rule.frequency, count, rule.calendar);
    if (compareCanonicalDates(candidate, afterDate) > 0) return candidate;
  }
  throw new Error("Recurring date is outside the supported range.");
}

export function upcomingOccurrences(
  rules: RecurringRule[],
  resolutions: RecurringResolution[],
  today: string,
  throughDate: string
): RecurringOccurrence[] {
  const resolved = new Set(resolutions.map((resolution) => recurringOccurrenceKey(resolution.ruleId, resolution.occurrenceDate)));
  const occurrences: RecurringOccurrence[] = [];
  for (const rule of rules.filter((item) => item.active)) {
    let date = rule.nextDueDate;
    for (let count = 0; count < 500 && compareCanonicalDates(date, throughDate) <= 0; count += 1) {
      if (!resolved.has(recurringOccurrenceKey(rule.id, date))) occurrences.push({ ruleId: rule.id, date, due: compareCanonicalDates(date, today) <= 0 });
      date = nextOccurrenceDate(rule, date);
    }
  }
  return occurrences.sort((left, right) => left.date.localeCompare(right.date) || left.ruleId.localeCompare(right.ruleId));
}

export function recurringTransactionForOccurrence(rule: RecurringRule, occurrenceDate: string, transactionId: string, timestamp: string): SimpleTransaction {
  if (!isCanonicalDate(occurrenceDate)) throw new Error("Occurrence date is invalid.");
  return {
    id: transactionId,
    type: rule.type,
    accountId: rule.accountId,
    amountMinor: rule.amountMinor,
    currency: rule.currency,
    categoryId: rule.categoryId,
    payee: rule.description,
    date: occurrenceDate,
    note: rule.note,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
