import { expect, test, type Page, type Request, type Route } from '@playwright/test';

const apiRoot = '**/api/resource-allocation/v1';
const profileStorageKey = 'pmo-hub.local-user-id';
const emptyPage = { nextCursor: null, limit: 50 };
const groupId = 'ac4a8e90-0f75-411e-a433-4aa05649fa50';
const otherGroupId = 'b1c2d3e4-0f75-411e-a433-4aa05649fa51';
const profileId = '2ea514e7-ef80-47a3-a5bb-e8ac4dc36aa9';
const initiativeId = '51d7783e-fd74-4665-a3f6-82c392f407eb';
const createdId = 'f9c6026c-4143-4d78-b5ba-07308b18cff7';

const member = {
  id: 'f2f77176-cc30-46a5-b634-b0218b67286a',
  localUserId: 'profile-member',
  displayName: 'Taylor Member',
  role: 'ALLOCATION_USER',
  groupId,
  coveredGroupIds: [],
};
const moderator = {
  id: 'a1a77176-cc30-46a5-b634-b0218b67286b',
  localUserId: 'profile-moderator',
  displayName: 'Morgan Moderator',
  role: 'ALLOCATION_MODERATOR',
  groupId,
  coveredGroupIds: [],
};
const colleague = { id: 'c0c77176-cc30-46a5-b634-b0218b67286c', displayName: 'Casey Colleague', groupId };

function createdAllocation(body: Record<string, unknown>, person: { id: string; displayName: string }, source: 'SELF' | 'DIRECT') {
  const vacation = body.category === 'VACATION';
  return {
    id: createdId,
    requestId: null,
    source,
    category: body.category,
    classification: 'INTERNAL',
    comment: body.comment ?? null,
    person: { personId: person.id, displayName: person.displayName },
    group: { id: groupId, name: 'Platform Engineering' },
    initiative: body.initiativeId ? { id: initiativeId, code: 'ITDM-77', name: 'Capacity planning' } : null,
    resourceProfile: vacation ? null : { id: profileId, name: 'Cloud Engineering', active: true },
    startDate: body.startDate,
    endDate: body.endDate,
    approvedPeriod: { startDate: body.startDate, endDate: body.endDate },
    weeklyHours: vacation ? 40 : body.weeklyHours,
    state: 'NOT_STARTED',
    approvedAt: '2026-11-24T14:30:00.000Z',
    version: 1,
    availableActions: vacation ? ['CANCEL'] : ['SUSPEND', 'RESERVE', 'CANCEL'],
  };
}

function creation(page: Page) {
  return page.getByRole('region', { name: 'Record an allocation' });
}

async function openAllocations(page: Page, person: typeof member) {
  await page.route(`${apiRoot}/access`, (route) => route.fulfill({ json: { person } }));
  await page.route(`${apiRoot}/requests**`, (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/request-queues/**`, (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/submissions**`, (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/notifications**`, (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/allocation-load**`, (route) => route.fulfill({ json: { date: '2026-11-24', items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/people**`, (route) => route.fulfill({
    json: { items: [{ id: person.id, displayName: person.displayName, groupId }, colleague], page: emptyPage },
  }));
  await page.route(`${apiRoot}/resource-profiles**`, (route) => route.fulfill({
    json: { items: [{ id: profileId, name: 'Cloud Engineering', groupId }], page: emptyPage },
  }));
  await page.route(`${apiRoot}/initiatives**`, (route) => route.fulfill({
    json: { items: [{ id: initiativeId, code: 'ITDM-77', name: 'Capacity planning' }], page: emptyPage },
  }));
  await page.route(`${apiRoot}/admin/resource-profile-groups**`, (route) => route.fulfill({
    json: { items: [{ id: groupId, name: 'Platform Engineering' }, { id: otherGroupId, name: 'Data' }], page: emptyPage },
  }));
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), { key: profileStorageKey, value: person.localUserId });
}

function routeAllocations(page: Page, onCreate: (route: Route, request: Request) => Promise<void> | void) {
  let created: Record<string, unknown> | null = null;
  return page.route(`${apiRoot}/allocations**`, async (route) => {
    const request = route.request();
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/allocations')) {
      await onCreate(route, request);
      return;
    }
    if (new URL(request.url()).pathname.endsWith(`/allocations/${createdId}/history`)) {
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    if (new URL(request.url()).pathname.endsWith(`/allocations/${createdId}`)) {
      await route.fulfill({ json: created, headers: { ETag: '"1"' } });
      return;
    }
    await route.fulfill({ json: { items: created ? [created] : [], page: emptyPage } });
  }).then(() => ({ setCreated: (value: Record<string, unknown>) => { created = value; } }));
}

test('records own Training after review, retries with the same key, and opens the new allocation', async ({ page }) => {
  await openAllocations(page, member);
  const bodies: Array<Record<string, unknown>> = [];
  const keys: string[] = [];
  let attempts = 0;
  const allocations = await routeAllocations(page, async (route, request) => {
    attempts += 1;
    bodies.push(request.postDataJSON() as Record<string, unknown>);
    keys.push(request.headers()['idempotency-key']);
    if (attempts === 1) {
      await route.abort('connectionreset');
      return;
    }
    const created = createdAllocation(bodies[0], member, 'SELF');
    allocations.setCreated(created);
    await route.fulfill({ status: 201, json: created, headers: { ETag: '"1"', Location: `/api/resource-allocation/v1/allocations/${createdId}` } });
  });

  await page.goto('/resource-allocation/?page=allocations');
  await page.getByRole('button', { name: 'Record allocation' }).click();
  await expect(page.getByRole('heading', { name: 'Record an allocation' })).toBeVisible();
  await expect(creation(page).getByLabel('Category')).toBeFocused();
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.locator('optgroup[label="Initiative (ITDM required)"]')).toHaveCount(0);

  await page.getByRole('button', { name: 'Review allocation' }).click();
  await expect(page.getByText('Choose a category.')).toBeVisible();
  await creation(page).getByLabel('Category').selectOption('TRAINING');
  await creation(page).getByLabel('Resource profile').selectOption(profileId);
  await creation(page).getByLabel('Start date').fill('2027-01-04');
  await creation(page).getByLabel('End date (inclusive)').fill('2027-01-08');
  await creation(page).getByLabel('Weekly hours').fill('12,25');
  await page.getByRole('button', { name: 'Review allocation' }).click();
  await expect(page.getByText('Describe the operational activity.')).toBeVisible();
  await creation(page).getByLabel('Activity description').fill('Cloud security course');
  await page.getByRole('button', { name: 'Review allocation' }).click();

  const review = page.locator('.allocation-create-review');
  await expect(review.getByRole('heading', { name: 'Review before recording' })).toBeFocused();
  await expect(review).toContainText('Training');
  await expect(review).toContainText('12.3 hours/week');
  await expect(review).toContainText('Not started');
  await expect(review).toContainText('Your group leadership will be notified.');

  await page.getByRole('button', { name: 'Record allocation', exact: true }).last().click();
  await expect(page.getByRole('alert')).toContainText('Retry to resend the same allocation without creating a duplicate.');
  await page.getByRole('button', { name: 'Retry recording' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Training was recorded for Taylor Member.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Record an allocation' })).toHaveCount(0);
  const detail = page.getByRole('region', { name: 'Allocation details' });
  await expect(detail).toContainText('Own allocation');
  await expect(detail).toContainText('Cloud security course');
  await expect(detail).toContainText('Internal');
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(bodies[0]).toEqual({
    category: 'TRAINING',
    resourceProfileId: profileId,
    startDate: '2027-01-04',
    endDate: '2027-01-08',
    weeklyHours: 12.3,
    comment: 'Cloud security course',
  });
  expect(new URL(page.url()).searchParams.get('allocationId')).toBe(createdId);
});

test('keeps entries and highlights the field when the server rejects a reference', async ({ page }) => {
  await openAllocations(page, member);
  await routeAllocations(page, (route) => route.fulfill({
    status: 422,
    contentType: 'application/problem+json',
    json: {
      status: 422,
      code: 'INVALID_ALLOCATION_REFERENCE',
      detail: 'Choose an active resource profile from the person’s group.',
      errors: [{ path: 'resourceProfileId', code: 'INVALID_REFERENCE', message: 'Choose an active resource profile from the person’s group.' }],
    },
  }));
  await page.goto('/resource-allocation/?page=allocations');
  await page.getByRole('button', { name: 'Record allocation' }).click();
  await creation(page).getByLabel('Category').selectOption('ROUTINE_SUPPORT');
  await creation(page).getByLabel('Resource profile').selectOption(profileId);
  await creation(page).getByLabel('Weekly hours').fill('8');
  await creation(page).getByLabel('Activity description').fill('Support rotation');
  await page.getByRole('button', { name: 'Review allocation' }).click();
  await page.getByRole('button', { name: 'Record allocation', exact: true }).last().click();

  await expect(creation(page).getByLabel('Resource profile')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#create-profile-error')).toHaveText('Choose an active resource profile from the person’s group.');
  await expect(creation(page).getByLabel('Activity description')).toHaveValue('Support rotation');
  await expect(creation(page).getByLabel('Weekly hours')).toHaveValue('8');
});

test('records Vacation with fixed hours and no profile field', async ({ page }) => {
  await openAllocations(page, member);
  let body: Record<string, unknown> | null = null;
  const allocations = await routeAllocations(page, async (route, request) => {
    body = request.postDataJSON() as Record<string, unknown>;
    const created = createdAllocation(body, member, 'SELF');
    allocations.setCreated(created);
    await route.fulfill({ status: 201, json: created, headers: { ETag: '"1"' } });
  });
  await page.goto('/resource-allocation/?page=allocations');
  await page.getByRole('button', { name: 'Record allocation' }).click();
  await creation(page).getByLabel('Category').selectOption('VACATION');
  await expect(creation(page).getByLabel('Resource profile')).toHaveCount(0);
  await expect(creation(page).getByLabel('Weekly hours')).toHaveCount(0);
  await expect(page.getByText('Vacation always uses 40 weekly hours and no resource profile.')).toBeVisible();
  await creation(page).getByLabel('Start date').fill('2027-02-01');
  await creation(page).getByLabel('End date (inclusive)').fill('2027-02-12');
  await page.getByRole('button', { name: 'Review allocation' }).click();
  await expect(page.locator('.allocation-create-review')).toContainText('Not used for Vacation');
  await expect(page.locator('.allocation-create-review')).toContainText('40.0 hours/week');
  await page.getByRole('button', { name: 'Record allocation', exact: true }).last().click();
  await expect(page.getByRole('region', { name: 'Allocation details' })).toContainText('Vacation');
  expect(body).toEqual({ category: 'VACATION', startDate: '2027-02-01', endDate: '2027-02-12' });
  const actions = page.getByRole('group', { name: 'Available allocation actions' }).or(page.locator('.allocation-actions'));
  await expect(actions.getByRole('button', { name: 'Suspend' })).toHaveCount(0);
  await expect(actions.getByRole('button', { name: 'Reserve without action' })).toHaveCount(0);
});

test('lets a Moderator allocate initiative work directly to a person in scope', async ({ page }) => {
  await openAllocations(page, moderator);
  let body: Record<string, unknown> | null = null;
  const allocations = await routeAllocations(page, async (route, request) => {
    body = request.postDataJSON() as Record<string, unknown>;
    const created = createdAllocation(body, colleague, 'DIRECT');
    allocations.setCreated(created);
    await route.fulfill({ status: 201, json: created, headers: { ETag: '"1"' } });
  });
  await page.goto('/resource-allocation/?page=allocations');
  await page.getByRole('button', { name: 'Record allocation' }).click();
  await page.getByRole('radio', { name: 'A person in my scope' }).check();
  await creation(page).getByLabel(/^Group/).selectOption(groupId);
  await expect(creation(page).getByLabel(/^Person/).locator('option', { hasText: moderator.displayName })).toHaveCount(0);
  await creation(page).getByLabel(/^Person/).selectOption(colleague.id);
  await creation(page).getByLabel('Category').selectOption('EXECUTION_PROJECT');
  await creation(page).getByLabel('ITDM initiative').selectOption(initiativeId);
  await creation(page).getByLabel('Resource profile').selectOption(profileId);
  await creation(page).getByLabel('Start date').fill('2026-11-02');
  await creation(page).getByLabel('End date (inclusive)').fill('2026-11-20');
  await creation(page).getByLabel('Weekly hours').fill('20');
  await page.getByRole('button', { name: 'Review allocation' }).click();
  const review = page.locator('.allocation-create-review');
  await expect(review).toContainText('Casey Colleague');
  await expect(review).toContainText('ITDM-77 · Capacity planning');
  await expect(review).toContainText('Done');
  await expect(review).toContainText('Casey Colleague will be notified.');
  await page.getByRole('button', { name: 'Record allocation', exact: true }).last().click();
  await expect(page.getByRole('region', { name: 'Allocation details' })).toContainText('Direct allocation');
  expect(body).toEqual({
    personId: colleague.id,
    category: 'EXECUTION_PROJECT',
    resourceProfileId: profileId,
    initiativeId,
    startDate: '2026-11-02',
    endDate: '2026-11-20',
    weeklyHours: 20,
  });
});

test('protects unsaved creation entries when leaving the area', async ({ page }) => {
  await openAllocations(page, member);
  await routeAllocations(page, (route) => route.fulfill({ status: 500, json: {} }));
  await page.goto('/resource-allocation/?page=allocations');
  await page.getByRole('button', { name: 'Record allocation' }).click();
  await creation(page).getByLabel('Category').selectOption('TRAINING');
  await creation(page).getByLabel('Weekly hours').fill('5');

  const prompt = page.waitForEvent('dialog');
  const navigate = page.getByRole('link', { name: 'Requests', exact: true }).first().click();
  const dialog = await prompt;
  expect(dialog.message()).toMatch(/unsaved changes/i);
  await dialog.dismiss();
  await navigate;
  await expect(creation(page).getByLabel('Weekly hours')).toHaveValue('5');
  await expect(page.getByRole('heading', { name: 'Record an allocation' })).toBeVisible();
});

test('captures the creation form in both themes, desktop and narrow, with keyboard focus and 200% zoom', async ({ page }, testInfo) => {
  await openAllocations(page, moderator);
  await routeAllocations(page, (route) => route.fulfill({ status: 500, json: {} }));
  await page.goto('/resource-allocation/?page=allocations');
  await page.getByRole('button', { name: 'Record allocation' }).click();
  await page.getByRole('radio', { name: 'A person in my scope' }).check();
  await creation(page).getByLabel('Category').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Review allocation' }).or(creation(page).getByLabel('Start date'))).toHaveCount(2);

  for (const theme of ['Light', 'Dark'] as const) {
    await page.getByRole('button', { name: moderator.displayName }).click();
    await page.getByRole('button', { name: theme }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.toLowerCase());
    await page.getByRole('button', { name: moderator.displayName }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('heading', { name: 'Record an allocation' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`allocation-create-${theme.toLowerCase()}-desktop.png`), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('heading', { name: 'Record an allocation' }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`allocation-create-${theme.toLowerCase()}-narrow.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { document.body.style.zoom = '200%'; });
  await page.getByRole('button', { name: 'Review allocation' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Review allocation' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('allocation-create-dark-zoom-200.png'), fullPage: true });
});
