/**
 * Calendar helpers for the real journeys. Dates are business dates in America/Sao_Paulo, the
 * same calendar the API and the screens use, so expectations do not depend on the runner's zone.
 */
const businessTimeZone = 'America/Sao_Paulo';

/** Today's date (YYYY-MM-DD) in America/Sao_Paulo. */
export function businessToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: businessTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Adds calendar days to a date-only value. */
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Monday of the Monday–Sunday week that contains the date. */
export function mondayOf(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return addDays(date, day === 0 ? -6 : 1 - day);
}

/** Monday of the current business week in America/Sao_Paulo. */
export function currentWeekMonday(now: Date = new Date()): string {
  return mondayOf(businessToday(now));
}

/** The date as the screens print it, for example "Nov 23, 2026". */
export function displayedDate(date: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' })
    .format(new Date(`${date}T00:00:00.000Z`));
}
