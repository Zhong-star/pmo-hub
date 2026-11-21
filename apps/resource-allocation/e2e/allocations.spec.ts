import { expect, test, type Page, type Route } from '@playwright/test';

const apiRoot = '**/api/resource-allocation/v1';
const profileStorageKey = 'pmo-hub.local-user-id';
const userId = 'profile-allocation-user';
const personId = 'f2f77176-cc30-46a5-b634-b0218b67286a';
const allocationId = 'f9c6026c-4143-4d78-b5ba-07308b18cff7';
const emptyPage = { nextCursor: null, limit: 50 };

const user = {
  id: personId,
  localUserId: userId,
  displayName: 'Taylor Resource Owner',
  role: 'ALLOCATION_USER',
  groupId: null,
  coveredGroupIds: [],
};

function allocation(version = 7, state = 'IN_PROGRESS', availableActions = ['SUSPEND']): Record<string, unknown> {
  return {
    id: allocationId,
    requestId: 'e9660f63-8758-46be-b21b-96f4d5580d80',
    person: { personId, displayName: 'Taylor Resource Owner' },
    group: { id: 'ac4a8e90-0f75-411e-a433-4aa05649fa50', name: 'Platform Engineering' },
    initiative: { id: '51d7783e-fd74-4665-a3f6-82c392f407eb', code: 'ITDM-69', name: 'Capacity planning' },
    resourceProfile: { id: '2ea514e7-ef80-47a3-a5bb-e8ac4dc36aa9', name: 'Cloud Engineering' },
    startDate: '2026-11-18',
    endDate: '2026-12-12',
    approvedPeriod: { startDate: '2026-11-18', endDate: '2026-12-20' },
    weeklyHours: 20,
    state,
    approvedAt: '2026-11-17T14:30:00.000Z',
    version,
    availableActions,
  };
}

async function installBaseRoutes(page: Page) {
  await page.route(`${apiRoot}/access`, async (route) => route.fulfill({ json: { person: user } }));
  await page.route(`${apiRoot}/request-queues/**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/requests**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/submissions**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/notifications**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/groups**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/resource-profiles**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/initiatives**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
    key: profileStorageKey,
    value: userId,
  });
}

test('opens an authorized allocation detail from a notification', async ({ page }) => {
  await installBaseRoutes(page);
  await page.route(`${apiRoot}/notification**`, (route) => route.fulfill({
    json: {
      items: [{
        id: 'notice-allocation', eventCode: 'ALLOCATION_STARTED', title: 'Allocation started', message: 'An allocation has started.',
        createdAt: '2026-11-20T12:00:00Z', readAt: null, etag: '"notice-1"',
        target: { type: 'REQUEST', requestId: allocationId, allocationId, available: true, destination: 'ALLOCATION_DETAIL' },
      }],
      page: emptyPage,
    },
  }));
  await page.route(`${apiRoot}/allocation-load**`, (route) => route.fulfill({
    json: { date: '2026-11-20', items: [], page: emptyPage },
  }));
  let detailRequests = 0;
  await page.route(`${apiRoot}/allocations**`, (route) => {
    if (new URL(route.request().url()).pathname.endsWith(`/allocations/${allocationId}`)) {
      detailRequests += 1;
      return route.fulfill({ headers: { etag: '"7"' }, json: allocation() });
    }
    return route.fulfill({ json: { items: [], page: emptyPage } });
  });

  await page.goto('/resource-allocation/');
  await page.getByRole('link', { name: 'Open related allocation' }).click();
  await expect(page).toHaveURL(new RegExp(`allocationId=${allocationId}`));
  await expect(page.getByRole('region', { name: 'Allocation details' })).toBeVisible();
  expect(detailRequests).toBeGreaterThan(0);
});

test('filters authorized allocations by inclusive effective overlap and shows weekly capacity for the São Paulo date', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-21T02:30:00.000Z') });
  await installBaseRoutes(page);
  const listedFilters: URLSearchParams[] = [];
  const loadDates: string[] = [];
  const listItem = allocation(7, 'IN_PROGRESS', ['SUSPEND']);
  await page.route(`${apiRoot}/allocation-load**`, async (route) => {
    const url = new URL(route.request().url());
    loadDates.push(url.searchParams.get('date') ?? '');
    await route.fulfill({ json: {
      date: url.searchParams.get('date'),
      items: [{
        person: { personId, displayName: 'Taylor Resource Owner' },
        weeklyHoursByState: {
          NOT_STARTED: 0,
          IN_PROGRESS: 20,
          SUSPENDED: 0,
          ALLOCATED_WITHOUT_ACTION: 5,
          DONE: 0,
          CANCELED: 0,
        },
        totalWeeklyHours: 25,
      }],
      page: emptyPage,
    } });
  });
  await page.route(`${apiRoot}/allocations**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') return route.fallback();
    if (url.pathname.endsWith(`/allocations/${allocationId}/history`)) {
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    if (url.pathname.endsWith(`/allocations/${allocationId}`)) {
      await route.fulfill({ headers: { etag: '"7"' }, json: listItem });
      return;
    }
    if (url.pathname.endsWith('/allocations')) {
      listedFilters.push(url.searchParams);
      await route.fulfill({ json: { items: [listItem], page: emptyPage } });
      return;
    }
    await route.fallback();
  });

  await page.goto('/resource-allocation/');
  const panel = page.getByRole('region', { name: 'Allocations and capacity' });
  await expect(panel.getByRole('heading', { name: 'Allocations and capacity' })).toBeVisible();
  await expect(panel.getByText('25 hours/week', { exact: true })).toBeVisible();
  await expect(panel.getByRole('cell', { name: '20 hours/week', exact: true })).toBeVisible();
  expect(loadDates).toContain('2026-11-20');

  await panel.getByLabel('Effective period from').fill('2026-11-18');
  await panel.getByLabel('Effective period to').fill('2026-11-18');
  await panel.getByLabel('Operational state').selectOption('IN_PROGRESS');
  await panel.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect.poll(() => listedFilters.some((filters) =>
    filters.get('periodStart') === '2026-11-18'
    && filters.get('periodEnd') === '2026-11-18'
    && filters.get('operationalState') === 'IN_PROGRESS')).toBeTruthy();

  await panel.getByRole('button', { name: 'View allocation ITDM-69' }).click();
  const detail = panel.getByRole('region', { name: 'Allocation details' });
  await expect(detail.getByText('Approved period')).toBeVisible();
  await expect(detail.getByText('Nov 18, 2026 – Dec 20, 2026')).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Suspend' })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Reserve without action' })).toHaveCount(0);
});

test('preserves the reason after a stale version and refreshes before another command', async ({ page }) => {
  await installBaseRoutes(page);
  let currentAllocation = allocation(7, 'IN_PROGRESS', ['SUSPEND']);
  const commandHeaders: Array<Record<string, string>> = [];
  const commandBodies: Array<Record<string, unknown>> = [];
  let postCount = 0;

  await page.route(`${apiRoot}/allocation-load**`, async (route) => route.fulfill({
    json: { date: '2026-11-21', items: [], page: emptyPage },
  }));
  await page.route(`${apiRoot}/allocations**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname.endsWith(`/allocations/${allocationId}/suspensions`)) {
      postCount += 1;
      commandHeaders.push(request.headers());
      commandBodies.push(request.postDataJSON() as Record<string, unknown>);
      if (postCount === 1) {
        currentAllocation = allocation(8, 'IN_PROGRESS', ['SUSPEND']);
        await route.fulfill({
          status: 412,
          contentType: 'application/problem+json',
          json: { status: 412, code: 'PRECONDITION_FAILED', detail: 'This allocation has changed. Refresh it before trying again.' },
        });
        return;
      }
      currentAllocation = allocation(9, 'SUSPENDED', ['RESUME', 'CANCEL', 'COMPLETE']);
      await route.fulfill({ headers: { etag: '"9"' }, json: currentAllocation });
      return;
    }
    if (request.method() === 'GET' && url.pathname.endsWith(`/allocations/${allocationId}/history`)) {
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    if (request.method() === 'GET' && url.pathname.endsWith(`/allocations/${allocationId}`)) {
      await route.fulfill({ headers: { etag: `"${currentAllocation.version}"` }, json: currentAllocation });
      return;
    }
    if (request.method() === 'GET' && url.pathname.endsWith('/allocations')) {
      await route.fulfill({ json: { items: [currentAllocation], page: emptyPage } });
      return;
    }
    await route.fallback();
  });

  await page.goto('/resource-allocation/');
  const panel = page.getByRole('region', { name: 'Allocations and capacity' });
  await panel.getByRole('button', { name: 'View allocation ITDM-69' }).click();
  const detail = panel.getByRole('region', { name: 'Allocation details' });
  await detail.getByRole('button', { name: 'Suspend' }).click();
  const reason = detail.getByRole('textbox', { name: 'Reason' });
  await reason.fill('Pause while the incident is investigated.');
  await detail.getByRole('button', { name: 'Save change' }).click();

  await expect(detail.getByRole('alert')).toContainText('changed');
  await expect(reason).toHaveValue('Pause while the incident is investigated.');
  expect(commandHeaders[0]['if-match']).toBe('"7"');
  expect(commandBodies[0].reason).toBe('Pause while the incident is investigated.');

  await detail.getByRole('button', { name: 'Refresh allocation' }).click();
  await expect(detail.getByText('Version 8')).toBeVisible();
  await expect(reason).toHaveValue('Pause while the incident is investigated.');
  await detail.getByRole('button', { name: 'Save change' }).click();
  await expect(detail.getByText('Suspended', { exact: true })).toBeVisible();
  expect(commandHeaders[1]['if-match']).toBe('"8"');
  expect(commandBodies[1].reason).toBe('Pause while the incident is investigated.');
});

test('retries a lost allocation command with the same idempotency key and reason', async ({ page }) => {
  await installBaseRoutes(page);
  let currentAllocation = allocation(7, 'IN_PROGRESS', ['SUSPEND']);
  const commandKeys: string[] = [];
  const commandBodies: Array<Record<string, unknown>> = [];
  let postCount = 0;

  await page.route(`${apiRoot}/allocation-load**`, async (route) => route.fulfill({
    json: { date: '2026-11-21', items: [], page: emptyPage },
  }));
  await page.route(`${apiRoot}/allocations**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname.endsWith(`/allocations/${allocationId}/suspensions`)) {
      postCount += 1;
      commandKeys.push(request.headers()['idempotency-key']);
      commandBodies.push(request.postDataJSON() as Record<string, unknown>);
      currentAllocation = allocation(8, 'SUSPENDED', ['RESUME', 'CANCEL', 'COMPLETE']);
      if (postCount === 1) {
        await route.abort('connectionreset');
        return;
      }
      await route.fulfill({ headers: { 'idempotency-replayed': 'true' }, json: currentAllocation });
      return;
    }
    if (request.method() === 'GET' && url.pathname.endsWith(`/allocations/${allocationId}/history`)) {
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    if (request.method() === 'GET' && url.pathname.endsWith(`/allocations/${allocationId}`)) {
      await route.fulfill({ headers: { etag: `"${currentAllocation.version}"` }, json: currentAllocation });
      return;
    }
    if (request.method() === 'GET' && url.pathname.endsWith('/allocations')) {
      await route.fulfill({ json: { items: [currentAllocation], page: emptyPage } });
      return;
    }
    await route.fallback();
  });

  await page.goto('/resource-allocation/');
  const panel = page.getByRole('region', { name: 'Allocations and capacity' });
  await panel.getByRole('button', { name: 'View allocation ITDM-69' }).click();
  const detail = panel.getByRole('region', { name: 'Allocation details' });
  await detail.getByRole('button', { name: 'Suspend' }).click();
  await detail.getByRole('textbox', { name: 'Reason' }).fill('Pause for the deployment window.');
  await detail.getByRole('button', { name: 'Save change' }).click();
  await expect(detail.getByRole('alert')).toContainText('could not be confirmed');
  await detail.getByRole('button', { name: 'Retry change' }).click();

  await expect(detail.getByText('Suspended', { exact: true })).toBeVisible();
  expect(commandKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  expect(commandKeys[1]).toBe(commandKeys[0]);
  expect(commandBodies.map((body) => body.reason)).toEqual([
    'Pause for the deployment window.',
    'Pause for the deployment window.',
  ]);
});
