const databaseUnavailableCodes = new Set([
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
  '3F000', '42P01', '57P01', '57P02', '57P03', '53300',
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ENOTFOUND',
]);

export function isDatabaseUnavailable(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; depth < 4 && cause; depth += 1) {
    if (typeof cause !== 'object') return false;
    const value = cause as { code?: unknown; driverError?: unknown; cause?: unknown };
    if (typeof value.code === 'string' && (value.code.startsWith('08') || databaseUnavailableCodes.has(value.code))) {
      return true;
    }
    cause = value.driverError ?? value.cause;
  }
  return false;
}
