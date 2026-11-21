import { expect, test, type Page, type Route } from '@playwright/test';

const apiRoot = '**/api/resource-allocation/v1';
const profileStorageKey = 'pmo-hub.local-user-id';
const requestId = '5d55284d-34f3-4217-aa15-6d39fc7cddc4';
const userId = 'profile-requester';
const emptyPage = { nextCursor: null, limit: 50 };

const requester = {
  id: '8b3c59b1-f32a-4e29-80cc-4b4cc8daae17',
  localUserId: userId,
  displayName: 'Taylor Requester',
  role: 'ALLOCATION_USER',
  groupId: null,
  coveredGroupIds: [],
};

const admin = {
  id: 'a1676440-e970-44e7-806c-70ae1c27fed8',
  localUserId: 'profile-admin',
  displayName: 'Morgan Admin',
  role: 'ALLOCATION_ADMIN',
  groupId: '361988f3-fbbf-48ac-9d70-86070f69fc9d',
  coveredGroupIds: [],
};

function deniedRequest(state = 'DENIED', version = 2) {
  return {
    id: requestId,
    requesterSnapshot: { personId: requester.id, displayName: requester.displayName, role: requester.role },
    requestedConditions: {
      initiativeId: 'ff5d471a-a57f-4bfd-924e-fb1eeaa8d4f1',
      initiativeCode: 'ITDM-65',
      initiativeName: 'Resource planning',
      category: 'EXECUTION_PROJECT',
      groupId: '361988f3-fbbf-48ac-9d70-86070f69fc9d',
      groupName: 'Platform Engineering',
      resourceProfileId: '229ed3e8-cc69-4982-9b2b-e786270bd9f4',
      resourceProfileName: 'API Engineering',
      startDate: '2027-01-05',
      endDate: '2027-01-28',
      weeklyHours: 12,
      comment: 'Original request.',
    },
    decisionState: state,
    receivedAt: '2026-11-20T12:00:00.000Z',
    stageEnteredAt: '2026-11-20T13:00:00.000Z',
    expirationDueAt: '2026-12-04T13:00:00.000Z',
    version,
  };
}

async function installRequesterRoutes(page: Page) {
  await page.route(`${apiRoot}/access`, async (route) => route.fulfill({ json: { person: requester } }));
  await page.route(`${apiRoot}/initiatives**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/groups**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/resource-profiles**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/submissions**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/notifications**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), { key: profileStorageKey, value: userId });
}

function denialHistory(reason = 'The request does not fit current capacity.') {
  return {
    items: [
      { id: '4c1ed2ce-0a3d-4119-8e6f-6745290de651', action: 'SUBMITTED', actorSnapshot: requester, before: {}, after: {}, reason: null, occurredAt: '2026-11-20T12:00:00.000Z', correlationId: 'a0eeb9c3-6eb6-4a1f-b3b1-2e26e9cae5a4' },
      { id: '4c1ed2ce-0a3d-4119-8e6f-6745290de652', action: 'DENIED', actorSnapshot: { displayName: 'Morgan Moderator' }, before: {}, after: {}, reason, occurredAt: '2026-11-20T13:00:00.000Z', correlationId: 'a0eeb9c3-6eb6-4a1f-b3b1-2e26e9cae5a4' },
    ],
    page: emptyPage,
  };
}

test('a scoped decision maker denies from the queue with a required explanation', async ({ page }) => {
  const denied = { ...deniedRequest('PENDING_TEAM_DECISION', 4), requester: { personId: requester.id, displayName: requester.displayName, role: requester.role }, dueAt: null, nextResponsible: [], availableActions: ['DENY'], impediments: [] };
  let isDenied = false;
  let denial: { body?: Record<string, string>; headers?: Record<string, string> } = {};
  await page.route(`${apiRoot}/access`, async (route) => route.fulfill({ json: { person: admin } }));
  for (const collection of ['initiatives', 'groups', 'resource-profiles']) {
    await page.route(`${apiRoot}/${collection}**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  }
  await page.route(`${apiRoot}/admin/**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/submissions**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/notifications**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { items: !isDenied && path.endsWith('/team-decision') ? [denied] : [], page: emptyPage } });
      return;
    }
  });
  await page.route(`${apiRoot}/requests**`, async (route) => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    if (incoming.method() === 'GET') {
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    if (incoming.method() === 'POST' && url.pathname.endsWith(`/requests/${requestId}/denials`)) {
      denial = { body: incoming.postDataJSON() as Record<string, string>, headers: incoming.headers() };
      isDenied = true;
      await route.fulfill({ json: deniedRequest('DENIED', 5) });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/problem+json', json: { status: 404, code: 'RESOURCE_NOT_FOUND' } });
  });

  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), { key: profileStorageKey, value: admin.localUserId });
  await page.goto('/resource-allocation/?queue=team-decision');
  await page.getByRole('button', { name: 'Deny request' }).click();
  await page.getByRole('button', { name: 'Confirm denial' }).click();
  await expect(page.getByText('Enter an explanation before denying the request.')).toBeVisible();
  await page.getByLabel('Explanation for denial').fill('The available team capacity is already committed.');
  await page.getByRole('button', { name: 'Confirm denial' }).click();

  await expect(page.getByText('There are no requests in this queue.')).toBeVisible();
  expect(denial.body).toEqual({ explanation: 'The available team capacity is already committed.' });
  expect(denial.headers?.['if-match']).toBe('"4"');
  expect(denial.headers?.['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
});

test('shows the denial explanation and lets the requester contest into Pre N3 with a reason', async ({ page }) => {
  await installRequesterRoutes(page);
  let item = deniedRequest();
  const events = denialHistory().items;
  let contest: { body?: Record<string, string>; headers?: Record<string, string> } = {};

  await page.route(`${apiRoot}/requests**`, async (route: Route) => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    if (incoming.method() === 'GET' && url.pathname.endsWith('/history')) {
      await route.fulfill({ json: { items: events, page: emptyPage } });
      return;
    }
    if (incoming.method() === 'GET' && url.pathname.endsWith(`/requests/${requestId}`)) {
      await route.fulfill({ headers: { etag: `"${item.version}"` }, json: item });
      return;
    }
    if (incoming.method() === 'GET' && url.pathname.endsWith('/requests')) {
      await route.fulfill({ json: { items: [item], page: emptyPage } });
      return;
    }
    if (incoming.method() === 'POST' && url.pathname.endsWith(`/requests/${requestId}/contests`)) {
      contest = { body: incoming.postDataJSON() as Record<string, string>, headers: incoming.headers() };
      item = deniedRequest('PRE_N3', 3);
      events.push({ id: '4c1ed2ce-0a3d-4119-8e6f-6745290de653', action: 'CONTESTED', actorSnapshot: requester, before: {}, after: {}, reason: 'The new scope can be reduced to meet the deadline.', occurredAt: '2026-11-21T14:00:00.000Z', correlationId: 'a0eeb9c3-6eb6-4a1f-b3b1-2e26e9cae5a4' });
      await route.fulfill({ headers: { etag: '"3"' }, json: item });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/problem+json', json: { status: 404, code: 'RESOURCE_NOT_FOUND' } });
  });

  await page.goto(`/resource-allocation/?requestId=${requestId}`);
  const detail = page.getByRole('region', { name: 'ITDM-65' });
  await expect(detail.getByText('The request does not fit current capacity.')).toBeVisible();
  await detail.getByRole('button', { name: 'Contest denial' }).click();
  await detail.getByLabel('Reason for contesting').fill('The new scope can be reduced to meet the deadline.');
  await detail.getByRole('button', { name: 'Submit contest' }).click();

  await expect(detail).toContainText('Pre N3');
  await expect(detail.getByText('The new scope can be reduced to meet the deadline.')).toBeVisible();
  expect(contest.body).toEqual({ explanation: 'The new scope can be reduced to meet the deadline.' });
  expect(contest.headers?.['if-match']).toBe('"2"');
  expect(contest.headers?.['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
});

test('lets the requester cancel a denial with a reason and keeps both explanations in history', async ({ page }) => {
  await installRequesterRoutes(page);
  let item = deniedRequest();
  const events = denialHistory().items;
  let cancellation: { body?: Record<string, string>; headers?: Record<string, string> } = {};

  await page.route(`${apiRoot}/requests**`, async (route: Route) => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    if (incoming.method() === 'GET' && url.pathname.endsWith('/history')) {
      await route.fulfill({ json: { items: events, page: emptyPage } });
      return;
    }
    if (incoming.method() === 'GET' && url.pathname.endsWith(`/requests/${requestId}`)) {
      await route.fulfill({ headers: { etag: `"${item.version}"` }, json: item });
      return;
    }
    if (incoming.method() === 'GET' && url.pathname.endsWith('/requests')) {
      await route.fulfill({ json: { items: [item], page: emptyPage } });
      return;
    }
    if (incoming.method() === 'POST' && url.pathname.endsWith(`/requests/${requestId}/cancellations`)) {
      cancellation = { body: incoming.postDataJSON() as Record<string, string>, headers: incoming.headers() };
      item = deniedRequest('CANCELLED', 3);
      events.push({ id: '4c1ed2ce-0a3d-4119-8e6f-6745290de653', action: 'DENIAL_CANCELLED', actorSnapshot: requester, before: {}, after: {}, reason: 'The initiative was paused.', occurredAt: '2026-11-21T14:00:00.000Z', correlationId: 'a0eeb9c3-6eb6-4a1f-b3b1-2e26e9cae5a4' });
      await route.fulfill({ headers: { etag: '"3"' }, json: item });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/problem+json', json: { status: 404, code: 'RESOURCE_NOT_FOUND' } });
  });

  await page.goto(`/resource-allocation/?requestId=${requestId}`);
  const detail = page.getByRole('region', { name: 'ITDM-65' });
  await expect(detail.getByText('The request does not fit current capacity.')).toBeVisible();
  await detail.getByRole('button', { name: 'Cancel request' }).click();
  await detail.getByLabel('Reason for cancellation').fill('The initiative was paused.');
  await detail.getByRole('button', { name: 'Confirm cancellation' }).click();

  await expect(detail).toContainText('Cancelled');
  await expect(detail.getByText('The initiative was paused.')).toBeVisible();
  expect(cancellation.body).toEqual({ reason: 'The initiative was paused.' });
  expect(cancellation.headers?.['if-match']).toBe('"2"');
});
