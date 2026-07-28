import { addCalendarPeriod, addCanonicalDays, compareCanonicalDates, isCanonicalDate } from "@/domain/calendar";
import type { Account, Category, RecurringResolution, RecurringRule, SimpleTransaction } from "@/types";

export interface RecurringOccurrence {
  ruleId: string;
  date: string;
  due: boolean;
}

export function recurringOccurrenceKey(ruleId: string, occurrenceDate: string): string {
  return `${ruleId}:${occurrenceDate}`;
}

export function completedOccurrenceCount(ruleId: string, resolutions: RecurringResolution[]): number {
  return resolutions.filter((resolution) => resolution.ruleId === ruleId
    && (resolution.action === "recorded" || resolution.action === "skipped")).length;
}

export function isRecurringRuleCompleted(rule: RecurringRule, resolutions: RecurringResolution[]): boolean {
  if (rule.occurrenceLimit !== undefined && completedOccurrenceCount(rule.id, resolutions) >= rule.occurrenceLimit) return true;
  return rule.endDate !== undefined && compareCanonicalDates(rule.nextDueDate, rule.endDate) > 0;
}

export function validateRecurringRule(rule: RecurringRule, accounts: Account[], categories: Category[]): void {
  if (!rule.id) throw new Error("Scheduled item identity is required.");
  if (!( ["bill", "subscription", "recurring-income"] as const).includes(rule.kind)) throw new Error("Scheduled item kind is invalid.");
  const expectedType = rule.kind === "recurring-income" ? "income" : "expense";
  if (rule.type !== expectedType) throw new Error(`${rule.kind} must use the ${expectedType} transaction type.`);
  if (!( ["weekly", "monthly", "yearly"] as const).includes(rule.frequency)) throw new Error("Scheduled frequency is invalid.");
  if (!Number.isSafeInteger(rule.interval) || rule.interval <= 0) throw new Error("Scheduled interval must be a positive safe integer.");
  if (!Number.isSafeInteger(rule.reminderLeadDays) || rule.reminderLeadDays < 0) throw new Error("Reminder lead days must be a nonnegative safe integer.");
  if (rule.occurrenceLimit !== undefined && (!Number.isSafeInteger(rule.occurrenceLimit) || rule.occurrenceLimit <= 0)) {
    throw new Error("Occurrence limit must be a positive safe integer.");
  }
  const account = accounts.find((item) => item.id === rule.accountId);
  if (!account) throw new Error("Scheduled item account is required.");
  if (account.archived && rule.active) throw new Error("An archived account cannot be used for an active scheduled item.");
  if (account.currency !== rule.currency) throw new Error("Scheduled item currency must match its account.");
  if (rule.type === "income" && account.kind === "credit-card") throw new Error("Recurring income cannot use a credit card.");
  const category = categories.find((item) => item.id === rule.categoryId);
  if (!category || category.type !== rule.type) throw new Error(`A matching ${rule.type} category is required.`);
  if (category.archived && rule.active) throw new Error("An archived category cannot be used for an active scheduled item.");
  if (!Number.isSafeInteger(rule.amountMinor) || rule.amountMinor <= 0) throw new Error("Scheduled amount must be greater than zero.");
  if (!rule.description.trim()) throw new Error("Scheduled item description is required.");
  if (!isCanonicalDate(rule.anchorDueDate) || !isCanonicalDate(rule.nextDueDate)) throw new Error("Scheduled dates must be valid Gregorian dates.");
  if (compareCanonicalDates(rule.nextDueDate, rule.anchorDueDate) < 0) throw new Error("Next due date cannot be before the anchor date.");
  if (rule.endDate !== undefined) {
    if (!isCanonicalDate(rule.endDate)) throw new Error("Scheduled end date must be a valid Gregorian date.");
    if (compareCanonicalDates(rule.endDate, rule.anchorDueDate) < 0) throw new Error("Scheduled end date cannot be before the cadence anchor.");
  }
}

export function nextOccurrenceDate(
  rule: Pick<RecurringRule, "anchorDueDate" | "frequency" | "interval" | "calendar">,
  afterDate: string
): string {
  if (!isCanonicalDate(afterDate) || !isCanonicalDate(rule.anchorDueDate)) throw new Error("Scheduled dates must be valid Gregorian dates.");
  if (!Number.isSafeInteger(rule.interval) || rule.interval <= 0) throw new Error("Scheduled interval must be a positive safe integer.");
  for (let count = 1; count <= 20_000; count += 1) {
    const periods = count * rule.interval;
    if (!Number.isSafeInteger(periods)) break;
    const candidate = addCalendarPeriod(rule.anchorDueDate, rule.frequency, periods, rule.calendar);
    if (compareCanonicalDates(candidate, afterDate) > 0) return candidate;
  }
  throw new Error("Scheduled date is outside the supported range.");
}

export function actionableOccurrences(
  rules: RecurringRule[],
  resolutions: RecurringResolution[],
  today: string
): RecurringOccurrence[] {
  if (!isCanonicalDate(today)) throw new Error("Today's date is invalid.");
  const occurrences: RecurringOccurrence[] = [];
  for (const rule of rules) {
    if (!rule.active || isRecurringRuleCompleted(rule, resolutions)) continue;
    const actionableThrough = addCanonicalDays(today, rule.reminderLeadDays);
    if (compareCanonicalDates(rule.nextDueDate, actionableThrough) <= 0) {
      occurrences.push({ ruleId: rule.id, date: rule.nextDueDate, due: compareCanonicalDates(rule.nextDueDate, today) <= 0 });
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
