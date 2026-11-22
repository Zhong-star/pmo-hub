export const RESOURCE_ALLOCATION_TIME_ZONE = 'America/Sao_Paulo';

export type WeeklyHoursNormalization =
  | { value: number; error?: undefined }
  | { value: null; error: string };

/** Format an instant using the module's business timezone, regardless of browser locale. */
export function formatBusinessTimestamp(value: string | Date): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: RESOURCE_ALLOCATION_TIME_ZONE,
  }).format(typeof value === 'string' ? new Date(value) : value);
}

/** Return the ISO calendar date currently observed in São Paulo. */
export function businessDate(value: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: RESOURCE_ALLOCATION_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Calculate a future calendar date from an elapsed duration, then apply São Paulo's calendar. */
export function businessDateAfterHours(hours: number, from: Date = new Date()): string {
  return businessDate(new Date(from.getTime() + hours * 60 * 60 * 1000));
}

/** Format a date-only API value without shifting it into a neighboring calendar day. */
export function formatCalendarDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' })
    .format(new Date(`${value}T00:00:00.000Z`));
}

/** Validate the input cap before rounding, then round half up to one decimal place. */
export function normalizeWeeklyHours(raw: string): WeeklyHoursNormalization {
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(raw.trim());
  if (!match) return { value: null, error: 'Enter a positive number using a decimal point or comma.' };

  const whole = BigInt(match[1]);
  const fraction = match[2] ?? '';
  if (whole > 40n || (whole === 40n && /[1-9]/.test(fraction))) {
    return { value: null, error: 'Weekly hours cannot exceed 40 hours.' };
  }

  const tenths = Number(whole) * 10
    + Number(fraction[0] ?? '0')
    + (Number(fraction[1] ?? '0') >= 5 ? 1 : 0);
  if (tenths === 0) return { value: null, error: 'Hours must round to at least 0.1 hours.' };
  return { value: tenths / 10 };
}
