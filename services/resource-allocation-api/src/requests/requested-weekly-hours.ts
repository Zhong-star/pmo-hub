import { ResourceAllocationException } from '../access/resource-allocation-problem';

export function normalizeRequestedWeeklyHours(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 40) {
    throw new ResourceAllocationException('INVALID_WEEKLY_HOURS', 'Invalid weekly hours', 422, 'Weekly hours must be greater than zero and no more than 40 before rounding.');
  }
  const decimal = value.toString().toLowerCase();
  const [coefficient, exponentText] = decimal.split('e');
  const [whole, fraction = ''] = coefficient.split('.');
  const exponent = Number(exponentText ?? 0) - fraction.length + 1;
  const digits = BigInt(`${whole}${fraction}`);
  const tenths = exponent >= 0
    ? digits * (10n ** BigInt(exponent))
    : (2n * digits + 10n ** BigInt(-exponent)) / (2n * (10n ** BigInt(-exponent)));
  if (tenths <= 0n) {
    throw new ResourceAllocationException('INVALID_WEEKLY_HOURS', 'Invalid weekly hours', 422, 'Weekly hours must round to at least 0.1.');
  }
  return Number(tenths) / 10;
}
