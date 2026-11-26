import { expect, test, type Page, type Request } from '@playwright/test';

const apiRoot = '**/api/resource-allocation/v1';
const emptyPage = { nextCursor: null, limit: 50 };
const groupId = 'ac4a8e90-0f75-411e-a433-4aa05649fa50';
const profileId = '2ea514e7-ef80-47a3-a5bb-e8ac4dc36aa9';
const otherProfileId = '3fa514e7-ef80-47a3-a5bb-e8ac4dc36aa0';
const allocationId = 'f9c6026c-4143-4d78-b5ba-07308b18cff7';
const memberId = 'c0c77176-cc30-46a5-b634-b0218b67286c';

function person(role: string, localUserId: string, displayName: string) {
  return { id: `${localUserId}-id`.padEnd(36, '0').slice(0, 36), localUserId, displayName, role, groupId, coveredGroupIds: [] };
}
const moderator = person('ALLOCATION_MODERATOR', 'profile-moderator', 'Morgan Moderator');
const admin = person('ALLOCATION_ADMIN', 'profile-admin', 'Avery Admin');
const user = { ...person('ALLOCATION_USER', 'profile-member', 'Casey Member'), id: memberId };

function allocation(overrides: Record<string, unknown> = {}) {
  return {
    id: allocationId, requestId: null, source: 'SELF', category: 'TRAINING', classification: 'INTERNAL', comment: 'Cloud course',
    person: { personId: memberId, displayName: 'Casey Member' },
    group: { id: groupId, name: 'Platform Engineering' }, initiative: null,
    resourceProfile: { id: profileId, name: 'Cloud Engineering', active: true },
    startDate: '2099-01-04', endDate: '2099-01-15', approvedPeriod: { startDate: '2099-01-04', endDate: '2099-01-15' },
    weeklyHours: 8, state: 'NOT_STARTED', approvedAt: '2026-11-24T14:30:00.000Z', version: 3,
    availableActions: ['SUSPEND', 'RESERVE', 'CANCEL'], ...overrides,
  };
}

async function open(page: Page, actor: typeof moderator, current: () => Record<string, unknown>, onWrite: (request: Request) => { status: number; json: unknown }) {
  await page.route(`${apiRoot}/access`, (route) => route.fulfill({ json: { person: actor } }));
  for (const path of ['requests**', 'request-queues/**', 'submissions**', 'notifications**', 'initiatives**', 'capacit*']) {
    await page.route(`${apiRoot}/${path}`, (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  }
  await page.route(`${apiRoot}/allocation-load**`, (route) => route.fulfill({ json: { date: '2099-01-04', items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/allocation-groups**`, (route) => route.fulfill({ json: { items: [{ id: groupId, name: 'Platform Engineering' }], page: { nextCursor: null, limit: 100 } } }));
  await page.route(`${apiRoot}/people**`, (route) => route.fulfill({ json: { items: [{ id: memberId, displayName: 'Casey Member', groupId }, { id: 'd1d77176-cc30-46a5-b634-b0218b67286d', displayName: 'Drew Contractor', groupId }], page: emptyPage } }));
  await page.route(`${apiRoot}/resource-profiles**`, (route) => route.fulfill({ json: { items: [{ id: profileId, name: 'Cloud Engineering', groupId }, { id: otherProfileId, name: 'API Engineering', groupId }], page: emptyPage } }));
  await page.route(`${apiRoot}/allocations**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      const result = onWrite(request);
      return route.fulfill({ status: result.status, contentType: result.status >= 400 ? 'application/problem+json' : 'application/json', json: result.json, headers: { ETag: '"4"' } });
    }
    if (path.endsWith('/history')) {
      return route.fulfill({ json: { items: [{
        id: 'h1', action: 'ALLOCATION_UPDATED', reason: 'Rebalance', occurredAt: '2026-11-24T14:30:00.000Z', actor: { displayName: 'Morgan Moderator' },
        before: { person: { displayName: 'Casey Member' }, weeklyHours: 4, state: 'NOT_STARTED' },
        after: { person: { displayName: 'Casey Member' }, weeklyHours: 8, state: 'NOT_STARTED' },
      }], page: emptyPage } });
    }
    if (path.endsWith(`/allocations/${allocationId}`)) {
      const value = current();
      return route.fulfill({ json: value, headers: { ETag: `"${String(value.version)}"` } });
    }
    return route.fulfill({ json: { items: [current()], page: emptyPage } });
  });
  await page.addInitScript((value) => window.localStorage.setItem('pmo-hub.local-user-id', value), actor.localUserId);
  await page.goto(`/resource-allocation/?page=allocations&allocationId=${allocationId}`);
}

function maintenance(page: Page) {
  return page.getByRole('form', { name: /Change allocation|Reopen allocation/ });
}

test('lets a leader change profile, dates, and hours with a reason and shows the resulting state and history', async ({ page }) => {
  let body: Record<string, unknown> | null = null;
  let current = allocation();
  await open(page, moderator, () => current, (request) => {
    body = request.postDataJSON() as Record<string, unknown>;
    expect(request.headers()['if-match']).toBe('"3"');
    current = allocation({ resourceProfile: { id: otherProfileId, name: 'API Engineering', active: true }, weeklyHours: 12.3, version: 4 });
    return { status: 200, json: current };
  });
  await expect(page.locator('.allocation-history-changes')).toContainText('Hours: 4 h/week → 8 h/week');
  await page.getByRole('button', { name: 'Change allocation' }).click();
  await expect(page.getByRole('heading', { name: 'Change allocation' })).toBeFocused();
  await maintenance(page).getByLabel('Resource profile').selectOption(otherProfileId);
  await maintenance(page).getByLabel('Weekly hours').fill('12,25');
  await maintenance(page).getByLabel('End date (inclusive)').fill('2001-01-20');
  await maintenance(page).getByLabel('Start date').fill('2001-01-02');
  await expect(maintenance(page).getByRole('status')).toContainText('Resulting state: Done');
  await maintenance(page).getByLabel('Start date').fill('2099-01-05');
  await maintenance(page).getByLabel('End date (inclusive)').fill('2099-01-20');
  await expect(maintenance(page).getByRole('status')).toContainText('Resulting state: Not started');
  await page.getByRole('button', { name: 'Save change' }).click();
  await expect(maintenance(page).getByText('Enter a reason for this change.')).toBeVisible();
  await maintenance(page).getByLabel('Reason for this change').fill('Team rebalance');
  await page.getByRole('button', { name: 'Save change' }).click();
  await expect(page.getByText('The allocation was changed.')).toBeVisible();
  expect(body).toEqual({ reason: 'Team rebalance', resourceProfileId: otherProfileId, startDate: '2099-01-05', endDate: '2099-01-20', weeklyHours: 12.3 });
});

test('keeps entries when a newer version arrives, waits for an explicit review, and then saves against it', async ({ page }) => {
  const ifMatches: string[] = [];
  let version = 3;
  await open(page, moderator, () => allocation({ version, weeklyHours: version === 3 ? 8 : 9 }), (request) => {
    ifMatches.push(request.headers()['if-match']);
    if (ifMatches.length === 1) return { status: 412, json: { status: 412, code: 'PRECONDITION_FAILED', detail: 'The allocation changed.' } };
    return { status: 200, json: allocation({ version: 5, weeklyHours: 10 }) };
  });
  await page.getByRole('button', { name: 'Change allocation' }).click();
  await expect(maintenance(page).getByLabel('Resource profile')).toHaveValue(profileId);
  await expect(maintenance(page).getByLabel(/^Person/)).toHaveValue(memberId);
  await maintenance(page).getByLabel('Weekly hours').fill('10');
  await maintenance(page).getByLabel('Reason for this change').fill('More time');

  version = 4;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.getByRole('button', { name: 'Save change' }).click();
  await expect(maintenance(page).getByRole('alert')).toContainText('changed after you opened it');
  await expect(page.getByRole('button', { name: 'Save change' })).toBeDisabled();
  await expect(maintenance(page).getByLabel('Weekly hours')).toHaveValue('10');
  await expect(maintenance(page).getByLabel('Reason for this change')).toHaveValue('More time');

  await maintenance(page).getByRole('button', { name: 'Review latest version' }).click();
  await expect(page.getByRole('button', { name: 'Save change' })).toBeEnabled();
  await expect(maintenance(page).getByLabel('Weekly hours')).toHaveValue('10');
  await page.getByRole('button', { name: 'Save change' }).click();
  await expect(page.getByText('The allocation was changed.')).toBeVisible();
  expect(ifMatches.at(-1)).toBe('"4"');
  expect(ifMatches.every((value, index) => index === 0 ? value === '"3"' : true)).toBe(true);
});

test('asks to confirm the derived state when suspended work becomes Vacation', async ({ page }) => {
  let body: Record<string, unknown> | null = null;
  await open(page, moderator, () => allocation({ state: 'SUSPENDED', startDate: '2001-01-01', availableActions: ['RESUME', 'CANCEL'] }), (request) => {
    body = request.postDataJSON() as Record<string, unknown>;
    return { status: 200, json: allocation({ category: 'VACATION', weeklyHours: 40, resourceProfile: null, comment: null, state: 'IN_PROGRESS', version: 4 }) };
  });
  await page.getByRole('button', { name: 'Change allocation' }).click();
  await maintenance(page).getByLabel('Category').selectOption('VACATION');
  await expect(maintenance(page).getByLabel('Resource profile')).toHaveCount(0);
  await maintenance(page).getByLabel('Reason for this change').fill('Was vacation');
  await page.getByRole('button', { name: 'Save change' }).click();
  await expect(maintenance(page).getByText('Confirm the state derived from the dates.')).toBeVisible();
  await maintenance(page).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Save change' }).click();
  await expect(page.getByText('The allocation was changed.')).toBeVisible();
  expect(body).toEqual({ reason: 'Was vacation', category: 'VACATION', confirmDerivedState: true });
});

test('offers reopening only to Admin for closed allocations and no structural edit to a common user', async ({ page }) => {
  let body: Record<string, unknown> | null = null;
  await open(page, admin, () => allocation({ state: 'CANCELED', availableActions: [] }), (request) => {
    body = request.postDataJSON() as Record<string, unknown>;
    expect(new URL(request.url()).pathname).toMatch(/\/reopenings$/);
    return { status: 200, json: allocation({ version: 4 }) };
  });
  await expect(page.getByRole('button', { name: 'Change allocation' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reopen allocation' }).click();
  await maintenance(page).getByLabel('New start date').fill('2099-02-01');
  await maintenance(page).getByLabel('New end date (inclusive)').fill('2099-02-05');
  await maintenance(page).getByLabel('Reason for this change').fill('Rescheduled');
  await maintenance(page).getByRole('button', { name: 'Reopen allocation' }).click();
  await expect(page.getByText('The allocation was reopened.')).toBeVisible();
  expect(body).toEqual({ reason: 'Rescheduled', startDate: '2099-02-01', endDate: '2099-02-05' });
});

test('shows no maintenance actions to the allocated common user', async ({ page }) => {
  await open(page, user, () => allocation(), () => ({ status: 500, json: {} }));
  await expect(page.getByRole('region', { name: 'Allocation details' })).toContainText('Cloud course');
  await expect(page.getByRole('button', { name: 'Change allocation' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
});

test('guards unsaved changes and captures the form in both themes, narrow, and at 200% zoom', async ({ page }, testInfo) => {
  await open(page, moderator, () => allocation(), () => ({ status: 500, json: {} }));
  await page.getByRole('button', { name: 'Change allocation' }).click();
  await maintenance(page).getByLabel('Weekly hours').fill('11');
  const prompt = page.waitForEvent('dialog');
  const navigate = page.getByRole('link', { name: 'Requests', exact: true }).first().click();
  const dialog = await prompt;
  expect(dialog.message()).toMatch(/unsaved changes/i);
  await dialog.dismiss();
  await navigate;
  await expect(maintenance(page).getByLabel('Weekly hours')).toHaveValue('11');
  for (const theme of ['Light', 'Dark'] as const) {
    const themeToggle = page.getByRole('button', { name: 'Dark theme' });
    if ((await themeToggle.getAttribute('aria-pressed')) !== String(theme === 'Dark')) await themeToggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.toLowerCase());
    await page.setViewportSize({ width: 1280, height: 900 });
    await maintenance(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`maintenance-${theme.toLowerCase()}-desktop.png`), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`maintenance-${theme.toLowerCase()}-narrow.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { document.body.style.zoom = '200%'; });
  await page.getByRole('button', { name: 'Save change' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('maintenance-dark-zoom-200.png'), fullPage: true });
});
