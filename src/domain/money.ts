export interface CurrencyInfo {
  code: string;
  name: string;
  minorUnits: number;
}

export const CURRENCIES: readonly CurrencyInfo[] = [
  { code: "AED", name: "UAE Dirham", minorUnits: 2 },
  { code: "AUD", name: "Australian Dollar", minorUnits: 2 },
  { code: "BRL", name: "Brazilian Real", minorUnits: 2 },
  { code: "CAD", name: "Canadian Dollar", minorUnits: 2 },
  { code: "CHF", name: "Swiss Franc", minorUnits: 2 },
  { code: "CNY", name: "Chinese Yuan", minorUnits: 2 },
  { code: "DKK", name: "Danish Krone", minorUnits: 2 },
  { code: "EGP", name: "Egyptian Pound", minorUnits: 2 },
  { code: "EUR", name: "Euro", minorUnits: 2 },
  { code: "GBP", name: "British Pound", minorUnits: 2 },
  { code: "HKD", name: "Hong Kong Dollar", minorUnits: 2 },
  { code: "INR", name: "Indian Rupee", minorUnits: 2 },
  { code: "IQD", name: "Iraqi Dinar", minorUnits: 3 },
  { code: "IRR", name: "Iranian Rial", minorUnits: 2 },
  { code: "JPY", name: "Japanese Yen", minorUnits: 0 },
  { code: "KRW", name: "South Korean Won", minorUnits: 0 },
  { code: "KWD", name: "Kuwaiti Dinar", minorUnits: 3 },
  { code: "MXN", name: "Mexican Peso", minorUnits: 2 },
  { code: "NOK", name: "Norwegian Krone", minorUnits: 2 },
  { code: "NZD", name: "New Zealand Dollar", minorUnits: 2 },
  { code: "PKR", name: "Pakistani Rupee", minorUnits: 2 },
  { code: "QAR", name: "Qatari Riyal", minorUnits: 2 },
  { code: "SAR", name: "Saudi Riyal", minorUnits: 2 },
  { code: "SEK", name: "Swedish Krona", minorUnits: 2 },
  { code: "TRY", name: "Turkish Lira", minorUnits: 2 },
  { code: "USD", name: "US Dollar", minorUnits: 2 },
  { code: "ZAR", name: "South African Rand", minorUnits: 2 }
] as const;

export function currencyInfo(code: string): CurrencyInfo {
  return CURRENCIES.find((currency) => currency.code === code) ?? { code, name: code, minorUnits: 2 };
}

export function parseMoney(value: string, currency: string): number {
  const minor = parseMoneyValue(value, currency);
  if (minor <= 0) throw new Error("Amount must be greater than zero and within the supported range.");
  return minor;
}

export function parseNonNegativeMoney(value: string, currency: string): number {
  const minor = parseMoneyValue(value, currency);
  if (minor < 0) throw new Error("Amount must be zero or greater.");
  return minor;
}

function parseMoneyValue(value: string, currency: string): number {
  const trimmed = value.trim();
  const digits = currencyInfo(currency).minorUnits;
  const pattern = digits === 0 ? /^\d+$/ : new RegExp(`^\\d+(?:\\.\\d{1,${digits}})?$`);
  if (!pattern.test(trimmed)) {
    throw new Error(`Enter an amount with no more than ${digits} decimal place${digits === 1 ? "" : "s"}.`);
  }
  const [whole, fraction = ""] = trimmed.split(".");
  const minor = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0"));
  if (!Number.isSafeInteger(minor)) throw new Error("Amount is outside the supported range.");
  return minor;
}

export function formatMoney(minor: number, currency: string, locale = "en-US"): string {
  const digits = currencyInfo(currency).minorUnits;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(minor / 10 ** digits);
}

export function minorToInput(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor)) throw new Error("Amount is outside the supported range.");
  const digits = currencyInfo(currency).minorUnits;
  const factor = 10 ** digits;
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(minor);
  const whole = Math.floor(absolute / factor);
  if (digits === 0) return `${sign}${whole}`;
  return `${sign}${whole}.${String(absolute % factor).padStart(digits, "0")}`;
}

export function normalizeLocale(value: string): string {
  const locale = Intl.getCanonicalLocales(value.trim())[0];
  if (!locale) throw new Error("Enter a valid locale, for example en-US.");
  new Intl.NumberFormat(locale).format(0);
  return locale;
}
