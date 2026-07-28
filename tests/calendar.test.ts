import { describe, expect, it } from "vitest";
import { addCalendarPeriod, calendarMonthRange, formatCalendarDate, parseCalendarDate, weekRangeForDate } from "@/domain/calendar";
import { nextOccurrenceDate } from "@/domain/recurrence";

describe("calendar domain", () => {
  it("converts Nowruz between canonical Gregorian and Persian display dates", () => {
    expect(formatCalendarDate("2026-03-21", "persian")).toBe("1405-01-01");
    expect(parseCalendarDate("1405-01-01", "persian")).toBe("2026-03-21");
  });

  it("uses exact Persian leap and non-leap month ranges", () => {
    expect(calendarMonthRange("1399-12", "persian")).toEqual(["2021-02-19", "2021-03-20"]);
    expect(calendarMonthRange("1400-12", "persian")).toEqual(["2022-02-20", "2022-03-20"]);
  });

  it("clamps Gregorian and Persian month ends without timestamp arithmetic", () => {
    expect(addCalendarPeriod("2026-01-31", "monthly", 1, "gregorian")).toBe("2026-02-28");
    const shahrivarEnd = parseCalendarDate("1404-06-31", "persian");
    expect(formatCalendarDate(addCalendarPeriod(shahrivarEnd, "monthly", 1, "persian"), "persian")).toBe("1404-07-30");
    const leapEsfand = parseCalendarDate("1399-12-30", "persian");
    expect(formatCalendarDate(addCalendarPeriod(leapEsfand, "yearly", 1, "persian"), "persian")).toBe("1400-12-29");
  });

  it("keeps recurrence anchored after a clamped month", () => {
    const rule = { anchorDueDate: "2026-01-31", frequency: "monthly" as const, calendar: "gregorian" as const };
    expect(nextOccurrenceDate(rule, "2026-02-28")).toBe("2026-03-31");
  });

  it("calculates weeks with date-only arithmetic", () => {
    expect(weekRangeForDate("2026-07-08", 1)).toEqual(["2026-07-06", "2026-07-12"]);
  });
});
