const preservedTokens = new Set(['ITDM', 'PMO', 'N1', 'N2', 'N3']);

// The API keeps its original enum names; the screens speak of groups, not teams.
const labelOverrides: Record<string, string> = {
  PENDING_TEAM_DECISION: 'Waiting for group decision',
};

/** Turns an API enum such as `WAITING_FOR_PRESENTATION` into `Waiting for presentation`. */
export function enumLabel(value: string): string {
  if (labelOverrides[value]) return labelOverrides[value];
  const words = value.split('_').filter(Boolean).map((word) => (preservedTokens.has(word) ? word : word.toLowerCase()));
  if (words.length === 0) return value;
  const [first, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

/** Turns a module role such as `ALLOCATION_ADMIN` into `Admin`. */
export function roleLabel(role: string): string {
  return enumLabel(role.replace(/^ALLOCATION_/, ''));
}
