import { describe, expect, it } from "vitest";
import { cardPaymentReminders, creditCardUtilization, nextCardScheduleDate, validateCreditCardFields } from "@/domain/credit-cards";
import type { Account } from "@/types";

const timestamp = "2026-01-01T00:00:00.000Z";
const card: Account = {
  id: "card", name: "Card", kind: "credit-card", currency: "USD", openingBalanceMinor: 0, archived: false,
  creditLimitMinor: 100_000, statementClosingDay: 31, paymentDueDay: 15,
  statementBalanceMinor: 40_000, minimumPaymentMinor: 5_000, createdAt: timestamp, updatedAt: timestamp
};

describe("credit cards", () => {
  it("derives utilization from current amount owed and credit limit", () => {
    expect(creditCardUtilization(25_000, card.creditLimitMinor)).toBe(0.25);
    expect(creditCardUtilization(-500, card.creditLimitMinor)).toBe(0);
  });

  it("validates card-only fields and payment values", () => {
    expect(() => validateCreditCardFields({ ...card, minimumPaymentMinor: 50_000 })).toThrow("cannot exceed");
    expect(() => validateCreditCardFields({ ...card, paymentDueDay: 32 })).toThrow("between 1 and 31");
    expect(() => validateCreditCardFields({ ...card, kind: "bank" })).toThrow("only available");
  });

  it("clamps schedule days and produces due, overdue, and upcoming reminders", () => {
    expect(nextCardScheduleDate("2026-02-01", 31, "gregorian")).toBe("2026-02-28");
    expect(cardPaymentReminders([card], "2026-07-15", "2026-07-15", "gregorian")[0]?.status).toBe("due");
    expect(cardPaymentReminders([card], "2026-07-16", "2026-07-16", "gregorian")[0]?.status).toBe("overdue");
    expect(cardPaymentReminders([card], "2026-07-01", "2026-07-31", "gregorian")[0]).toMatchObject({ dueDate: "2026-07-15", amountMinor: 5_000, status: "upcoming" });
  });

  it("uses Persian calendar schedule months", () => {
    expect(nextCardScheduleDate("2026-03-21", 31, "persian")).toBe("2026-04-20");
  });
});
