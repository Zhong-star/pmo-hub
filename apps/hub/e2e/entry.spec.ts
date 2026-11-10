import { expect, test } from '@playwright/test';

test('selecting a configured local profile opens the Hub welcome page', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('Hub available')).toBeVisible();
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-developer');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Welcome, Local Developer' })).toBeVisible();
  await expect(page.getByText('Hub available')).toBeVisible();
});


test('validation failure keeps the entry blocked and can be retried', async ({ page }) => {
  let validationAttempts = 0;
  await page.route('**/api/hub/v1/local-users/local-developer', async (route) => {
    validationAttempts += 1;
    if (validationAttempts === 1) {
      await route.fulfill({ status: 503, body: 'Unavailable' });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-developer');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('alert')).toContainText('The selected profile could not be validated.');
  await expect(page.getByRole('heading', { name: 'Welcome, Local Developer' })).not.toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();

  await expect(page.getByRole('heading', { name: 'Welcome, Local Developer' })).toBeVisible();
});

test('a profile-list timeout offers retry without a page reload', async ({ page }) => {
  let listAttempts = 0;
  await page.route('**/api/hub/v1/local-users', async (route) => {
    listAttempts += 1;
    if (listAttempts === 1) {
      await new Promise((resolve) => setTimeout(resolve, 5_500));
      try {
        await route.continue();
      } catch {
        // Axios has already timed out and aborted this request.
      }
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Local profiles could not be loaded.', { timeout: 8_000 });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('combobox', { name: 'Local profile' })).toBeVisible();
});

test('resumes a saved profile after reopening the browser page', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-developer');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, Local Developer' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome, Local Developer' })).toBeVisible();
});

test('switches profiles only after selecting and validating a different profile', async ({ page }) => {
  await page.route('**/api/hub/v1/local-users', async (route) => {
    const response = await route.fetch();
    const users = await response.json();
    await route.fulfill({ response, json: [...users, { id: 'local-reviewer', displayName: 'Local Reviewer' }] });
  });
  await page.route('**/api/hub/v1/local-users/local-reviewer', async (route) => {
    await route.fulfill({ json: { id: 'local-reviewer', displayName: 'Local Reviewer' } });
  });
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-developer');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Change profile' }).click();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-developer');
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-reviewer');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, Local Reviewer' })).toBeVisible();
  await expect(page.evaluate(() => localStorage.getItem('pmo-hub.local-user-id'))).resolves.toBe('local-reviewer');
});

test('a saved-profile validation failure can be retried without reloading', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pmo-hub.local-user-id', 'local-developer'));
  let attempts = 0;
  await page.route('**/api/hub/v1/local-users/local-developer', async (route) => {
    attempts += 1;
    if (attempts === 1) { await route.fulfill({ status: 503, body: 'Unavailable' }); return; }
    await route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('saved profile could not be validated');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, Local Developer' })).toBeVisible();
});

test('a removed saved profile is cleared and can be replaced', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pmo-hub.local-user-id', 'removed-user'));
  await page.route('**/api/hub/v1/local-users/removed-user', (route) => route.fulfill({ status: 404, body: 'Not found' }));
  await page.goto('/');
  await expect(page.getByText('The saved profile no longer exists.')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.evaluate(() => localStorage.getItem('pmo-hub.local-user-id'))).resolves.toBeNull();
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-developer');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, Local Developer' })).toBeVisible();
});
