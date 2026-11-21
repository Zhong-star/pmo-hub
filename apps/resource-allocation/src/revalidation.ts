export type RevalidationOriginState = 'WAITING_FOR_PRESENTATION' | 'PENDING_TEAM_DECISION' | 'APPROVED_WITH_CHANGES';

export interface RequestResponsible {
  personId: string;
  displayName: string;
  role: string;
}

export type RevalidationResponsible = { role?: string } | RequestResponsible[];

const originLabels: Record<RevalidationOriginState, string> = {
  WAITING_FOR_PRESENTATION: 'Waiting for presentation',
  PENDING_TEAM_DECISION: 'Pending group decision',
  APPROVED_WITH_CHANGES: 'Approved with changes',
};

const impedimentLabels: Record<string, string> = {
  GROUP_INACTIVE: 'The request group is inactive.',
  INITIATIVE_INACTIVE: 'The request ITDM is inactive.',
  PROFILE_INACTIVE: 'The requested resource profile is inactive.',
  PROFILE_GROUP_MISMATCH: 'The resource profile no longer belongs to the request group.',
  PERSON_INACTIVE: 'The proposed person is inactive.',
  PERSON_LEFT_GROUP: 'The proposed person has left the request group.',
};

export function revalidationOriginLabel(origin: RevalidationOriginState | undefined): string {
  return origin ? originLabels[origin] : 'Previous decision';
}

export function revalidationImpedimentLabel(code: string): string {
  return impedimentLabels[code] ?? code.replaceAll('_', ' ').toLowerCase();
}

export function requestResponsibleLabel(responsible: RevalidationResponsible): string {
  if (Array.isArray(responsible)) {
    return responsible.map((person) => `${person.displayName} (${person.role.replace('ALLOCATION_', '')})`).join(', ');
  }
  return responsible.role === 'ALLOCATION_ADMIN' ? 'Tech Resource Allocation Admin' : 'Assigned group';
}
