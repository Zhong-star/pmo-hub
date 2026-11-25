import { expect, test, type Page } from '@playwright/test';

const selectedProfileKey = 'pmo-hub.local-user-id';
const apiRoot = '/api/resource-allocation/v1';
const emptyPage = { nextCursor: null, limit: 50 };

async function openAdmin(page: Page) {
  let person: Record<string, unknown> = {
    id: 'person-legacy',
    localUserId: 'legacy-profile',
    displayName: 'Legacy Person',
    email: 'legacy@example.test',
    active: true,
    role: 'ALLOCATION_USER',
    classification: null,
    groupId: null,
    coveredGroupIds: [],
    version: 1,
  };

  await page.route('**/api/resource-allocation/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === `${apiRoot}/access`) {
      await route.fulfill({ json: { person: { ...person, id: 'person-admin', localUserId: 'profile-admin', displayName: 'Morgan Admin', role: 'ALLOCATION_ADMIN', coveredGroupIds: [] } } });
      return;
    }
    if (path === `${apiRoot}/admin/people`) {
      await route.fulfill({ json: { items: [person], page: emptyPage } });
      return;
    }
    if (path === `${apiRoot}/admin/people/${person.id}` && request.method() === 'GET') {
      await route.fulfill({ headers: { etag: `"${person.version}"` }, json: person });
      return;
    }
    if (path === `${apiRoot}/admin/people/${person.id}` && request.method() === 'PATCH') {
      person = { ...person, ...(request.postDataJSON() as Record<string, unknown>), version: 2 };
      await route.fulfill({ headers: { etag: '"2"' }, json: person });
      return;
    }
    if (path.startsWith(`${apiRoot}/admin/`)) {
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    if (path === `${apiRoot}/groups` || path === `${apiRoot}/resource-profiles` || path === `${apiRoot}/initiatives`) {
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    if (path === `${apiRoot}/submissions` || path === `${apiRoot}/requests` || path === `${apiRoot}/notifications`) {
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
    key: selectedProfileKey,
    value: 'profile-admin',
  });
  await page.goto('/resource-allocation/?page=administration');
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();
}

test('Admin can classify a legacy person and sees non-retroactive and access guidance', async ({ page }) => {
  await openAdmin(page);

  const row = page.getByRole('row', { name: /Legacy Person.*User.*Unclassified/ });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Edit person Legacy Person' }).click();
  await expect(page.getByLabel('Classification')).toHaveValue('');
  await expect(page.getByText('Classification is informational. It does not change access or roles, and it does not reclassify existing allocations.')).toBeVisible();

  await page.getByLabel('Classification').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/person-classification-light-desktop.png' });
  await page.setViewportSize({ width: 640, height: 900 });
  await page.getByLabel('Classification').scrollIntoViewIfNeeded();
  const reflowDimensions = await page.evaluate(() => ({
    bodyWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(reflowDimensions.bodyWidth).toBeLessThanOrEqual(reflowDimensions.viewportWidth);
  await page.screenshot({ path: 'test-results/person-classification-light-640-reflow.png' });

  await page.getByLabel('Role').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Classification')).toBeFocused();
  await page.getByLabel('Classification').selectOption('THIRD_PARTY');
  await page.getByRole('button', { name: 'Save person' }).click();

  await expect(page.getByRole('row', { name: /Legacy Person.*User.*Third party/ })).toBeVisible();

  await page.getByRole('button', { name: 'Morgan Admin' }).click();
  await page.getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Edit person Legacy Person' }).click();
  await expect(page.getByLabel('Classification')).toHaveValue('THIRD_PARTY');

  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.getByRole('heading', { name: 'Administration' }).scrollIntoViewIfNeeded();
  await expect(page.getByLabel('Classification')).toBeVisible();
  await page.screenshot({ path: 'test-results/person-classification-dark-desktop.png' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Classification').scrollIntoViewIfNeeded();
  await expect(page.getByLabel('Classification')).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    bodyWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  await page.screenshot({ path: 'test-results/person-classification-dark-narrow.png' });
});
