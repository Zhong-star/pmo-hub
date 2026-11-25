import { describe, expect, it } from 'vitest';
import { compareWeeks, mondayOf, weekSpan, type ComparisonAllocation, type ComparisonCapacity } from '../src/capacities/capacity-comparison';

const group = 'group-a';
const profile = 'profile-a';
const monday = '2027-01-04';

function allocation(overrides: Partial<ComparisonAllocation> = {}): ComparisonAllocation {
  return {
    groupId: group, resourceProfileId: profile, classification: 'INTERNAL',
    startDate: monday, endDate: '2027-01-10', weeklyHours: 40, kind: 'PLANNED', ...overrides,
  };
}

function capacity(overrides: Partial<ComparisonCapacity> = {}): ComparisonCapacity {
  return { groupId: group, resourceProfileId: profile, classification: 'INTERNAL', effectiveDate: '2026-01-01', fte: 1, ...overrides };
}

function row(allocations: ComparisonAllocation[], capacities: ComparisonCapacity[], classification: 'INTERNAL' | 'THIRD_PARTY' | null = 'INTERNAL') {
  const [week] = compareWeeks([monday], allocations, capacities, [group]);
  return week.groups[0]?.profiles[0]?.classifications.find((item) => item.classification === classification);
}

describe('weekly capacity comparison', () => {
  it('prorates 40 weekly hours over Monday and Tuesday as 16 hours', () => {
    expect(row([allocation({ endDate: '2027-01-05' })], [])?.plannedHours).toBe(16);
  });

  it('ignores weekends and counts single-day and inclusive overlaps', () => {
    expect(row([allocation({ startDate: '2027-01-09', endDate: '2027-01-10' })], [capacity()])?.plannedHours ?? 0).toBe(0);
    expect(row([allocation({ startDate: '2027-01-08', endDate: '2027-01-20' })], [])?.plannedHours).toBe(8);
    expect(row([allocation({ startDate: '2026-12-01', endDate: monday })], [])?.plannedHours).toBe(8);
  });

  it('adds capacity per weekday from the entry in force: 1 FTE Mon–Tue and 0.5 Wed–Fri is 28 hours', () => {
    const result = row([], [capacity(), capacity({ effectiveDate: '2027-01-06', fte: 0.5 })]);
    expect(result).toMatchObject({ capacityHours: 28, complete: true });
  });

  it('marks a week incomplete and without a percentage when capacity starts on Wednesday', () => {
    const result = row([allocation()], [capacity({ effectiveDate: '2027-01-06' })]);
    expect(result).toMatchObject({ capacityHours: 24, complete: false, utilizationPercent: null });
  });

  it('allows utilization above 100 percent and keeps zero distinct from absent capacity', () => {
    expect(row([allocation({ weeklyHours: 30 }), allocation({ weeklyHours: 30 })], [capacity()])).toMatchObject({ plannedHours: 60, capacityHours: 40, utilizationPercent: 150 });
    expect(row([allocation()], [capacity({ fte: 0 })])).toMatchObject({ capacityHours: 0, complete: true, utilizationPercent: null });
    expect(row([allocation()], [])).toMatchObject({ capacityHours: null, complete: false, utilizationPercent: null });
  });

  it('keeps suspended load apart and computes totals from summed hours', () => {
    const [week] = compareWeeks([monday], [
      allocation({ weeklyHours: 20 }),
      allocation({ weeklyHours: 10, kind: 'SUSPENDED' }),
      allocation({ classification: 'THIRD_PARTY', weeklyHours: 10 }),
    ], [capacity(), capacity({ classification: 'THIRD_PARTY', fte: 0.5 })], [group]);
    const total = week.groups[0].profiles[0].total;
    expect(total).toMatchObject({ plannedHours: 30, suspendedHours: 10, capacityHours: 60, complete: true, utilizationPercent: 50 });
    expect(week.total).toMatchObject({ plannedHours: 30, capacityHours: 60, utilizationPercent: 50 });
  });

  it('suppresses the profile total when only one classification has capacity or Unclassified load exists', () => {
    const [onlyInternal] = compareWeeks([monday], [allocation()], [capacity()], [group]);
    expect(onlyInternal.groups[0].profiles[0].total).toMatchObject({ capacityHours: 40, complete: false, utilizationPercent: null });
    expect(onlyInternal.groups[0].profiles[0].classifications[0]).toMatchObject({ utilizationPercent: 100 });

    const [unknown] = compareWeeks([monday], [allocation({ classification: null, weeklyHours: 10 })], [capacity(), capacity({ classification: 'THIRD_PARTY' })], [group]);
    const profileRow = unknown.groups[0].profiles[0];
    expect(profileRow.classifications.find((item) => item.classification === null)).toMatchObject({ plannedHours: 10, capacityHours: null });
    expect(profileRow.total).toMatchObject({ plannedHours: 10, capacityHours: 80, complete: false, utilizationPercent: null });
    expect(unknown.groups[0].unclassifiedHours).toBe(10);
  });

  it('reports vacation apart from the work numerator without reducing capacity', () => {
    const [week] = compareWeeks([monday], [
      allocation({ kind: 'VACATION', resourceProfileId: null, endDate: '2027-01-05' }),
      allocation({ weeklyHours: 20 }),
    ], [capacity(), capacity({ classification: 'THIRD_PARTY', fte: 0 })], [group]);
    expect(week.groups[0]).toMatchObject({ vacationHours: 16 });
    expect(week.groups[0].profiles[0].total).toMatchObject({ plannedHours: 20, capacityHours: 40, utilizationPercent: 50 });
  });

  it('limits totals to the filtered classification', () => {
    const [week] = compareWeeks([monday], [allocation({ weeklyHours: 20 })], [capacity()], [group], ['INTERNAL']);
    expect(week.groups[0].profiles[0].classifications.map((row) => row.classification)).toEqual(['INTERNAL']);
    expect(week.groups[0].profiles[0].total).toMatchObject({ complete: true, utilizationPercent: 50 });
    expect(week.total).toMatchObject({ complete: true, utilizationPercent: 50 });
  });

  it('keeps group and week totals without a percentage when Unclassified load exists, and mixes zero with known capacity', () => {
    const [week] = compareWeeks([monday], [
      allocation({ classification: null, weeklyHours: 5 }),
      allocation({ resourceProfileId: 'profile-b', weeklyHours: 10 }),
    ], [
      capacity(), capacity({ classification: 'THIRD_PARTY' }),
      capacity({ resourceProfileId: 'profile-b', fte: 0 }), capacity({ resourceProfileId: 'profile-b', classification: 'THIRD_PARTY', fte: 1 }),
    ], [group]);
    expect(week.groups[0].total).toMatchObject({ plannedHours: 15, capacityHours: 120, complete: false, utilizationPercent: null });
    expect(week.total.utilizationPercent).toBeNull();
    const profileB = week.groups[0].profiles.find((row) => row.resourceProfileId === 'profile-b')!;
    expect(profileB.total).toMatchObject({ plannedHours: 10, capacityHours: 40, complete: true, utilizationPercent: 25 });
  });

  it('spans weeks across a year boundary', () => {
    expect(weekSpan('2026-12-28', '2027-01-04')).toBe(2);
    const weeks = compareWeeks(['2026-12-28', '2027-01-04'], [allocation({ startDate: '2026-12-31', endDate: '2027-01-05' })], [], [group]);
    expect(weeks.map((item) => item.groups[0]?.profiles[0]?.total.plannedHours)).toEqual([16, 16]);
  });

  it('finds the Monday of any date', () => {
    expect(mondayOf('2027-01-10')).toBe(monday);
    expect(mondayOf('2027-01-04')).toBe(monday);
    expect(mondayOf('2027-01-06')).toBe(monday);
  });
});
