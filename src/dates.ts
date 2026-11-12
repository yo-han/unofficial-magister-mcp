import { PublicError } from './errors.js';

/** A calendar date in YYYY-MM-DD form, interpreted in Europe/Amsterdam. */
export type CalendarDate = string;

export const SCHOOL_TIME_ZONE = 'Europe/Amsterdam';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_ABBR = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_YEAR = 1970;
const MAX_YEAR = 2999;

/** Longest inclusive range a range tool accepts. */
export const MAX_RANGE_DAYS = 31;
/** Inclusive length of a range tool's period when `to` is omitted. */
export const DEFAULT_RANGE_DAYS = 14;

const amsterdamParts = new Intl.DateTimeFormat('en-US', {
  timeZone: SCHOOL_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const amsterdamTime = new Intl.DateTimeFormat('nl-NL', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: SCHOOL_TIME_ZONE,
});

/** "08:30": the Amsterdam wall-clock time of an ISO instant. */
export function formatAmsterdamTime(instant: string): string {
  return amsterdamTime.format(new Date(instant));
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

function toUtcDate(date: CalendarDate): Date {
  const match = ISO_DATE.exec(date);
  if (!match) throw new PublicError('INVALID_ARGUMENT');
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function fromUtcDate(date: Date): CalendarDate {
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** The Amsterdam calendar date of an instant (ISO string or Date). */
export function amsterdamDateOf(instant: string | Date): CalendarDate {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  const parts = amsterdamParts.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  const utc = toUtcDate(date);
  utc.setUTCDate(utc.getUTCDate() + days);
  return fromUtcDate(utc);
}

function isRealCalendarDate(input: string): boolean {
  const match = ISO_DATE.exec(input);
  if (!match) return false;
  const year = Number(match[1]);
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  return fromUtcDate(toUtcDate(input)) === input;
}

/**
 * Resolves a tool date argument to an Amsterdam calendar date. Accepts "today",
 * "tomorrow", an English weekday name (next occurrence, a week ahead if it is
 * today) or a real YYYY-MM-DD date. Anything else is INVALID_ARGUMENT.
 */
export function resolveDate(input: string, now: Date): CalendarDate {
  const today = amsterdamDateOf(now);
  const lower = input.toLowerCase();
  if (lower === 'today') return today;
  if (lower === 'tomorrow') return addDays(today, 1);
  const targetDay = WEEKDAYS.indexOf(lower);
  if (targetDay !== -1) {
    const currentDay = toUtcDate(today).getUTCDay();
    let daysAhead = targetDay - currentDay;
    if (daysAhead <= 0) daysAhead += 7;
    return addDays(today, daysAhead);
  }
  if (isRealCalendarDate(input)) return input;
  throw new PublicError('INVALID_ARGUMENT');
}

function assertSupportedDate(date: CalendarDate): void {
  if (!isRealCalendarDate(date)) throw new PublicError('INVALID_ARGUMENT');
}

/**
 * Resolves an optional inclusive from/to pair to consecutive Amsterdam dates.
 * `from` defaults to today and `to` to from + 13 days. Both accept the same
 * aliases as resolveDate (each relative to today). A reversed range, a range
 * longer than MAX_RANGE_DAYS or an end outside the supported years is
 * INVALID_ARGUMENT.
 */
export function resolveRange(
  from: string | undefined,
  to: string | undefined,
  now: Date
): CalendarDate[] {
  const first = from === undefined ? amsterdamDateOf(now) : resolveDate(from, now);
  const last = to === undefined ? addDays(first, DEFAULT_RANGE_DAYS - 1) : resolveDate(to, now);
  assertSupportedDate(last);
  // YYYY-MM-DD with a four-digit year compares correctly as a string.
  if (first > last) throw new PublicError('INVALID_ARGUMENT');
  const dates: CalendarDate[] = [];
  for (let date = first; date <= last; date = addDays(date, 1)) {
    if (dates.length === MAX_RANGE_DAYS) throw new PublicError('INVALID_ARGUMENT');
    dates.push(date);
  }
  return dates;
}

/** "Thu Nov 12 2026", independent of the process time zone. */
export function formatDisplayDate(date: CalendarDate): string {
  const utc = toUtcDate(date);
  return `${WEEKDAY_ABBR[utc.getUTCDay()]} ${MONTH_ABBR[utc.getUTCMonth()]} ${pad(utc.getUTCDate())} ${utc.getUTCFullYear()}`;
}

/** Seven consecutive dates starting today in Amsterdam. */
export function weekRange(now: Date): CalendarDate[] {
  const today = amsterdamDateOf(now);
  return Array.from({ length: 7 }, (_, index) => addDays(today, index));
}
