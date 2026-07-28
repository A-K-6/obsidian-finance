import {
  CalendarDate,
  GregorianCalendar,
  PersianCalendar,
  endOfMonth,
  getDayOfWeek,
  parseDate,
  toCalendar
} from "@internationalized/date";
import type { Calendar } from "@internationalized/date";
import type { CalendarSystem, RecurrenceFrequency } from "@/types";

const GREGORIAN = new GregorianCalendar();
const PERSIAN = new PersianCalendar();

function calendarFor(system: CalendarSystem): Calendar {
  return system === "persian" ? PERSIAN : GREGORIAN;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function calendarDateToCanonical(date: CalendarDate): string {
  return toCalendar(date, GREGORIAN).toString();
}

export function isCanonicalDate(value: string): boolean {
  try {
    return parseDate(value).toString() === value;
  } catch {
    return false;
  }
}

export function todayCanonical(now = new Date()): string {
  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  return `${year}-${month}-${day}`;
}

export function calendarDateParts(canonical: string, system: CalendarSystem): { year: number; month: number; day: number } {
  const date = toCalendar(parseDate(canonical), calendarFor(system));
  return { year: date.year, month: date.month, day: date.day };
}

export function formatCalendarDate(canonical: string, system: CalendarSystem): string {
  const { year, month, day } = calendarDateParts(canonical, system);
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function parseCalendarDate(value: string, system: CalendarSystem): string {
  const match = /^(\d{1,4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim());
  if (!match) throw new Error("Enter a date as YYYY-MM-DD.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  let date: CalendarDate;
  try {
    date = new CalendarDate(calendarFor(system), year, month, day);
  } catch {
    throw new Error("Enter a valid calendar date.");
  }
  if (date.year !== year || date.month !== month || date.day !== day) throw new Error("Enter a valid calendar date.");
  return calendarDateToCanonical(date);
}

export function calendarMonthKey(canonical: string, system: CalendarSystem): string {
  const { year, month } = calendarDateParts(canonical, system);
  return `${year}-${pad(month)}`;
}

export function calendarMonthRange(monthKey: string, system: CalendarSystem): [string, string] {
  const match = /^(\d{1,4})-(\d{1,2})$/.exec(monthKey.trim());
  if (!match) throw new Error("Enter a month as YYYY-MM.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  let start: CalendarDate;
  try {
    start = new CalendarDate(calendarFor(system), year, month, 1);
  } catch {
    throw new Error("Enter a valid calendar month.");
  }
  if (start.year !== year || start.month !== month) throw new Error("Enter a valid calendar month.");
  return [calendarDateToCanonical(start), calendarDateToCanonical(endOfMonth(start))];
}

export function addCalendarPeriod(canonical: string, frequency: RecurrenceFrequency, count = 1, system: CalendarSystem = "gregorian"): string {
  if (!Number.isInteger(count)) throw new Error("Recurrence interval must be a whole number.");
  const gregorian = parseDate(canonical);
  if (frequency === "weekly") return gregorian.add({ days: 7 * count }).toString();
  const date = toCalendar(gregorian, calendarFor(system));
  const next = frequency === "monthly" ? date.add({ months: count }) : date.add({ years: count });
  return calendarDateToCanonical(next);
}

export function weekRangeForDate(canonical: string, weekStartsOn: number): [string, string] {
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) throw new Error("First day of week is invalid.");
  const date = parseDate(canonical);
  const sundayBasedDay = getDayOfWeek(date, "en-US", "sun");
  const distance = (sundayBasedDay - weekStartsOn + 7) % 7;
  const start = date.subtract({ days: distance });
  return [start.toString(), start.add({ days: 6 }).toString()];
}

export function compareCanonicalDates(left: string, right: string): number {
  return parseDate(left).compare(parseDate(right));
}
