import { expect, test, type Page } from '@playwright/test';

const apiRoot = '**/api/resource-allocation/v1';
const emptyPage = { nextCursor: null, limit: 50 };
const groupId = '0e38ea81-5c51-4a48-a9ec-8a9c90fb8464';
const manager = {
  id: '71847999-3f3c-41df-b026-20ac20e31c91',
  localUserId: 'profile-capacity-manager',
  displayName: 'Jordan Manager',
  role: 'ALLOCATION_MANAGER',
  groupId: null,
  coveredGroupIds: [groupId],
};

function figures(plannedHours: number, capacityHours: number | null, complete: boolean, utilizationPercent: number | null, suspendedHours = 0) {
  return { plannedHours, suspendedHours, capacityHours, capacityFte: capacityHours === null ? null : capacityHours / 40, complete, utilizationPercent };
}

function week(weekStart: string, weekEnd: string) {
  return {
    weekStart,
    weekEnd,
    total: figures(64, 52, false, null, 10),
    groups: [{
      group: { id: groupId, name: 'Platform Engineering' },
      unclassifiedHours: 4,
      vacationHours: 16,
      total: figures(64, 52, false, null, 10),
      profiles: [{
        resourceProfile: { id: 'p1', name: 'Cloud Engineering', active: false },
        total: figures(64, 52, false, null, 10),
        classifications: [
          { classification: 'INTERNAL', ...figures(60, 40, true, 150, 10) },
          { classification: 'THIRD_PARTY', ...figures(0, 12, false, null) },
          { classification: null, ...figures(4, null, false, null) },
        ],
      }],
    }],
  };
}

async function open(page: Page, onComparison: (url: URL) => object | 'error') {
  await page.route(`${apiRoot}/access`, (route) => route.fulfill({ json: { person: manager } }));
  for (const path of ['request-queues/**', 'requests**', 'submissions**', 'notifications**', 'groups**', 'resource-profiles**', 'initiatives**', 'capacities**']) {
    await page.route(`${apiRoot}/${path}`, (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  }
  await page.route(`${apiRoot}/capacity-options`, (route) => route.fulfill({ json: { groups: [{ id: groupId, name: 'Platform Engineering', resourceProfiles: [] }] } }));
  await page.route(`${apiRoot}/capacity-comparison**`, (route) => {
    const result = onComparison(new URL(route.request().url()));
    return result === 'error'
      ? route.fulfill({ status: 503, contentType: 'application/problem+json', json: { status: 503, code: 'DEPENDENCY_UNAVAILABLE', detail: 'The database is unavailable.' } })
      : route.fulfill({ json: result });
  });
  await page.addInitScript((value) => window.localStorage.setItem('pmo-hub.local-user-id', value), manager.localUserId);
  await page.goto('/resource-allocation/?page=capacity');
}

test('shows the current week with incomplete, unclassified, inactive, vacation, and over-100% states as text', async ({ page }) => {
  const queries: URL[] = [];
  await open(page, (url) => {
    queries.push(url);
    return { businessDate: '2026-11-25', vacationIncluded: true, weeks: [week(url.searchParams.get('weekStart')!, '2026-11-29')] };
  });
  const table = page.getByRole('table');
  await expect(table).toBeVisible();
  expect(queries[0].searchParams.get('weekStart')).toBe(queries[0].searchParams.get('weekEnd'));
  expect(new Date(`${queries[0].searchParams.get('weekStart')}T00:00:00Z`).getUTCDay()).toBe(1);
  await expect(table.getByRole('row', { name: /Cloud Engineering \(inactive profile\) · Internal/ })).toContainText('150.0%');
  await expect(table.getByRole('row', { name: /Third-party/ })).toContainText('12.0 h · 0.3 FTE known');
  await expect(table.getByRole('row', { name: /Third-party/ })).toContainText('Incomplete');
  await expect(table.getByRole('row', { name: /Unclassified/ })).toContainText('Capacity not configured');
  await expect(table.getByRole('row', { name: /Vacation · Platform Engineering/ })).toContainText('16.0 h (not deducted from capacity)');
  await expect(table.getByRole('row', { name: /All groups shown/ })).toContainText('Incomplete');
});

test('moves between weeks, requests a range, applies filters, and retries after an error', async ({ page }) => {
  let fail = false;
  const queries: URL[] = [];
  await open(page, (url) => {
    queries.push(url);
    if (fail) return 'error';
    const start = url.searchParams.get('weekStart')!;
    return { businessDate: '2026-11-25', vacationIncluded: !url.searchParams.get('classification'), weeks: [week(start, start)] };
  });
  await expect(page.getByRole('table')).toBeVisible();
  const first = queries.at(-1)!.searchParams.get('weekStart')!;
  await page.getByRole('button', { name: 'Next week' }).click();
  await expect.poll(() => queries.at(-1)!.searchParams.get('weekStart')).not.toBe(first);
  await page.getByRole('button', { name: 'Current week' }).click();
  await page.getByLabel('Weeks').selectOption('4');
  await expect.poll(() => queries.at(-1)!.searchParams.get('weekEnd')).not.toBe(first);
  await page.getByLabel('Classification').first().selectOption('INTERNAL');
  await expect.poll(() => queries.at(-1)!.searchParams.get('classification')).toBe('INTERNAL');
  await expect(page.getByRole('row', { name: /Vacation · Platform Engineering/ })).toContainText('Not shown with a profile or classification filter');

  fail = true;
  await page.getByLabel('Weeks').selectOption('2');
  await expect(page.getByRole('alert')).toContainText('The database is unavailable.');
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('table').first()).toBeVisible();
});

test('captures the weekly comparison in both themes, desktop and narrow, and at 200% zoom', async ({ page }, testInfo) => {
  await open(page, (url) => ({ businessDate: '2026-11-25', vacationIncluded: true, weeks: [week(url.searchParams.get('weekStart')!, '2026-11-29')] }));
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: 'Previous week' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Current week' })).toBeFocused({ timeout: 1000 }).catch(async () => {
    await expect(page.getByRole('button', { name: 'Next week' })).toBeFocused();
  });
  for (const theme of ['Light', 'Dark'] as const) {
    await page.getByRole('button', { name: manager.displayName }).click();
    await page.getByRole('button', { name: theme }).click();
    await page.getByRole('button', { name: manager.displayName }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('heading', { name: 'Weekly comparison' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`comparison-${theme.toLowerCase()}-desktop.png`), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`comparison-${theme.toLowerCase()}-narrow.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { document.body.style.zoom = '200%'; });
  await page.screenshot({ path: testInfo.outputPath('comparison-dark-zoom-200.png'), fullPage: true });
});
