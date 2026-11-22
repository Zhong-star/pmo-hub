export const RESOURCE_ALLOCATION_PAGES = [
  'requests',
  'new-request',
  'request-queues',
  'allocations',
  'notifications',
  'administration',
] as const;

export type ResourceAllocationPage = (typeof RESOURCE_ALLOCATION_PAGES)[number];

function isResourceAllocationPage(value: string | null): value is ResourceAllocationPage {
  return RESOURCE_ALLOCATION_PAGES.some((page) => page === value);
}

export function readResourceAllocationPage(search: string): ResourceAllocationPage {
  const params = new URLSearchParams(search);
  const requestedPage = params.get('page');
  if (requestedPage !== null) return isResourceAllocationPage(requestedPage) ? requestedPage : 'requests';

  if (params.has('queue')) return 'request-queues';
  if (params.has('requestId') || params.has('auditId')) return 'requests';
  if (params.has('allocationId')) return 'allocations';
  return 'requests';
}

export function normalizeResourceAllocationPage(page: ResourceAllocationPage): void {
  const url = new URL(window.location.href);
  if (url.searchParams.get('page') === page) return;

  url.searchParams.set('page', page);
  window.history.replaceState(window.history.state, '', url);
}

export function resourceAllocationPageHref(page: ResourceAllocationPage): string {
  return `/resource-allocation/?page=${encodeURIComponent(page)}`;
}
