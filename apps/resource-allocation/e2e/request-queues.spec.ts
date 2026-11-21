import { expect, test, type Page } from '@playwright/test';

const apiRoot = '**/api/resource-allocation/v1';
const profileStorageKey = 'pmo-hub.local-user-id';
const emptyPage = { nextCursor: null, limit: 50 };

const admin = {
  id: 'admin-id',
  localUserId: 'profile-admin',
  displayName: 'Morgan Admin',
  role: 'ALLOCATION_ADMIN',
  groupId: 'group-a',
  coveredGroupIds: [],
};

const moderator = {
  id: 'moderator-id',
  localUserId: 'profile-moderator',
  displayName: 'Taylor Moderator',
  role: 'ALLOCATION_MODERATOR',
  groupId: 'group-a',
  coveredGroupIds: [],
};

const groups = [
  { id: 'group-a', name: 'Platform Engineering' },
  { id: 'group-b', name: 'Data Engineering' },
];
const profiles = [
  { id: 'profile-a', name: 'API Engineering', groupId: 'group-a' },
  { id: 'profile-b', name: 'Data Platform', groupId: 'group-b' },
];
const initiatives = [
  { id: 'initiative-a', code: 'ITDM-62', name: 'Resource allocation' },
  { id: 'initiative-b', code: 'ITDM-63', name: 'Data modernization' },
];

function requestItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'request-a',
    requester: { personId: 'requester-id', displayName: 'Jordan Requester', role: 'ALLOCATION_USER' },
    requestedConditions: {
      initiativeId: 'initiative-a',
      initiativeCode: 'ITDM-62',
      initiativeName: 'Resource allocation',
      groupId: 'group-a',
      groupName: 'Platform Engineering',
      resourceProfileId: 'profile-a',
      resourceProfileName: 'API Engineering',
      startDate: '2027-01-11',
      endDate: '2027-01-29',
      weeklyHours: 20,
      comment: 'Support the approved work.',
    },
    decisionState: 'WAITING_FOR_PRESENTATION',
    receivedAt: '2026-11-20T15:00:00.000Z',
    stageEnteredAt: '2026-11-20T15:00:00.000Z',
    dueAt: '2026-12-11T15:00:00.000Z',
    nextResponsible: { role: 'ALLOCATION_ADMIN' },
    availableActions: ['REFER', 'REFERENCE_CORRECTION', 'ADMINISTRATIVE_REMOVE'],
    impediments: [],
    version: 1,
    ...overrides,
  };
}

async function installCommonRoutes(page: Page, profileId: string, person: typeof admin | typeof moderator) {
  await page.route(`${apiRoot}/access`, async (route) => route.fulfill({ json: { person } }));
  for (const collection of ['groups', 'resource-profiles', 'initiatives']) {
    await page.route(`${apiRoot}/${collection}**`, async (route) => {
      const items = collection === 'groups' ? groups : collection === 'resource-profiles' ? profiles : initiatives;
      await route.fulfill({ json: { items, page: emptyPage } });
    });
  }
  await page.route(`${apiRoot}/submissions**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/requests`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/admin/**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
    key: profileStorageKey,
    value: profileId,
  });
}

test('corrects eligible references, preserves the deadline, and refers the request with the current ETag', async ({ page }) => {
  await installCommonRoutes(page, admin.localUserId, admin);
  let queueItem = requestItem();
  const posted: Array<{ path: string; body: Record<string, string>; headers: Record<string, string> }> = [];
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET') {
      const items = path.endsWith('/presentation') && queueItem.decisionState === 'WAITING_FOR_PRESENTATION'
        ? [queueItem]
        : path.endsWith('/team-decision') && queueItem.decisionState === 'PENDING_TEAM_DECISION' ? [queueItem] : [];
      await route.fulfill({ json: { items, page: emptyPage } });
      return;
    }
  });
  await page.route(`${apiRoot}/requests/**`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON() as Record<string, string>;
    const headers = route.request().headers();
    posted.push({ path, body, headers });
    if (path.endsWith('/reference-corrections')) {
      queueItem = requestItem({
        version: 2,
        requestedConditions: {
          ...queueItem.requestedConditions,
          initiativeId: body.initiativeId ?? 'initiative-a',
          initiativeCode: body.initiativeId === 'initiative-b' ? 'ITDM-63' : 'ITDM-62',
          initiativeName: body.initiativeId === 'initiative-b' ? 'Data modernization' : 'Resource allocation',
          groupId: body.groupId ?? 'group-a',
          groupName: body.groupId === 'group-b' ? 'Data Engineering' : 'Platform Engineering',
          resourceProfileId: body.resourceProfileId ?? 'profile-a',
          resourceProfileName: body.resourceProfileId === 'profile-b' ? 'Data Platform' : 'API Engineering',
        },
      });
      await route.fulfill({ json: queueItem });
      return;
    }
    if (path.endsWith('/referrals')) {
      queueItem = requestItem({
        requestedConditions: queueItem.requestedConditions,
        decisionState: 'PENDING_TEAM_DECISION',
        dueAt: null,
        version: 3,
        availableActions: [],
      });
      await route.fulfill({ json: queueItem });
      return;
    }
    await route.fulfill({ status: 404, json: { status: 404, code: 'RESOURCE_NOT_FOUND' } });
  });

  await page.goto('/resource-allocation/');
  await expect(page.getByRole('heading', { name: 'Request queues' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ITDM-62 — Resource allocation' })).toBeVisible();
  await expect(page.getByText('Presentation deadline')).toBeVisible();
  await page.getByRole('button', { name: 'Correct references' }).click();
  const correctionForm = page.getByRole('form', { name: 'Correct references for request request-a' });
  await correctionForm.getByLabel('ITDM').selectOption('initiative-b');
  await correctionForm.getByLabel('Group').selectOption('group-b');
  await correctionForm.getByLabel('Resource profile').selectOption('profile-b');
  await correctionForm.getByLabel('Reason').fill('The active data group owns this work.');
  await correctionForm.getByRole('button', { name: 'Save reference correction' }).click();

  await expect(page.getByRole('heading', { name: 'ITDM-63 — Data modernization' })).toBeVisible();
  await expect(page.getByText('The active data group owns this work.')).toHaveCount(0);
  expect(posted[0].path).toContain('/requests/request-a/reference-corrections');
  expect(posted[0].headers['if-match']).toBe('"1"');
  expect(posted[0].headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
  expect(posted[0].body).toMatchObject({ initiativeId: 'initiative-b', groupId: 'group-b', resourceProfileId: 'profile-b' });

  await expect(page.getByRole('button', { name: 'Refer to group decision' })).toBeEnabled();
  await page.getByRole('button', { name: 'Refer to group decision' }).click();
  await expect.poll(() => posted.length).toBe(2);
  expect(posted[1].path).toContain('/requests/request-a/referrals');
  expect(posted[1].headers['if-match']).toBe('"2"');
  await page.getByRole('tab', { name: 'Group decision queue' }).click();
  await expect(page.getByRole('heading', { name: 'ITDM-63 — Data modernization' })).toBeVisible();
  await expect(page.getByText('Waiting for group decision')).toBeVisible();
});

test('confirms administrative removal and displays its required reason form', async ({ page }) => {
  await installCommonRoutes(page, admin.localUserId, admin);
  let queueItem: ReturnType<typeof requestItem> | null = requestItem();
  let removal: { body?: Record<string, string>; headers?: Record<string, string> } = {};
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    if (route.request().method() === 'GET') {
      const path = new URL(route.request().url()).pathname;
      await route.fulfill({ json: { items: path.endsWith('/presentation') && queueItem ? [queueItem] : [], page: emptyPage } });
      return;
    }
  });
  await page.route(`${apiRoot}/requests/**`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    removal = { body: route.request().postDataJSON() as Record<string, string>, headers: route.request().headers() };
    queueItem = null;
    await route.fulfill({ json: { requestId: 'request-a', action: 'ADMIN_REMOVED', removedAt: '2026-11-21T15:00:00.000Z' } });
  });

  await page.goto('/resource-allocation/');
  await page.getByRole('button', { name: 'Remove request' }).click();
  await page.getByLabel('Reason').fill('The requester asked Admin to remove the duplicate.');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Confirm removal' }).click();

  await expect(page.getByText('There are no requests in this queue.')).toBeVisible();
  expect(removal.body).toEqual({ reason: 'The requester asked Admin to remove the duplicate.' });
  expect(removal.headers?.['if-match']).toBe('"1"');
  expect(removal.headers?.['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
});

test('opens the Admin group queue and focuses the request from a notification deep link', async ({ page }) => {
  await installCommonRoutes(page, admin.localUserId, admin);
  const teamItem = requestItem({ decisionState: 'PENDING_TEAM_DECISION', dueAt: null, availableActions: [] });
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: { items: path.endsWith('/team-decision') ? [teamItem] : [], page: emptyPage } });
  });

  await page.goto('/resource-allocation/?queue=team-decision&requestId=request-a');
  await expect(page.getByRole('tab', { name: 'Group decision queue' })).toHaveAttribute('aria-selected', 'true');
  const card = page.locator('#resource-request-request-a');
  await expect(card).toBeVisible();
  await expect(card).toBeFocused();
});

test('shows only the scoped decision queue to a Moderator', async ({ page }) => {
  await installCommonRoutes(page, moderator.localUserId, moderator);
  const ownGroupRequest = requestItem({ id: 'request-own', requestedConditions: { ...requestItem().requestedConditions, groupId: 'group-a', groupName: 'Platform Engineering' }, availableActions: [] });
  await page.route(`${apiRoot}/request-queues/**`, async (route) => route.fulfill({ json: { items: [ownGroupRequest], page: emptyPage } }));

  await page.goto('/resource-allocation/');
  await expect(page.getByRole('tab', { name: 'Group decision queue' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Presentation queue' })).toHaveCount(0);
  await expect(page.getByRole('tabpanel').getByText('Platform Engineering')).toBeVisible();
});

test('reuses a pending action key after a lost result and page reload', async ({ page }) => {
  await installCommonRoutes(page, admin.localUserId, admin);
  const queueItem = requestItem();
  const actionHeaders: string[] = [];
  let attempts = 0;
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: { items: path.endsWith('/presentation') ? [queueItem] : [], page: emptyPage } });
  });
  await page.route(`${apiRoot}/requests/**`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    attempts += 1;
    actionHeaders.push(route.request().headers()['idempotency-key']);
    if (attempts === 1) {
      await route.fulfill({ status: 503, json: { title: 'Temporary service interruption.' } });
      return;
    }
    await route.fulfill({ json: requestItem({ decisionState: 'PENDING_TEAM_DECISION', dueAt: null, version: 2, availableActions: [] }) });
  });

  await page.goto('/resource-allocation/');
  await page.getByRole('button', { name: 'Refer to group decision' }).click();
  await expect(page.getByRole('alert')).toContainText('Temporary service interruption.');
  await page.reload();
  await page.getByRole('button', { name: 'Refer to group decision' }).click();

  await expect.poll(() => attempts).toBe(2);
  expect(actionHeaders[0]).toMatch(/^[0-9a-f-]{36}$/i);
  expect(actionHeaders[1]).toBe(actionHeaders[0]);
});

test('keeps cached requests visible and pauses actions when a queue refresh fails', async ({ page }) => {
  await installCommonRoutes(page, admin.localUserId, admin);
  const queueItem = requestItem();
  let failNextRefresh = false;
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    if (failNextRefresh) {
      failNextRefresh = false;
      await route.fulfill({ status: 503, json: { title: 'Queue service is temporarily unavailable.' } });
      return;
    }
    await route.fulfill({ json: { items: [queueItem], page: emptyPage } });
  });

  await page.goto('/resource-allocation/');
  const queue = page.getByRole('region', { name: 'Request queues' });
  await expect(queue.getByRole('heading', { name: 'ITDM-62 — Resource allocation' })).toBeVisible();
  failNextRefresh = true;
  await queue.getByRole('button', { name: 'Refresh queue' }).click();

  await expect(queue.getByText('The queue could not be refreshed. Loaded requests remain visible, but actions are paused until you refresh.')).toBeVisible();
  await expect(queue.getByRole('heading', { name: 'ITDM-62 — Resource allocation' })).toBeVisible();
  await expect(queue.getByRole('button', { name: 'Refer to group decision' })).toBeDisabled();
  await queue.getByRole('button', { name: 'Try again' }).click();
  await expect(queue.getByText('The queue could not be refreshed. Loaded requests remain visible, but actions are paused until you refresh.')).toHaveCount(0);
  await expect(queue.getByRole('button', { name: 'Refer to group decision' })).toBeEnabled();
});
