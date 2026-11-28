export const RESOURCE_ALLOCATION_PAGES = [
  'requests',
  'request-queues',
  'allocations',
  'capacity',
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

export function readNewRequestDrawerOpen(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get('newRequest') === '1' || params.get('page') === 'new-request';
}

export function normalizeResourceAllocationPage(page: ResourceAllocationPage): void {
  const url = new URL(window.location.href);
  const currentPage = url.searchParams.get('page');
  if (currentPage === 'new-request') {
    url.searchParams.set('page', page);
    url.searchParams.set('newRequest', '1');
    window.history.replaceState(window.history.state, '', url);
    return;
  }
  if (currentPage === page) return;

  url.searchParams.set('page', page);
  window.history.replaceState(window.history.state, '', url);
}

export function resourceAllocationPageHref(page: ResourceAllocationPage): string {
  return `/resource-allocation/?page=${encodeURIComponent(page)}`;
}
