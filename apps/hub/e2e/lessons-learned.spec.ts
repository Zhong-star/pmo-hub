import { expect, test } from '@playwright/test';

test('direct Lessons Learned URL works before profile selection and can return to profile entry', async ({ page }) => {
  const response = await page.goto('/lessons-learned');

  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Lessons Learned' })).toBeVisible();
  await expect(page.getByText('API available')).toBeVisible();
  await expect(page.getByRole('link', { name: 'PMO Hub' })).toHaveAttribute('href', '/');

  const moduleResources = await page.evaluate(() => performance.getEntriesByType('resource').map(({ name }) => name));
  expect(moduleResources.some((resource) => resource.includes('/lessons-learned/src/main.tsx'))).toBe(true);
  expect(moduleResources.every((resource) => !resource.includes(':5174'))).toBe(true);

  await page.getByRole('link', { name: 'PMO Hub' }).click();
  await expect(page.getByRole('combobox', { name: 'Local profile' })).toBeVisible();
});

test('catalog link opens in the same tab and reload, back, and module return preserve the profile', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-developer');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();

  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  expect(page.context().pages()).toHaveLength(1);
  await expect(page).toHaveURL(/\/lessons-learned\/?$/);
  await expect(page.getByRole('heading', { name: 'Lessons Learned' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Lessons Learned' })).toBeVisible();
  await expect(page.getByText('API available')).toBeVisible();

  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome, Local Developer' })).toBeVisible();

  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  await expect(page.getByRole('heading', { name: 'Lessons Learned' })).toBeVisible();
  await page.getByRole('link', { name: 'PMO Hub' }).click();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome, Local Developer' })).toBeVisible();

  await expect(page.getByRole('button', { name: 'Tech Resource Allocation: Coming soon' })).toBeDisabled();
});

test('module screen stays open and offers return when its API is unavailable', async ({ page }) => {
  await page.goto('http://127.0.0.1:5176');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-developer');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();

  await expect(page.getByRole('heading', { name: 'Lessons Learned' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('API unavailable');
  await page.getByRole('link', { name: 'PMO Hub' }).click();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
});

test('Hub proxy matches complete module prefixes only', async ({ page }) => {
  await page.goto('/lessons-learned-extra');
  await expect(page.getByRole('heading', { name: 'Welcome to PMO Hub' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lessons Learned' })).not.toBeVisible();

  const unrelatedApiStatus = await page.evaluate(async () => {
    const response = await fetch('/api/lessons-learned-extra/v1/health');
    return response.status;
  });
  expect(unrelatedApiStatus).toBe(404);
});
