import { expect, test } from '@playwright/test';

test('selecting a configured local profile opens the Hub welcome page', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('Hub available')).toBeVisible();
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-developer');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Welcome, Local Developer' })).toBeVisible();
  await expect(page.getByText('Hub available')).toBeVisible();
});
