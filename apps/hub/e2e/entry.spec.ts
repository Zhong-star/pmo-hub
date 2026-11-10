import { expect, test } from '@playwright/test';

function relativeLuminance(color: string): number {
  const channels = color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) throw new Error(`Unexpected computed color: ${color}`);
  const [red, green, blue] = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(firstColor: string, secondColor: string): number {
  const luminances = [relativeLuminance(firstColor), relativeLuminance(secondColor)].sort((a, b) => b - a);
  return (luminances[0] + 0.05) / (luminances[1] + 0.05);
}

test('selecting a configured local profile opens the module catalog', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('Hub available')).toBeVisible();
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-developer');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Welcome, Local Developer' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lessons Learned' })).toBeVisible();
  await expect(page.getByText('Capture, review, and reuse lessons from project experience.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lessons Learned: Coming soon' })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Tech Resource Allocation' })).toBeVisible();
  await expect(page.getByText('Request and coordinate technology resources across projects.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tech Resource Allocation: Coming soon' })).toBeDisabled();
  await expect(page.getByRole('link', { name: /Lessons Learned|Tech Resource Allocation/ })).toHaveCount(0);
  await expect(page.getByText('Hub available')).toBeVisible();

  await page.keyboard.press('Tab');
  const changeProfileButton = page.getByRole('button', { name: 'Change profile' });
  await expect(changeProfileButton).toBeFocused();
  await expect(changeProfileButton).toHaveCSS('outline-style', 'solid');
  const focusOutlineColor = await changeProfileButton.evaluate((button) => getComputedStyle(button).outlineColor);
  expect(focusOutlineColor).toBe('rgb(49, 92, 187)');
  expect(contrastRatio(focusOutlineColor, 'rgb(255, 255, 255)')).toBeGreaterThanOrEqual(3);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('combobox', { name: 'Local profile' })).toBeVisible();
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

test('keeps the module catalog hidden while a selected profile is being validated', async ({ page }) => {
  let finishValidation!: () => void;
  const validationGate = new Promise<void>((resolve) => { finishValidation = resolve; });
  await page.route('**/api/hub/v1/local-users/local-developer', async (route) => {
    await validationGate;
    await route.continue();
  });

  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-developer');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('button', { name: 'Validating profile…' })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).not.toBeVisible();
  finishValidation();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome, Local Developer' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lessons Learned' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lessons Learned: Coming soon' })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Tech Resource Allocation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tech Resource Allocation: Coming soon' })).toBeDisabled();
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
