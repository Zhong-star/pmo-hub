import { ResourceRequestCategory } from '../submissions/submission-category';

/** Operational categories never carry an ITDM initiative; Vacation also has no resource profile. */
export const operationalAllocationCategories = ['ROUTINE_SUPPORT', 'TRAINING', 'INTERNAL_ACTIVITIES', 'VACATION'] as const;
export type OperationalAllocationCategory = typeof operationalAllocationCategories[number];

export const allocationCategories = [
  ...operationalAllocationCategories,
  ...Object.values(ResourceRequestCategory),
] as const;
export type AllocationCategory = typeof allocationCategories[number];

export const vacationWeeklyHours = 40;

export function isOperationalAllocationCategory(category: string | null | undefined): category is OperationalAllocationCategory {
  return (operationalAllocationCategories as readonly string[]).includes(category ?? '');
}

export function isVacationAllocation(category: string | null | undefined): boolean {
  return category === 'VACATION';
}

export function allocationCategoryLabel(category: string | null | undefined): string | null {
  return ({
    ROUTINE_SUPPORT: 'Routine / Support',
    TRAINING: 'Training',
    INTERNAL_ACTIVITIES: 'Internal activities',
    VACATION: 'Vacation',
    DEMAND_ANALYSIS: 'Demand Analysis',
    POC_BBP: 'POC/BBP',
    EXECUTION_PROJECT: 'Execution — Project',
    EXECUTION_FAST_TRACK: 'Execution — Fast track',
    EXECUTION_ENHANCEMENT: 'Execution — Enhancement',
  } as Record<string, string>)[category ?? ''] ?? null;
}

/** Category recorded on a request-based allocation; null when a legacy request has none. */
export function requestCategory(conditions: Record<string, unknown>): string | null {
  return typeof conditions.category === 'string' && conditions.category ? conditions.category : null;
}
