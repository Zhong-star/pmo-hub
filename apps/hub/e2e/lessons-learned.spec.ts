import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const localProfilesFile = fileURLToPath(new URL('./fixtures/lessons-learned-local-users.json', import.meta.url));

test('direct Lessons Learned URL works before profile selection and can return to profile entry', async ({ page }) => {
  const response = await page.goto('/lessons-learned');

  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Access check' })).toBeVisible();
  await expect(page.getByText(/No local profile is selected/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Select a local profile' })).toHaveAttribute('href', '/');
  await expect(page.getByRole('link', { name: 'PMO Hub' })).toHaveAttribute('href', '/');

  const moduleResources = await page.evaluate(() => performance.getEntriesByType('resource').map(({ name }) => name));
  expect(moduleResources.some((resource) => resource.includes('/lessons-learned/src/main.tsx'))).toBe(true);
  expect(moduleResources.every((resource) => !resource.includes(':5174'))).toBe(true);

  await page.getByRole('link', { name: 'Select a local profile', exact: true }).click();
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
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.getByText('Welcome, Local Developer')).toBeVisible();
  await expect(page.getByText('Contributor', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');

  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome, Local Developer' })).toBeVisible();

  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to PMO Hub', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome, Local Developer' })).toBeVisible();

  await expect(page.getByRole('button', { name: 'Tech Resource Allocation: Coming soon' })).toBeDisabled();
});

test('catalog entry checks the Contributor identity before rendering Home', async ({ page }) => {
  let releaseCheck!: () => void;
  const accessCheck = new Promise<void>((resolve) => { releaseCheck = resolve; });
  await page.route('**/api/lessons-learned/v1/home', async (route) => {
    await accessCheck;
    await route.continue();
  });

  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-contributor');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();

  await expect(page.getByRole('status')).toContainText('local-contributor');
  await expect(page.getByRole('heading', { name: 'Home' })).not.toBeVisible();
  releaseCheck();

  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.getByText('Welcome, Local Contributor')).toBeVisible();
  await expect(page.getByText('Contributor', { selector: 'strong' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Lessons Learned navigation' })).toBeVisible();
});

test('direct URL checks the PMO identity before rendering its Home', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pmo-hub.local-user-id', 'local-pmo'));
  let releaseCheck!: () => void;
  const accessCheck = new Promise<void>((resolve) => { releaseCheck = resolve; });
  await page.route('**/api/lessons-learned/v1/home', async (route) => {
    await accessCheck;
    await route.continue();
  });

  await page.goto('/lessons-learned');

  await expect(page.getByRole('status')).toContainText('local-pmo');
  await expect(page.getByRole('heading', { name: 'Home' })).not.toBeVisible();
  releaseCheck();

  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.getByText('Welcome, Local PMO')).toBeVisible();
  await expect(page.getByText('PMO', { exact: true })).toBeVisible();
});

test('a profile without module access sees Access denied', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-no-access');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();

  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Contact the PMO');
  await expect(page.getByRole('navigation', { name: 'Lessons Learned' })).toHaveCount(0);
});

test('duplicate module profiles show a configuration error', async ({ page }) => {
  const originalConfig = readFileSync(localProfilesFile, 'utf8');
  const profiles = JSON.parse(originalConfig) as { id: string; displayName: string; role: string }[];

  try {
    writeFileSync(localProfilesFile, JSON.stringify([
      ...profiles,
      { id: 'local-pmo', displayName: 'Duplicate PMO', role: 'LESSONS_USER' },
    ]));

    await page.goto('/');
    await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-pmo');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('link', { name: 'Open Lessons Learned' }).click();

    await expect(page.getByRole('heading', { name: 'Access configuration error' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Contact the responsible team');
  } finally {
    writeFileSync(localProfilesFile, originalConfig, 'utf8');
  }
});

test('a temporary access check failure can be retried', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/lessons-learned/v1/home', async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Unavailable' }) });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-contributor');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();

  await expect(page.getByRole('heading', { name: 'Access check temporarily unavailable' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
});

test('revoking access blocks the next protected Home request after the tab regains focus', async ({ page }) => {
  const originalConfig = readFileSync(localProfilesFile, 'utf8');
  const profiles = JSON.parse(originalConfig) as { id: string; displayName: string; role: string }[];

  try {
    await page.goto('/');
    await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-contributor');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
    await expect(page.getByText('Welcome, Local Contributor')).toBeVisible();

    writeFileSync(localProfilesFile, JSON.stringify(profiles.filter(({ id }) => id !== 'local-contributor')));
    const revalidation = page.waitForResponse((response) =>
      response.url().includes('/api/lessons-learned/v1/home') && response.status() === 403,
    );
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await revalidation;

    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    await expect(page.getByText('Welcome, Local Contributor')).not.toBeVisible();
  } finally {
    writeFileSync(localProfilesFile, originalConfig, 'utf8');
  }
});

test('module screen stays open and offers return when its API is unavailable', async ({ page }) => {
  await page.goto('http://127.0.0.1:5182');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-developer');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();

  await expect(page.getByRole('heading', { name: 'Access check temporarily unavailable' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Retry');
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
