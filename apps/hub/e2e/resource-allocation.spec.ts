import { expect, test } from '@playwright/test';

const accessPath = '**/api/resource-allocation/v1/access';

test('opens Resource Allocation from the Hub, survives refresh, returns, and follows a profile change', async ({ page }) => {
  const selectedProfiles: string[] = [];
  await page.route(accessPath, async (route) => {
    const localUserId = route.request().headers()['x-pmo-local-user-id'] ?? '';
    selectedProfiles.push(localUserId);
    const isContributor = localUserId === 'local-contributor';
    await route.fulfill({
      json: {
        person: {
          id: isContributor ? 'person-contributor' : 'person-developer',
          localUserId,
          displayName: isContributor ? 'Local Contributor' : 'Local Developer',
          role: isContributor ? 'ALLOCATION_MODERATOR' : 'ALLOCATION_USER',
          coveredGroupIds: [],
        },
      },
    });
  });

  await page.goto('/');
  await expect(page.getByText('Hub available')).toBeVisible();
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-developer');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  const resourceAllocationLink = page.getByRole('link', { name: 'Open Tech Resource Allocation' });
  await expect(resourceAllocationLink).toHaveAttribute('href', '/resource-allocation');
  await resourceAllocationLink.click();

  await expect(page).toHaveURL(/\/resource-allocation\/?\?page=requests$/);
  await expect(page.getByRole('heading', { name: 'Tech Resource Allocation' })).toBeVisible();
  await expect(page.getByText('Local Developer')).toBeVisible();
  await expect(page.getByText('ALLOCATION_USER')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Local Developer')).toBeVisible();

  await page.getByRole('link', { name: 'PMO Hub' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();

  await page.getByRole('link', { name: 'Open Tech Resource Allocation' }).click();
  await expect(page).toHaveURL(/\/resource-allocation\/?\?page=requests$/);
  await page.getByRole('button', { name: 'Local Developer' }).click();
  await page.getByRole('button', { name: 'Change profile' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('combobox', { name: 'Local profile' })).toHaveValue('');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-contributor');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, Local Contributor' })).toBeVisible();
  await page.getByRole('link', { name: 'Open Tech Resource Allocation' }).click();

  await expect(page.getByRole('heading', { name: 'Tech Resource Allocation' })).toBeVisible();
  await expect(page.getByText('Local Contributor')).toBeVisible();
  await expect(page.getByText('ALLOCATION_MODERATOR')).toBeVisible();
  await expect(page.getByText('Local Developer')).toHaveCount(0);
  expect(selectedProfiles.slice(0, 2)).toContain('local-developer');
  expect(selectedProfiles.at(-1)).toBe('local-contributor');
});

test('direct access without a selected profile returns users to the Hub', async ({ page }) => {
  let accessRequests = 0;
  await page.route(accessPath, async (route) => {
    accessRequests += 1;
    await route.fulfill({ status: 401, json: { status: 401, code: 'AUTHENTICATION_REQUIRED' } });
  });

  await page.goto('/resource-allocation/');
  await expect(page.getByRole('heading', { name: 'Select a local profile in PMO Hub' })).toBeVisible();
  expect(accessRequests).toBe(0);
  await page.getByRole('link', { name: 'PMO Hub' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('combobox', { name: 'Local profile' })).toBeVisible();
});
