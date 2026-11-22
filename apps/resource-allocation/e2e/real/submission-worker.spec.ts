import { expect, test } from '@playwright/test';

const profileStorageKey = 'pmo-hub.local-user-id';
const businessTimeZone = 'America/Sao_Paulo';

function dateAfterBusinessDays(days: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: businessTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  const year = Number(part('year'));
  const month = Number(part('month'));
  const day = Number(part('day'));
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return result.toISOString().slice(0, 10);
}

test('submits through the real API and shows the PostgreSQL worker result', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(({ key }) => window.localStorage.setItem(key, 'local-contributor'), {
    key: profileStorageKey,
  });
  await page.goto('/resource-allocation/?page=new-request');

  await expect(page.getByRole('heading', { name: 'New request batch' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Initiative', exact: true }).selectOption({
    label: 'ITDM-LOCAL-001 — Local Operational Baseline',
  });
  await page.getByLabel('Category').selectOption('EXECUTION_PROJECT');
  await page.getByLabel('Group for line 1').selectOption({ label: 'Platform Engineering' });
  await page.getByLabel('Resource profile for line 1').selectOption({ label: 'Software Engineer' });
  await page.getByLabel('Start date for line 1').fill(dateAfterBusinessDays(10));
  await page.getByLabel('End date for line 1').fill(dateAfterBusinessDays(20));
  await page.getByLabel('Weekly hours for line 1').fill('12');

  await page.getByRole('button', { name: 'Review submission' }).click();
  await expect(page.getByRole('heading', { name: 'Review your requests' })).toBeVisible();
  await expect(page.getByText(`${dateAfterBusinessDays(10)} to ${dateAfterBusinessDays(20)}`)).toBeVisible();
  await page.getByRole('button', { name: 'Send 1 request' }).click();

  await expect(page.getByRole('status').filter({ hasText: /Submission .* was received/ })).toBeVisible();
  await expect(page.getByText(/Request created:/)).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('Succeeded', { exact: true })).toBeVisible();
  await expect(page.getByText(/Current outcome:/)).toBeVisible();
});
