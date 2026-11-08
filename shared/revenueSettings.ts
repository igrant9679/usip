/**
 * A workspace's revenue settings (audit 2026-10-20, F29 and R41): the month
 * its fiscal year starts, and the currency its amounts are shown in.
 *
 * Both are stored on workspace_settings (migration 0403). A workspace that
 * has never set them reads January and USD — calendar quarters and dollars,
 * which is what every screen showed before — so nothing moves until an admin
 * chooses.
 *
 * A fiscal year is named by the calendar year it ENDS in (a year starting in
 * July 2026 is FY2027), the common convention; with a January start that is
 * simply the calendar year.
 */
export const DEFAULT_FISCAL_YEAR_START_MONTH = 1;
export const DEFAULT_WORKSPACE_CURRENCY = "USD";

/** The currencies offered in Settings: ISO 4217 codes every browser formats. */
export const CURRENCY_OPTIONS = [
  "USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK",
  "JPY", "INR", "SGD", "HKD", "ZAR", "BRL", "MXN", "AED", "ILS", "PLN",
] as const;

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

export function isSupportedCurrency(code: string | null | undefined): boolean {
  return !!code && (CURRENCY_OPTIONS as readonly string[]).includes(code);
}

/** A stored month, or January when unset or out of range. */
export function safeFiscalStart(m: unknown): number {
  const n = Number(m);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : DEFAULT_FISCAL_YEAR_START_MONTH;
}

export function safeCurrency(code: unknown): string {
  return typeof code === "string" && isSupportedCurrency(code) ? code : DEFAULT_WORKSPACE_CURRENCY;
}
