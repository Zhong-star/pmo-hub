import type { ResourceAllocation } from './resource-allocation.entity';

export function allocationResponse(allocation: ResourceAllocation) {
  const person = allocation.personSnapshot;
  const group = allocation.groupSnapshot;
  const initiative = allocation.initiativeSnapshot;
  const profile = allocation.resourceProfileSnapshot;

  return {
    id: allocation.id,
    person: { personId: allocation.personId, displayName: person.displayName },
    group: { id: allocation.groupId, name: group.name },
    initiative: { id: allocation.initiativeId, code: initiative.code, name: initiative.name },
    resourceProfile: { id: allocation.resourceProfileId, name: profile.name },
    startDate: allocation.effectiveStartDate,
    endDate: allocation.effectiveEndDate,
    approvedPeriod: { startDate: allocation.approvedStartDate, endDate: allocation.approvedEndDate },
    weeklyHours: Number(allocation.weeklyHours),
    state: allocation.state,
    approvedAt: allocation.approvedAt.toISOString(),
    version: allocation.version,
  };
}
