import { ResourceAllocationException } from '../access/resource-allocation-problem';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceRequest } from '../requests/resource-request.entity';

export function requireAdminExceptionActor(actor: ResourcePerson, item: ResourceRequest): void {
  if (actor.role !== ResourceAllocationRole.Admin) {
    throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'Only an active Admin may resolve exception requests.');
  }
  if (item.requesterId === actor.id) {
    throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'An Admin cannot resolve their own request.');
  }
}
