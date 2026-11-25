import { expect, test, type Page } from '@playwright/test';

const apiRoot = '**/api/resource-allocation/v1';
const profileStorageKey = 'pmo-hub.local-user-id';
const localUserId = 'profile-capacity-admin';
const groupId = '0e38ea81-5c51-4a48-a9ec-8a9c90fb8464';
const activeProfileId = '8e87b18c-6db5-46e8-9e33-6c0e9c89726e';
const inactiveProfileId = '5b8511b0-02cb-4b3c-9cff-e0173f1d47cb';
const capacityId = 'e2f55af1-4d69-4f31-a818-3b8c24607903';
const emptyPage = { nextCursor: null, limit: 50 };

const admin = {
  id: '71847999-3f3c-41df-b026-20ac20e31c91',
  localUserId,
  displayName: 'Morgan Admin',
  role: 'ALLOCATION_ADMIN',
  groupId: null,
  coveredGroupIds: [],
};

function capacity(overrides: Record<string, unknown> = {}) {
  return {
    id: capacityId,
    group: { id: groupId, name: 'Platform Engineering' },
    resourceProfile: { id: inactiveProfileId, name: 'Cloud Engineering', active: false },
    classification: 'INTERNAL',
    effectiveDate: '2026-11-24',
    effectiveUntil: null,
    fte: 1.2,
    version: 3,
    ...overrides,
  };
}

async function installBaseRoutes(page: Page, person: typeof admin = admin) {
  await page.route(`${apiRoot}/access`, (route) => route.fulfill({ json: { person } }));
  await page.route(`${apiRoot}/request-queues/**`, (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/requests**`, (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/submissions**`, (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/notifications**`, (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/groups**`, (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/resource-profiles**`, (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/initiatives**`, (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/capacity-comparison**`, (route) => route.fulfill({ json: { businessDate: '2026-11-24', vacationIncluded: true, weeks: [] } }));
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
    key: profileStorageKey,
    value: person.localUserId,
  });
}

async function openCapacity(page: Page) {
  await installBaseRoutes(page);
  await page.route(`${apiRoot}/capacity-options`, (route) => route.fulfill({ json: {
    groups: [{
      id: groupId,
      name: 'Platform Engineering',
      resourceProfiles: [
        { id: activeProfileId, name: 'Application Engineering', active: true },
      ],
    }],
  } }));
  const entries: Array<ReturnType<typeof capacity>> = [];
  await page.route(`${apiRoot}/capacities**`, async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const input = request.postDataJSON();
      const created = capacity({
        id: '06ec1bb9-32bf-4c8e-ac8e-d69044af1cd9',
        group: { id: groupId, name: 'Platform Engineering' },
        resourceProfile: { id: activeProfileId, name: 'Application Engineering', active: true },
        classification: input.classification,
        effectiveDate: input.effectiveDate,
        fte: Math.round(input.fte * 10) / 10,
        version: 1,
      });
      entries.push(created);
      return route.fulfill({ status: 201, headers: { location: `/api/resource-allocation/v1/capacities/${created.id}`, etag: '"1"' }, json: created });
    }
    return route.fulfill({ json: { items: entries, page: emptyPage } });
  });
  await page.goto('/resource-allocation/?page=capacity');
}

test('creates and lists dated FTE capacity, requires a reason, and rounds to one decimal place', async ({ page }) => {
  await openCapacity(page);
  await expect(page.getByRole('heading', { name: 'Capacity', exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'No capacity entries' })).toBeVisible();

  const createRequest = page.waitForRequest((request) => request.url().endsWith('/capacities') && request.method() === 'POST');
  await page.getByRole('button', { name: 'Add capacity' }).first().click();
  await expect(page.getByLabel('Group Required')).toBeFocused();
  await page.getByLabel('Group Required').selectOption(groupId);
  await page.getByLabel('Resource profile Required').selectOption(activeProfileId);
  await page.getByLabel('Classification Required').selectOption('THIRD_PARTY');
  await page.getByLabel('Effective from Required').fill('2026-11-24');
  await page.getByLabel('Capacity FTE').fill('0.15');
  await page.getByRole('button', { name: 'Save capacity' }).click();
  await expect(page.getByText('Enter a reason for this change.')).toBeVisible();
  await page.getByLabel('Reason Required').fill('Quarterly staffing plan');
  await page.getByRole('button', { name: 'Save capacity' }).click();

  const request = await createRequest;
  expect(request.headers()['idempotency-key']).toBeTruthy();
  expect(request.postDataJSON()).toMatchObject({
    groupId,
    resourceProfileId: activeProfileId,
    classification: 'THIRD_PARTY',
    effectiveDate: '2026-11-24',
    fte: 0.15,
    reason: 'Quarterly staffing plan',
  });
  await expect(page.getByRole('listitem').getByText('0.2 FTE')).toBeVisible();
});

test('shows capacity for an inactive profile and permits an authorized correction', async ({ page }) => {
  await installBaseRoutes(page);
  await page.route(`${apiRoot}/capacity-options`, (route) => route.fulfill({ json: {
    groups: [{ id: groupId, name: 'Platform Engineering', resourceProfiles: [{ id: activeProfileId, name: 'Application Engineering', active: true }] }],
  } }));
  let current = capacity();
  await page.route(`${apiRoot}/capacities**`, async (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: { items: [current], page: emptyPage } });
    if (request.method() === 'PATCH') {
      expect(request.headers()['if-match']).toBe('"3"');
      expect(request.headers()['idempotency-key']).toBeTruthy();
      current = { ...current, ...request.postDataJSON(), version: 4 };
      return route.fulfill({ headers: { etag: '"4"' }, json: current });
    }
    return route.fallback();
  });
  await page.goto('/resource-allocation/?page=capacity');

  const card = page.getByRole('listitem').filter({ hasText: 'Cloud Engineering' });
  await expect(card.getByText('Inactive profile')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Edit' })).toBeEnabled();
  await card.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByText('Inactive', { exact: true })).toBeVisible();
  await page.getByLabel('Capacity FTE').fill('2.5');
  await page.getByLabel('Reason Required').fill('Corrected capacity forecast');
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(page.getByText('Capacity entry updated.')).toBeVisible();
  await expect(page.getByText('2.5 FTE', { exact: true })).toBeVisible();
});

test('keeps removal history visible and guards navigation with unsaved capacity changes', async ({ page }) => {
  await installBaseRoutes(page);
  await page.route(`${apiRoot}/capacity-options`, (route) => route.fulfill({ json: {
    groups: [{ id: groupId, name: 'Platform Engineering', resourceProfiles: [{ id: activeProfileId, name: 'Application Engineering', active: true }] }],
  } }));
  let removed = false;
  const current = capacity({ resourceProfile: { id: activeProfileId, name: 'Application Engineering', active: true } });
  await page.route(`${apiRoot}/capacities**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith(`/capacities/${capacityId}/history`)) {
      return route.fulfill({ json: { items: [{
        id: '52ad8772-7d3b-4764-8415-93c488be6f11',
        action: 'REMOVED',
        actor: { id: admin.id, displayName: admin.displayName },
        reason: 'Team plan ended',
        before: current,
        after: null,
        occurredAt: '2026-11-23T14:30:00.123456Z',
      }], page: emptyPage } });
    }
    if (request.method() === 'DELETE') {
      expect(request.headers()['if-match']).toBe('"3"');
      expect(request.postDataJSON()).toEqual({ reason: 'Team plan ended' });
      removed = true;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: { items: removed ? [] : [current], page: emptyPage } });
  });
  await page.goto('/resource-allocation/?page=capacity');
  const card = page.getByRole('listitem').filter({ hasText: 'Application Engineering' });
  await card.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Capacity FTE').fill('3');

  let dialogMessage = '';
  page.once('dialog', async (dialog) => {
    dialogMessage = dialog.message();
    await dialog.dismiss();
  });
  await page.getByRole('link', { name: 'Allocations and capacity' }).click();
  expect(dialogMessage).toContain('unsaved changes');
  await expect(page.getByRole('region', { name: /Application Engineering · Internal/ })).toContainText('Edit capacity entry');
  await expect(page.getByLabel('Capacity FTE')).toHaveValue('3');

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
  const currentCard = page.getByRole('listitem').filter({ hasText: 'Application Engineering' });
  await currentCard.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('button', { name: 'Remove capacity' }).click();
  await expect(page.getByText('Enter a reason for removing this capacity entry.')).toBeVisible();
  await page.getByLabel('Reason for removal Required').fill('Team plan ended');
  await page.getByRole('button', { name: 'Remove capacity' }).click();
  await expect(page.getByRole('heading', { name: 'Capacity changes' })).toBeVisible();
  await expect(page.getByText('Team plan ended')).toBeVisible();
  expect(removed).toBe(true);
});

test('keeps capacity navigation unavailable to a common user', async ({ page }) => {
  const commonUser = { ...admin, role: 'ALLOCATION_USER' };
  await page.route(`${apiRoot}/access`, (route) => route.fulfill({ json: { person: commonUser } }));
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), { key: profileStorageKey, value: localUserId });
  let capacityRequests = 0;
  await page.route(`${apiRoot}/capacity-options`, (route) => { capacityRequests += 1; return route.fulfill({ json: { groups: [] } }); });
  await page.goto('/resource-allocation/?page=capacity');

  await expect(page.getByText('Capacity is available to leaders in scope and Admins.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Capacity', exact: true })).toHaveCount(0);
  expect(capacityRequests).toBe(0);
});


test('captures capacity in both themes, desktop and narrow, with keyboard focus and 200% zoom', async ({ page }, testInfo) => {
  await installBaseRoutes(page);
  await page.route(`${apiRoot}/capacity-options`, (route) => route.fulfill({ json: {
    groups: [{ id: groupId, name: 'Platform Engineering', resourceProfiles: [{ id: activeProfileId, name: 'Application Engineering', active: true }] }],
  } }));
  await page.route(`${apiRoot}/capacities**`, (route) => route.fulfill({ json: { items: [capacity()], page: emptyPage } }));
  await page.goto('/resource-allocation/?page=capacity');
  await page.getByRole('button', { name: 'Add capacity' }).first().click();
  await expect(page.getByLabel('Group Required')).toBeFocused();
  await page.getByLabel('Group Required').selectOption(groupId);
  await page.getByLabel('Group Required').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Resource profile Required')).toBeFocused();

  for (const theme of ['Light', 'Dark'] as const) {
    await page.getByRole('button', { name: admin.displayName }).click();
    await page.getByRole('button', { name: theme }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.toLowerCase());
    await page.getByRole('button', { name: admin.displayName }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: testInfo.outputPath(`capacity-${theme.toLowerCase()}-desktop.png`), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`capacity-${theme.toLowerCase()}-narrow.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { document.body.style.zoom = '200%'; });
  await page.getByRole('button', { name: 'Save capacity' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Save capacity' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('capacity-dark-zoom-200.png'), fullPage: true });
});

test('locks past entries for a leader and explains a version conflict without losing the edit', async ({ page }) => {
  const moderator = { ...admin, id: '91847999-3f3c-41df-b026-20ac20e31c92', localUserId: 'profile-capacity-moderator', displayName: 'Riley Moderator', role: 'ALLOCATION_MODERATOR', groupId };
  await installBaseRoutes(page, moderator);
  await page.route(`${apiRoot}/capacity-options`, (route) => route.fulfill({ json: {
    groups: [{ id: groupId, name: 'Platform Engineering', resourceProfiles: [{ id: activeProfileId, name: 'Application Engineering', active: true }] }],
  } }));
  const pastEntry = capacity({ id: '11111111-4d69-4f31-a818-3b8c24607903', effectiveDate: '2001-01-01', effectiveUntil: '2099-12-31', resourceProfile: { id: activeProfileId, name: 'Legacy Engineering', active: true } });
  const futureEntry = capacity({ effectiveDate: '2099-12-31', resourceProfile: { id: activeProfileId, name: 'Application Engineering', active: true } });
  await page.route(`${apiRoot}/capacities**`, async (route) => {
    if (route.request().method() === 'PATCH') {
      return route.fulfill({ status: 412, contentType: 'application/problem+json', json: { status: 412, code: 'PRECONDITION_FAILED', detail: 'The capacity entry changed.' } });
    }
    return route.fulfill({ json: { items: [pastEntry, futureEntry], page: emptyPage } });
  });
  await page.goto('/resource-allocation/?page=capacity');
  const pastCard = page.getByRole('listitem').filter({ hasText: 'Legacy Engineering' });
  await expect(pastCard).toContainText('Past capacity entries can only be corrected by an Admin.');
  await expect(pastCard).toContainText('Dec 31, 2099');
  await expect(pastCard.getByRole('button', { name: 'Edit' })).toBeDisabled();
  await expect(pastCard.getByRole('button', { name: 'Remove' })).toBeDisabled();

  const futureCard = page.getByRole('listitem').filter({ hasText: 'Application Engineering' });
  await expect(futureCard).toContainText('No later entry');
  await futureCard.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Capacity FTE').fill('2,5');
  await page.getByLabel('Reason Required').fill('Hiring plan');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert')).toContainText('changed in another session');
  await expect(page.getByLabel('Capacity FTE')).toHaveValue('2,5');
});
