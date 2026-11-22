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

const requester = {
  id: 'requester-id',
  localUserId: 'profile-requester',
  displayName: 'Jordan Requester',
  role: 'ALLOCATION_USER',
  groupId: null,
  coveredGroupIds: [],
};

const itemId = 'request-exception';
const people = [
  { id: 'person-a', displayName: 'Alex Engineer', groupId: 'group-a' },
  { id: 'person-b', displayName: 'Sam Engineer', groupId: 'group-a' },
];
const profiles = [
  { id: 'profile-a', name: 'API Engineering', groupId: 'group-a' },
  { id: 'profile-b', name: 'Platform Integration', groupId: 'group-a' },
];
const initiatives = [
  { id: 'initiative-a', code: 'ITDM-66', name: 'Resource planning' },
  { id: 'initiative-b', code: 'ITDM-67', name: 'Platform migration' },
];

function exceptionItem(overrides: Record<string, unknown> = {}) {
  return {
    id: itemId,
    requester: { personId: requester.id, displayName: requester.displayName, role: requester.role },
    requestedConditions: {
      initiativeId: 'initiative-a',
      initiativeCode: 'ITDM-66',
      initiativeName: 'Resource planning',
      groupId: 'group-a',
      groupName: 'Platform Engineering',
      resourceProfileId: 'profile-a',
      resourceProfileName: 'API Engineering',
      startDate: '2027-01-11',
      endDate: '2027-01-29',
      weeklyHours: 20,
      comment: 'Support the approved work.',
    },
    decisionState: 'PRE_N3',
    receivedAt: '2026-11-20T15:00:00.000Z',
    stageEnteredAt: '2026-11-20T16:00:00.000Z',
    dueAt: null,
    nextResponsible: { role: 'ALLOCATION_ADMIN' },
    availableActions: ['ESCALATE', 'CANCEL', 'RECORD_STRATEGY', 'RESOLVE'],
    impediments: [],
    version: 3,
    ...overrides,
  };
}

async function installAdminRoutes(page: Page, initialItem = exceptionItem()) {
  let currentItem: ReturnType<typeof exceptionItem> | null = initialItem;
  const commands: Array<{ path: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const queueRequests: URL[] = [];

  await page.route(`${apiRoot}/access`, async (route) => route.fulfill({ json: { person: admin } }));
  for (const collection of ['groups', 'resource-profiles', 'initiatives']) {
    await page.route(`${apiRoot}/${collection}**`, async (route) => {
      const items = collection === 'groups' ? [{ id: 'group-a', name: 'Platform Engineering' }]
        : collection === 'resource-profiles' ? profiles : initiatives;
      await route.fulfill({ json: { items, page: emptyPage } });
    });
  }
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const url = new URL(route.request().url());
    queueRequests.push(url);
    const path = url.pathname;
    const items = path.endsWith('/exceptions') && currentItem ? [currentItem] : [];
    await route.fulfill({ json: { items, page: emptyPage } });
  });
  await page.route(`${apiRoot}/requests/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path.endsWith('/approval-candidates')) {
      await route.fulfill({ json: { items: people, page: emptyPage } });
      return;
    }
    if (request.method() === 'GET') {
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    commands.push({ path, body: request.postDataJSON() as Record<string, unknown>, headers: request.headers() });
    const body = request.postDataJSON() as Record<string, unknown>;
    if (path.endsWith('/strategies')) {
      currentItem = exceptionItem({
        version: Number(request.headers()['if-match']?.replaceAll('"', '') ?? 3) + 1,
        resolutionStrategy: body.strategy,
        resolutionReason: body.reason,
        affectedInitiativeIds: body.affectedInitiativeIds ?? [],
      });
      await route.fulfill({ json: currentItem });
      return;
    }
    if (path.endsWith('/escalations')) {
      currentItem = exceptionItem({ decisionState: 'ESCALATION', version: 4, availableActions: ['CANCEL', 'RECORD_STRATEGY', 'RESOLVE'] });
      await route.fulfill({ json: currentItem });
      return;
    }
    if (path.endsWith('/resolutions')) {
      currentItem = null;
      await route.fulfill({ json: { ...exceptionItem(), decisionState: 'APPROVED', version: 4 } });
      return;
    }
    if (path.endsWith('/cancellations')) {
      currentItem = null;
      await route.fulfill({ json: { ...exceptionItem(), decisionState: 'CANCELLED', version: 4 } });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/problem+json', json: { status: 404, code: 'RESOURCE_NOT_FOUND' } });
  });
  await page.route(`${apiRoot}/submissions**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/notifications**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/admin/**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), { key: profileStorageKey, value: admin.localUserId });

  return {
    commands,
    queueRequests,
    getCurrentItem: () => currentItem,
    setCurrentItem: (item: ReturnType<typeof exceptionItem> | null) => { currentItem = item; },
  };
}

test('shows a global exception queue only to Admin and respects server actions', async ({ page }) => {
  const { getCurrentItem, queueRequests } = await installAdminRoutes(page, exceptionItem({ availableActions: ['ESCALATE'] }));
  await page.goto('/resource-allocation/?queue=exceptions');

  await expect(page.getByRole('tab', { name: 'Admin exceptions' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Pre N3' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Escalation' })).toBeVisible();
  await expect(page.getByRole('article', { name: /ITDM-66/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Escalate request' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record strategy' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel request' })).toHaveCount(0);
  expect(getCurrentItem()?.decisionState).toBe('PRE_N3');

  await page.getByRole('tab', { name: 'Pre N3' }).click();
  const filters = page.getByRole('group', { name: 'Filter exceptions' });
  await filters.getByRole('combobox', { name: 'Group' }).selectOption('group-a');
  await filters.getByRole('combobox', { name: 'ITDM' }).selectOption('initiative-b');
  await filters.getByRole('combobox', { name: 'Resource profile' }).selectOption('profile-b');
  await expect.poll(() => queueRequests.some((url) => url.searchParams.get('decisionState') === 'PRE_N3'
    && url.searchParams.get('groupId') === 'group-a'
    && url.searchParams.get('initiativeId') === 'initiative-b'
    && url.searchParams.get('resourceProfileId') === 'profile-b')).toBe(true);
});

test('does not expose the global exception queue to a requester', async ({ page }) => {
  await page.route(`${apiRoot}/access`, async (route) => route.fulfill({ json: { person: requester } }));
  for (const collection of ['groups', 'resource-profiles', 'initiatives']) {
    await page.route(`${apiRoot}/${collection}**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  }
  await page.route(`${apiRoot}/request-queues/**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/submissions**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/notifications**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/requests**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), { key: profileStorageKey, value: requester.localUserId });
  await page.goto('/resource-allocation/?page=request-queues');

  await expect(page.getByRole('tab', { name: 'Admin exceptions' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Pre N3' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Escalation' })).toHaveCount(0);
});

test('records a strategy with its reason and affected ITDMs without resolving the request', async ({ page }) => {
  const { commands, getCurrentItem } = await installAdminRoutes(page);
  await page.goto('/resource-allocation/?queue=exceptions');

  await page.getByRole('button', { name: 'Record strategy' }).click();
  const form = page.getByRole('form', { name: `Resolve exception ${itemId}` });
  await form.getByLabel('Resolution strategy').selectOption('DEPRIORITIZE_OTHER_DEMANDS');
  await form.getByLabel('Reason').fill('Move capacity to the migration work first.');
  await expect(form.getByRole('checkbox', { name: /ITDM-67/ })).toBeVisible();
  await form.getByRole('button', { name: 'Record strategy' }).click();
  await expect(form.getByText('Select at least one affected ITDM.')).toBeVisible();
  expect(commands).toHaveLength(0);

  await form.getByRole('checkbox', { name: /ITDM-67/ }).check();
  await form.getByRole('button', { name: 'Record strategy' }).click();
  await expect(page.getByText('Recorded strategy: Deprioritize other demands')).toBeVisible();
  await expect(page.getByText(/Move capacity to the migration work first/)).toBeVisible();
  await expect(page.locator('.request-exception-recorded-strategy').getByText(/ITDM-67/)).toBeVisible();
  expect(commands[0].path).toBe(`/api/resource-allocation/v1/requests/${itemId}/strategies`);
  expect(commands[0].body).toEqual({
    strategy: 'DEPRIORITIZE_OTHER_DEMANDS',
    reason: 'Move capacity to the migration work first.',
    affectedInitiativeIds: ['initiative-b'],
  });
  expect(commands[0].headers['if-match']).toBe('"3"');
  expect(commands[0].headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
  expect(getCurrentItem()?.decisionState).toBe('PRE_N3');
});

test('resolves a strategy only after complete final conditions are entered', async ({ page }) => {
  const { commands, getCurrentItem } = await installAdminRoutes(page);
  await page.goto('/resource-allocation/?queue=exceptions');

  await page.getByRole('button', { name: 'Record strategy' }).click();
  const form = page.getByRole('form', { name: `Resolve exception ${itemId}` });
  await form.getByLabel('Resolution strategy').selectOption('WAIT_FOR_EMB_RESOURCE');
  await form.getByLabel('Reason').fill('Wait for the EMB resource to become available.');
  await form.getByLabel('Resolution action').selectOption('resolve');
  await expect(form.getByLabel('Eligible person')).toBeVisible();
  await expect(form.getByLabel('Final start date')).toHaveValue('2027-01-11');
  await form.getByLabel('Eligible person').selectOption('person-a');
  await form.getByLabel('Final resource profile').selectOption('profile-b');
  await form.getByLabel('Final start date').fill('2027-01-12');
  await form.getByLabel('Final end date').fill('2027-01-30');
  await form.getByLabel('Final weekly hours').fill('16.5');
  await form.getByRole('button', { name: 'Resolve and approve' }).click();

  await expect(page.getByText('There are no requests in this queue.')).toBeVisible();
  expect(commands[0].path).toBe(`/api/resource-allocation/v1/requests/${itemId}/resolutions`);
  expect(commands[0].body).toEqual({
    strategy: 'WAIT_FOR_EMB_RESOURCE',
    reason: 'Wait for the EMB resource to become available.',
    personId: 'person-a',
    resourceProfileId: 'profile-b',
    startDate: '2027-01-12',
    endDate: '2027-01-30',
    weeklyHours: 16.5,
  });
  expect(commands[0].headers['if-match']).toBe('"3"');
  expect(commands[0].headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
  expect(getCurrentItem()).toBeNull();
});

test('escalates with a reason and does not offer resolution to the Admin requester', async ({ page }) => {
  const ownRequest = exceptionItem({ requester: { personId: admin.id, displayName: admin.displayName, role: admin.role } });
  const { commands } = await installAdminRoutes(page, ownRequest);
  await page.goto('/resource-allocation/?queue=exceptions');

  await expect(page.getByText('You cannot resolve your own request.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Escalate request' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Record strategy' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel request' })).toHaveCount(0);
  expect(commands).toHaveLength(0);
});

test('uses reasons to escalate and cancel when the server authorizes each action', async ({ page }) => {
  const { commands } = await installAdminRoutes(page);
  await page.goto('/resource-allocation/?queue=exceptions');

  await page.getByRole('button', { name: 'Escalate request' }).click();
  const escalationForm = page.getByRole('form', { name: `Escalate exception ${itemId}` });
  await escalationForm.getByLabel('Reason').fill('The requester supplied a revised scope for review.');
  await escalationForm.getByRole('button', { name: 'Confirm escalation' }).click();
  await expect(page.getByRole('article', { name: /ITDM-66/ })).toContainText('ESCALATION');

  await page.getByRole('button', { name: 'Cancel request' }).click();
  const cancellationForm = page.getByRole('form', { name: `Cancel exception ${itemId}` });
  await cancellationForm.getByLabel('Reason').fill('The initiative owner withdrew the demand.');
  await cancellationForm.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(page.getByText('There are no requests in this queue.')).toBeVisible();

  expect(commands.map((command) => ({ path: command.path, body: command.body }))).toEqual([
    { path: `/api/resource-allocation/v1/requests/${itemId}/escalations`, body: { reason: 'The requester supplied a revised scope for review.' } },
    { path: `/api/resource-allocation/v1/requests/${itemId}/cancellations`, body: { reason: 'The initiative owner withdrew the demand.' } },
  ]);
  expect(commands[0].headers['if-match']).toBe('"3"');
  expect(commands[1].headers['if-match']).toBe('"4"');
  for (const command of commands) expect(command.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
});

test('keeps the reason after a 412 and retries with the refreshed version', async ({ page }) => {
  const { setCurrentItem } = await installAdminRoutes(page);
  let attempts = 0;
  const versions: string[] = [];
  await page.route(`${apiRoot}/requests/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'POST' || !path.endsWith('/strategies')) {
      await route.fallback();
      return;
    }
    attempts += 1;
    versions.push(request.headers()['if-match']);
    if (attempts === 1) {
      setCurrentItem(exceptionItem({ version: 4 }));
      await route.fulfill({ status: 412, contentType: 'application/problem+json', json: { status: 412, code: 'PRECONDITION_FAILED', detail: 'The request changed.' } });
      return;
    }
    setCurrentItem(exceptionItem({ version: 5, resolutionStrategy: 'OUTSOURCE' }));
    await route.fulfill({ json: exceptionItem({ version: 5, resolutionStrategy: 'OUTSOURCE' }) });
  });
  await page.goto('/resource-allocation/?queue=exceptions');

  await page.getByRole('button', { name: 'Record strategy' }).click();
  const form = page.getByRole('form', { name: `Resolve exception ${itemId}` });
  await form.getByLabel('Reason').fill('Use an external partner for the first release.');
  await form.getByRole('button', { name: 'Record strategy' }).click();
  await expect(page.getByText(/Your entries are preserved/)).toBeVisible();
  await expect(form.getByLabel('Reason')).toHaveValue('Use an external partner for the first release.');
  await form.getByRole('button', { name: 'Record strategy' }).click();

  await expect(page.getByText('Recorded strategy: Outsource')).toBeVisible();
  expect(attempts).toBe(2);
  expect(versions).toEqual(['"3"', '"4"']);
});

test('reuses an idempotency key when retrying an uncertain strategy command', async ({ page }) => {
  const { setCurrentItem } = await installAdminRoutes(page);
  let attempts = 0;
  const idempotencyKeys: string[] = [];
  const versions: string[] = [];
  await page.route(`${apiRoot}/requests/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'POST' || !path.endsWith('/strategies')) {
      await route.fallback();
      return;
    }
    attempts += 1;
    idempotencyKeys.push(request.headers()['idempotency-key']);
    versions.push(request.headers()['if-match']);
    if (attempts === 1) {
      await route.fulfill({ status: 503, contentType: 'application/problem+json', json: { status: 503, code: 'DEPENDENCY_UNAVAILABLE', detail: 'Service unavailable.' } });
      return;
    }
    const saved = exceptionItem({ version: 4, resolutionStrategy: 'OUTSOURCE' });
    setCurrentItem(saved);
    await route.fulfill({ json: saved });
  });
  await page.goto('/resource-allocation/?queue=exceptions');

  await page.getByRole('button', { name: 'Record strategy' }).click();
  const form = page.getByRole('form', { name: `Resolve exception ${itemId}` });
  await form.getByLabel('Reason').fill('Use an external partner for the first release.');
  await form.getByRole('button', { name: 'Record strategy' }).click();
  await expect(page.getByText('Service unavailable.')).toBeVisible();
  await form.getByRole('button', { name: 'Record strategy' }).click();

  await expect(page.getByText('Recorded strategy: Outsource')).toBeVisible();
  expect(attempts).toBe(2);
  expect(idempotencyKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
  expect(versions).toEqual(['"3"', '"3"']);
});
