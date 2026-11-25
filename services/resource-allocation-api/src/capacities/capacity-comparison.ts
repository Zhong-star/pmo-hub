/**
 * Weekly capacity versus planned load (spec 03, Q7–Q8, Q13–Q16, Q22–Q23, Q30–Q31, Q36–Q37).
 *
 * Weeks run Monday–Sunday; only Monday–Friday count. Each weekday of overlap contributes
 * weeklyHours / 5 of load, and each weekday with a capacity entry in force contributes FTE × 8
 * hours of capacity. Days without an entry are unknown, never zero. Percentages are computed
 * from summed hours, never averaged, and only when every component is complete.
 */

export type Classification = 'INTERNAL' | 'THIRD_PARTY';
export type AllocationLoadKind = 'PLANNED' | 'SUSPENDED' | 'VACATION';

export interface ComparisonAllocation {
  groupId: string;
  resourceProfileId: string | null;
  classification: Classification | null;
  startDate: string;
  endDate: string;
  weeklyHours: number;
  kind: AllocationLoadKind;
}

export interface ComparisonCapacity {
  groupId: string;
  resourceProfileId: string;
  classification: Classification;
  effectiveDate: string;
  fte: number;
}

export interface ComparisonFigures {
  plannedHours: number;
  suspendedHours: number;
  /** Capacity hours known for the days with an entry in force; null when no day has one. */
  capacityHours: number | null;
  /** True when every weekday of every component has capacity and no Unclassified load is included. */
  complete: boolean;
  /** Planned / capacity × 100, only for complete figures with capacity above zero. */
  utilizationPercent: number | null;
}

export interface ClassificationRow extends ComparisonFigures {
  classification: Classification | null;
}

export interface ProfileRow {
  groupId: string;
  resourceProfileId: string;
  classifications: ClassificationRow[];
  total: ComparisonFigures;
}

export interface GroupComparison {
  groupId: string;
  profiles: ProfileRow[];
  /** Load from allocations recorded without a classification, kept apart from both classifications. */
  unclassifiedHours: number;
  vacationHours: number;
  total: ComparisonFigures;
}

export interface WeekComparison {
  weekStart: string;
  weekEnd: string;
  groups: GroupComparison[];
  total: ComparisonFigures;
}

const hoursPerFteDay = 8;
const allClassifications: Classification[] = ['INTERNAL', 'THIRD_PARTY'];

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function isMonday(date: string): boolean {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay() === 1;
}

/** Number of whole weeks between two Mondays, inclusive of both. */
export function weekSpan(firstMonday: string, lastMonday: string): number {
  const days = (Date.parse(`${lastMonday}T00:00:00.000Z`) - Date.parse(`${firstMonday}T00:00:00.000Z`)) / 86_400_000;
  return Math.floor(days / 7) + 1;
}

export function mondayOf(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return addDays(date, day === 0 ? -6 : 1 - day);
}

function weekdays(weekStart: string): string[] {
  return [0, 1, 2, 3, 4].map((offset) => addDays(weekStart, offset));
}

function overlappingWeekdays(weekStart: string, startDate: string, endDate: string): number {
  return weekdays(weekStart).filter((day) => day >= startDate && day <= endDate).length;
}

function figures(planned: number, suspended: number, capacity: number | null, complete: boolean): ComparisonFigures {
  return {
    plannedHours: planned,
    suspendedHours: suspended,
    capacityHours: capacity,
    complete,
    utilizationPercent: complete && capacity !== null && capacity > 0 ? (planned / capacity) * 100 : null,
  };
}

function sumFigures(parts: ComparisonFigures[], extraPlanned = 0, extraComplete = true): ComparisonFigures {
  const planned = parts.reduce((sum, part) => sum + part.plannedHours, 0) + extraPlanned;
  const suspended = parts.reduce((sum, part) => sum + part.suspendedHours, 0);
  const known = parts.filter((part) => part.capacityHours !== null);
  const capacity = known.length > 0 ? known.reduce((sum, part) => sum + (part.capacityHours ?? 0), 0) : null;
  const complete = extraComplete && parts.length > 0 && parts.every((part) => part.complete);
  return figures(planned, suspended, capacity, complete);
}

/** Capacity hours for one key in one week, and whether every weekday had an entry in force. */
function weekCapacity(entries: ComparisonCapacity[], weekStart: string): { hours: number | null; complete: boolean } {
  const ordered = [...entries].sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate));
  let hours = 0;
  let knownDays = 0;
  for (const day of weekdays(weekStart)) {
    let current: ComparisonCapacity | undefined;
    for (const entry of ordered) {
      if (entry.effectiveDate <= day) current = entry;
      else break;
    }
    if (current) {
      knownDays += 1;
      hours += current.fte * hoursPerFteDay;
    }
  }
  return { hours: knownDays > 0 ? hours : null, complete: knownDays === 5 };
}

export function compareWeeks(
  weekStarts: string[],
  allocations: ComparisonAllocation[],
  capacities: ComparisonCapacity[],
  groupIds: string[],
  classifications: Classification[] = allClassifications,
): WeekComparison[] {
  return weekStarts.map((weekStart) => {
    const weekEnd = addDays(weekStart, 6);
    const groups = groupIds.map((groupId) => {
      const groupAllocations = allocations.filter((item) => item.groupId === groupId);
      const groupCapacities = capacities.filter((item) => item.groupId === groupId);
      const loadOf = (item: ComparisonAllocation) => (item.weeklyHours / 5) * overlappingWeekdays(weekStart, item.startDate, item.endDate);

      const vacationHours = groupAllocations.filter((item) => item.kind === 'VACATION').reduce((sum, item) => sum + loadOf(item), 0);
      const work = groupAllocations.filter((item) => item.kind !== 'VACATION' && loadOf(item) > 0);
      const unclassifiedPlanned = work.filter((item) => item.classification === null && item.kind === 'PLANNED').reduce((sum, item) => sum + loadOf(item), 0);

      const profileIds = [...new Set([
        ...work.map((item) => item.resourceProfileId).filter((id): id is string => id !== null),
        ...groupCapacities.filter((item) => item.effectiveDate <= addDays(weekStart, 4)).map((item) => item.resourceProfileId),
      ])].sort();

      const profiles: ProfileRow[] = profileIds.map((resourceProfileId) => {
        const profileWork = work.filter((item) => item.resourceProfileId === resourceProfileId);
        const rows: ClassificationRow[] = classifications.map((classification) => {
          const classified = profileWork.filter((item) => item.classification === classification);
          const planned = classified.filter((item) => item.kind === 'PLANNED').reduce((sum, item) => sum + loadOf(item), 0);
          const suspended = classified.filter((item) => item.kind === 'SUSPENDED').reduce((sum, item) => sum + loadOf(item), 0);
          const capacity = weekCapacity(groupCapacities.filter((item) => item.resourceProfileId === resourceProfileId && item.classification === classification), weekStart);
          return { classification, ...figures(planned, suspended, capacity.hours, capacity.complete) };
        });
        const unclassified = profileWork.filter((item) => item.classification === null);
        const unclassifiedRowPlanned = unclassified.filter((item) => item.kind === 'PLANNED').reduce((sum, item) => sum + loadOf(item), 0);
        const unclassifiedRowSuspended = unclassified.filter((item) => item.kind === 'SUSPENDED').reduce((sum, item) => sum + loadOf(item), 0);
        if (unclassified.length > 0) {
          rows.push({ classification: null, ...figures(unclassifiedRowPlanned, unclassifiedRowSuspended, null, false) });
        }
        const classifiedRows = rows.filter((row) => row.classification !== null);
        const total = sumFigures(classifiedRows, unclassifiedRowPlanned, !unclassified.some((item) => item.kind === 'PLANNED'));
        total.suspendedHours += unclassifiedRowSuspended;
        return { groupId, resourceProfileId, classifications: rows, total };
      });

      return {
        groupId,
        profiles,
        unclassifiedHours: unclassifiedPlanned,
        vacationHours,
        total: profiles.length > 0 ? sumFigures(profiles.map((profile) => profile.total)) : figures(0, 0, null, false),
      };
    });
    const withData = groups.filter((group) => group.profiles.length > 0 || group.vacationHours > 0);
    const withProfiles = withData.filter((group) => group.profiles.length > 0);
    return {
      weekStart,
      weekEnd,
      groups: withData,
      total: withProfiles.length > 0 ? sumFigures(withProfiles.map((group) => group.total)) : figures(0, 0, null, false),
    };
  });
}
