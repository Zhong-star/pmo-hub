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
