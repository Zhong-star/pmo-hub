import type { QueryClient } from '@tanstack/react-query';
import { ALLOCATIONS_QUERY_ROOT } from './allocationApi';
import { NOTIFICATIONS_QUERY_ROOT } from './notificationsApi';
import { REQUESTS_QUERY_ROOT } from './requestApi';
import { REQUEST_QUEUES_QUERY_ROOT } from './requestQueueApi';
import { SUBMISSIONS_QUERY_ROOT } from './submissionApi';

export async function invalidateRequestSurfaces(
  queryClient: QueryClient,
  options: { localUserId?: string; requestId?: string; preserveDetail?: boolean; includeAllocations?: boolean } = {},
) {
  const invalidations = [
    queryClient.invalidateQueries({ queryKey: REQUEST_QUEUES_QUERY_ROOT }),
    queryClient.invalidateQueries({ queryKey: REQUESTS_QUERY_ROOT }),
    queryClient.invalidateQueries({ queryKey: SUBMISSIONS_QUERY_ROOT }),
    queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_ROOT }),
  ];
  if (options.includeAllocations) invalidations.push(queryClient.invalidateQueries({ queryKey: ALLOCATIONS_QUERY_ROOT }));
  await Promise.all(invalidations);

  if (options.requestId && options.localUserId && !options.preserveDetail) {
    await queryClient.removeQueries({ queryKey: [...REQUESTS_QUERY_ROOT, options.localUserId, 'detail', options.requestId] });
  }
}
