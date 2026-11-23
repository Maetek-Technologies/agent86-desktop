// Formatting for the basic catalog's functions, in the `en-US` locale every reference SDK defaults
// to: numbers and currency as `Intl.NumberFormat` writes them, dates by TR35 pattern, plural
// categories, and the string forms JavaScript gives values. Ported from agent86-ui's `format.rs`
// rather than calling `Intl`, so the output is the same in every WebView and matches agent86's own
// runtime digit for digit.

import { isObject } from "./json.ts";
import type { Json } from "./types.ts";

/** A number as JavaScript's `String(number)` writes it (`-0` is `0`). */
export function numberString(value: number): string {
  return String(value);
}

/** A value as `String(value)` writes it, with objects and arrays as JSON and `null` as `""` (the
 * specification's type conversion rule). */
export function toString(value: Json | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** A value as `Number(value)` reads it (`NaN` when it is not a number). */
export function toNumber(value: Json | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const s = value.trim();
    if (s === "") return 0;
    if (s === "Infinity" || s === "+Infinity") return Infinity;
    if (s === "-Infinity") return -Infinity;
    if (/^[0-9+\-.eE]+$/.test(s)) return Number(s);
    const hex = /^0[xX]\+?([0-9a-fA-F]+)$/.exec(s);
    if (hex?.[1] !== undefined) {
      const n = parseInt(hex[1], 16);
      return n >= 2 ** 64 ? NaN : n;
    }
    return NaN;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return 0;
    if (value.length === 1) return toNumber(toString(value[0]));
    return NaN;
  }
  if (isObject(value)) return NaN;
  return NaN;
}

/** A finite, nonzero number's shortest decimal digits and the decimal exponent of its first
 * digit (`1234.5` is `["12345", 3]`). */
function decompose(value: number): [digits: string, exponent: number] {
  const text = Math.abs(value).toExponential();
  const [mantissa = "0", exponent = "0"] = text.split("e");
  const digits = mantissa.replace(".", "").replace(/0+$/, "");
  return [digits === "" ? "0" : digits, Number(exponent)];
}

/** Round to `places` fraction digits half away from zero (as `Intl` does), from the number's
 * shortest representation rather than its binary value (`1.005` rounds to `1.01`). */
function fixed(value: number, places: number): string {
  // Zero, and an infinity (which has no digits), print as zero.
  if (value === 0 || !Number.isFinite(value)) return places > 0 ? `0.${"0".repeat(places)}` : "0";
  const [digits, exponent] = decompose(value);
  const point = exponent + 1;
  const int: number[] = [];
  let frac: number[] = [];
  [...digits].forEach((d, i) => (i < point ? int : frac).push(Number(d)));
  if (point > digits.length) int.push(...new Array<number>(point - digits.length).fill(0));
  if (point < 0) frac = [...new Array<number>(-point).fill(0), ...frac];
  if (int.length === 0) int.push(0);
  const roundUp = (frac[places] ?? 0) >= 5;
  while (frac.length < places) frac.push(0);
  frac = frac.slice(0, places);
  if (roundUp) {
    let carry = true;
    const all = [...int, ...frac];
    for (let i = all.length - 1; i >= 0 && carry; i--) {
      if (all[i] === 9) {
        all[i] = 0;
      } else {
        all[i] = (all[i] ?? 0) + 1;
        carry = false;
      }
    }
    if (carry) all.unshift(1);
    const split = all.length - frac.length;
    int.splice(0, int.length, ...all.slice(0, split));
    frac = all.slice(split);
  }
  const whole = int.join("").replace(/^0+/, "") || "0";
  return frac.length === 0 ? whole : `${whole}.${frac.join("")}`;
}

function group(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The digits of a number as `Intl.NumberFormat("en-US")` writes them, without sign: `decimals`
 * fixes the fraction digits (else up to 3, trailing zeros dropped); grouping uses `,`. */
function digitsOf(value: number, decimals: number | null, grouping: boolean): string {
  let text: string;
  if (decimals !== null) {
    text = fixed(Math.abs(value), decimals);
  } else {
    text = fixed(Math.abs(value), 3);
    const [int = "0", frac] = text.split(".");
    if (frac !== undefined) {
      const trimmed = frac.replace(/0+$/, "");
      text = trimmed === "" ? int : `${int}.${trimmed}`;
    }
  }
  const [int = "0", frac] = text.split(".");
  const whole = grouping ? group(int) : int;
  return frac === undefined ? whole : `${whole}.${frac}`;
}

function negativeNonzero(value: number, decimals: number | null): boolean {
  return value < 0 && /[1-9]/.test(digitsOf(value, decimals, false));
}

/** `formatNumber`: `en-US` digits with grouping unless `grouping` is false. */
export function formatNumber(value: number, decimals: number | null, grouping: boolean): string {
  if (Number.isNaN(value)) return "";
  if (!Number.isFinite(value)) return value > 0 ? "∞" : "-∞";
  const sign = negativeNonzero(value, decimals) ? "-" : "";
  return `${sign}${digitsOf(value, decimals, grouping)}`;
}

/** The `en-US` symbol `Intl` uses for a currency, when it has one. */
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "CN¥",
  INR: "₹",
  KRW: "₩",
  CAD: "CA$",
  AUD: "A$",
  NZD: "NZ$",
  MXN: "MX$",
  BRL: "R$",
  HKD: "HK$",
  TWD: "NT$",
  ILS: "₪",
  VND: "₫",
  PHP: "₱",
  XAF: "FCFA",
  XCD: "EC$",
  XPF: "CFPF",
};

/** `formatCurrency`: the amount with the currency's `en-US` symbol, or its code and a no-break
 * space when it has none; 2 fraction digits unless `decimals` says otherwise. */
export function formatCurrency(
  value: number,
  currency: string,
  decimals: number | null,
  grouping: boolean,
): string {
  if (Number.isNaN(value)) return "";
  const code = currency.toUpperCase();
  const places = decimals ?? 2;
  const sign = negativeNonzero(value, places) ? "-" : "";
  const amount = digitsOf(value, places, grouping);
  const symbol = Object.hasOwn(CURRENCY_SYMBOLS, code) ? CURRENCY_SYMBOLS[code] : undefined;
  return symbol !== undefined ? `${sign}${symbol}${amount}` : `${sign}${code}\u00a0${amount}`;
}

/** The plural category of a number in `en`: `one` for 1, `other` otherwise, with the explicit
 * forms every SDK checks first (`zero` for 0, `one` for 1, `two` for 2) when given. */
export function pluralCategory(value: number, has: (key: string) => boolean): string {
  if (value === 0 && has("zero")) return "zero";
  if (value === 1 && has("one")) return "one";
  if (value === 2 && has("two")) return "two";
  if (value === 1) return "one";
  return "other";
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  nanos: number;
}

/** Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's `days_from_civil`), so
 * years before 100 and after 9999 need no `Date` quirks. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(days: number): [year: number, month: number, day: number] {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

const TIMESTAMP =
  /^([+-]?[0-9]{4,6})-([0-9]{2})-([0-9]{2})(?:[T ]([0-9]{2})(?::([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?$/;

/** Parse an ISO 8601 date or date-time: the wall-clock fields as written and the offset in
 * seconds (none is UTC). Fields that do not name a real date or time (`2026-02-30`) fail. */
function parseTimestamp(text: string): { wall: Wall; offset: number } | null {
  const caps = TIMESTAMP.exec(text.trim());
  if (!caps) return null;
  const field = (i: number) => Number(caps[i] ?? "0");
  const wall: Wall = {
    year: field(1),
    month: field(2),
    day: field(3),
    hour: field(4),
    minute: field(5),
    second: field(6),
    nanos: Number((caps[7] ?? "").slice(0, 9).padEnd(9, "0")),
  };
  // The civil range agent86's date library accepts.
  if (wall.year < -9999 || wall.year > 9999) return null;
  if (wall.month < 1 || wall.month > 12) return null;
  if (wall.day < 1 || wall.day > daysInMonth(wall.year, wall.month)) return null;
  if (wall.hour > 23 || wall.minute > 59 || wall.second > 59) return null;
  let offset = 0;
  const zone = caps[8];
  if (zone !== undefined && zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.replace(/[^0-9]/g, "");
    const hours = Number(digits.slice(0, 2));
    const minutes = Number(digits.slice(2));
    offset = sign * (hours * 3600 + minutes * 60);
    // The largest offset agent86's date library accepts, 25:59:59.
    if (Math.abs(offset) > 93_599) return null;
  }
  return { wall, offset };
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

const TOKENS = [
  "yyyy",
  "yy",
  "MMMM",
  "MMM",
  "MM",
  "M",
  "EEEE",
  "E",
  "dd",
  "d",
  "HH",
  "H",
  "hh",
  "h",
  "mm",
  "ss",
  "a",
];

/** `formatDate`: a TR35 pattern applied to the date as written (`yyyy yy MMMM MMM MM M EEEE E dd
 * d HH H hh h mm ss a`), or `ISO` for the instant in UTC with milliseconds. A value that does not
 * parse gives `""`. */
export function formatDate(value: Json | undefined, pattern: string): string {
  if (typeof value !== "string" || value === "") return "";
  const parsed = parseTimestamp(value);
  if (!parsed) return "";
  const { wall } = parsed;
  const days = daysFromCivil(wall.year, wall.month, wall.day);
  if (pattern === "ISO") {
    const seconds =
      days * 86400 + wall.hour * 3600 + wall.minute * 60 + wall.second - parsed.offset;
    const utcDays = Math.floor(seconds / 86400);
    const rest = seconds - utcDays * 86400;
    const [y, m, d] = civilFromDays(utcDays);
    const year = y < 0 ? `-${pad(-y, 4)}` : pad(y, 4);
    return `${year}-${pad(m)}-${pad(d)}T${pad(Math.floor(rest / 3600))}:${pad(Math.floor((rest % 3600) / 60))}:${pad(rest % 60)}.${pad(Math.floor(wall.nanos / 1_000_000), 3)}Z`;
  }
  const hour12 = wall.hour % 12 === 0 ? 12 : wall.hour % 12;
  const month = MONTHS[wall.month - 1] ?? "";
  // 1970-01-01 was a Thursday (index 3, Monday first).
  const weekday = WEEKDAYS[(((days + 3) % 7) + 7) % 7] ?? "";
  const piece = (token: string): string => {
    switch (token) {
      case "yyyy":
        return String(wall.year);
      case "yy":
        return pad(((wall.year % 100) + 100) % 100);
      case "MMMM":
        return month;
      case "MMM":
        return month.slice(0, 3);
      case "MM":
        return pad(wall.month);
      case "M":
        return String(wall.month);
      case "EEEE":
        return weekday;
      case "E":
        return weekday.slice(0, 3);
      case "dd":
        return pad(wall.day);
      case "d":
        return String(wall.day);
      case "HH":
        return pad(wall.hour);
      case "H":
        return String(wall.hour);
      case "hh":
        return pad(hour12);
      case "h":
        return String(hour12);
      case "mm":
        return pad(wall.minute);
      case "ss":
        return pad(wall.second);
      default:
        return wall.hour < 12 ? "AM" : "PM";
    }
  };
  let rest = pattern === "" ? "yyyy-MM-dd" : pattern;
  let out = "";
  scan: while (rest !== "") {
    for (const token of TOKENS) {
      if (rest.startsWith(token)) {
        out += piece(token);
        rest = rest.slice(token.length);
        continue scan;
      }
    }
    const c = String.fromCodePoint(rest.codePointAt(0) ?? 0);
    out += c;
    rest = rest.slice(c.length);
  }
  return out;
}
