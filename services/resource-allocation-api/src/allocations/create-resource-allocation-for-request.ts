import type { EntityManager } from 'typeorm';
import { ResourceAllocation } from './resource-allocation.entity';
import { ResourceGroup } from '../groups/resource-group.entity';
import { ResourceInitiative } from '../initiatives/resource-initiative.entity';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceProfile } from '../resource-profiles/resource-profile.entity';

export interface CreateResourceAllocationForRequestInput {
  requestId: string;
  category: string | null;
  person: ResourcePerson;
  group: ResourceGroup;
  initiative: ResourceInitiative;
  profile: ResourceProfile;
  startDate: string;
  endDate: string;
  weeklyHours: number;
  occurredAt: Date;
  businessDate: string;
}

/** Persists the confirmed allocation shape shared by direct approvals and accepted proposals. */
export async function createResourceAllocationForRequest(
  manager: EntityManager,
  input: CreateResourceAllocationForRequestInput,
): Promise<ResourceAllocation> {
  const state = input.startDate === input.businessDate ? 'IN_PROGRESS' : 'NOT_STARTED';
  const repository = manager.getRepository(ResourceAllocation);
  return repository.save(repository.create({
    sourceRequestId: input.requestId,
    origin: 'REQUEST',
    category: input.category,
    comment: null,
    classification: input.person.classification ?? null,
    createdByPersonId: null,
    personId: input.person.id,
    personSnapshot: { personId: input.person.id, displayName: input.person.displayName, role: input.person.role },
    groupId: input.group.id,
    groupSnapshot: { id: input.group.id, name: input.group.name },
    initiativeId: input.initiative.id,
    initiativeSnapshot: { id: input.initiative.id, code: input.initiative.code, name: input.initiative.name },
    resourceProfileId: input.profile.id,
    resourceProfileSnapshot: { id: input.profile.id, name: input.profile.name },
    approvedStartDate: input.startDate,
    approvedEndDate: input.endDate,
    effectiveStartDate: input.startDate,
    effectiveEndDate: input.endDate,
    weeklyHours: input.weeklyHours.toFixed(1),
    state,
    stateEnteredAt: input.occurredAt,
    approvedAt: input.occurredAt,
  }));
}
