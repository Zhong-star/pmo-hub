import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

const localProfilesFile = process.env.LESSONS_LEARNED_E2E_LOCAL_USERS_FILE;
if (!localProfilesFile) throw new Error('The Lessons Learned E2E profile fixture was not initialized.');

async function getThemeContrastRatios(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    function luminance(color: string) {
      const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
      const linear = channels.map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return .2126 * linear[0]! + .7152 * linear[1]! + .0722 * linear[2]!;
    }

    function contrast(foreground: string, background: string) {
      const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (values[0]! + .05) / (values[1]! + .05);
    }

    const card = document.querySelector<HTMLElement>('.welcome-card:not(.catalog-page), .module-card')!;
    const themeMenu = document.querySelector<HTMLElement>('.hub-header__profile-menu')!;
    const activeTheme = document.querySelector<HTMLButtonElement>('.hub-header__profile-menu button[aria-pressed="true"]')!;
    const inactiveTheme = document.querySelector<HTMLButtonElement>('.hub-header__profile-menu button[aria-pressed="false"]')!;
    const primaryAction = document.querySelector<HTMLElement>('.primary-link, .module-action')!;
    const header = document.querySelector<HTMLElement>('.hub-header')!;
    const focusedThemeButton = document.querySelector<HTMLButtonElement>('.hub-header__profile-menu button:focus-visible');

    return {
      heading: contrast(getComputedStyle(document.querySelector('#page-title')!).color, getComputedStyle(card).backgroundColor),
      intro: contrast(getComputedStyle(document.querySelector('.intro')!).color, getComputedStyle(card).backgroundColor),
      primaryAction: contrast(getComputedStyle(primaryAction).color, getComputedStyle(primaryAction).backgroundColor),
      activeTheme: contrast(getComputedStyle(activeTheme).color, getComputedStyle(activeTheme).backgroundColor),
      inactiveTheme: contrast(getComputedStyle(inactiveTheme).color, getComputedStyle(themeMenu).backgroundColor),
      headerBrand: contrast(getComputedStyle(document.querySelector('.hub-header__brand')!).color, getComputedStyle(header).backgroundColor),
      focus: focusedThemeButton ? contrast(getComputedStyle(focusedThemeButton).outlineColor, getComputedStyle(themeMenu).backgroundColor) : null,
    };
  });
}

test('direct Lessons Learned URL works before profile selection and can return to profile entry', async ({ page }) => {
  const sharedHeaderResponses: { url: string; status: number }[] = [];
  page.on('response', (response) => {
    if (response.url().includes('HubHeader')) {
      sharedHeaderResponses.push({ url: response.url(), status: response.status() });
    }
  });
  const response = await page.goto('/lessons-learned');

  expect(response?.status()).toBe(200);
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('link', { name: 'PMO Hub' })).toHaveAttribute('href', '/');
  await expect(page.getByRole('heading', { name: 'Access check' })).toBeVisible();
  await expect(page.getByText(/No local profile is selected/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Select a local profile' })).toHaveAttribute('href', '/');
  await expect(page.getByRole('link', { name: 'PMO Hub' })).toHaveAttribute('href', '/');

  const moduleResources = await page.evaluate(() => performance.getEntriesByType('resource').map(({ name }) => name));
  expect(moduleResources.some((resource) => resource.includes('/lessons-learned/src/main.tsx'))).toBe(true);
  expect(moduleResources.every((resource) => !resource.includes(':5174'))).toBe(true);
  expect(sharedHeaderResponses.some(({ url, status }) => url.includes('HubHeader.tsx') && status === 200)).toBe(true);
  expect(sharedHeaderResponses.some(({ url, status }) => url.includes('HubHeader.css') && status === 200)).toBe(true);

  await page.getByRole('link', { name: 'Select a local profile', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Local profile' })).toBeVisible();
});

test('Contributor creates a title-only lesson and reopens the saved draft after reload', async ({ page }) => {
  expect(process.env.LESSONS_LEARNED_DATABASE_URL, 'Run through test:e2e:lessons-learned to start isolated PostgreSQL.').toBeTruthy();
  const title = `Issue 20 draft ${Date.now()}`;

  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-developer');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();

  await page.getByRole('link', { name: 'My Submissions' }).click();
  await expect(page.getByRole('heading', { name: 'My Submissions' })).toBeVisible();
  await page.getByRole('button', { name: 'Create lesson' }).click();
  await page.getByRole('textbox', { name: 'Title' }).fill(title);
  await page.getByRole('button', { name: 'Save Draft' }).click();
  await expect(page.getByRole('status')).toHaveText('Draft saved.');
  await expect(page.getByText(title, { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'My Submissions' })).toBeVisible();
  await page.getByRole('button', { name: `Reopen ${title}` }).click();
  await expect(page.getByRole('dialog', { name: 'Open draft' })).toContainText(title);
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

  await expect(page.getByText('Unavailable')).toBeVisible();
});

test('PMO can enter the module catalog and open Lessons Learned with the PMO role', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('banner')).toBeVisible();
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-pmo');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome, Local PMO' })).toBeVisible();

  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Local PMO' })).toBeVisible();
  await expect(page.getByText('Welcome, Local PMO')).toBeVisible();
  await expect(page.getByText('PMO', { exact: true })).toBeVisible();
});

test('change profile from Lessons Learned returns to selection and browser history never restores a stale profile', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-pmo');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  await expect(page.getByText('Welcome, Local PMO')).toBeVisible();

  await page.getByRole('button', { name: 'Local PMO' }).click();
  await page.getByRole('button', { name: 'Change profile' }).click();
  await expect(page.getByRole('combobox', { name: 'Local profile' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).not.toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('pmo-hub.local-user-id'))).toBeNull();

  await page.goBack();
  await expect(page).toHaveURL(/\/lessons-learned\/?$/);
  await expect(page.getByRole('heading', { name: 'Access check' })).toBeVisible();
  await expect(page.getByText('Welcome, Local PMO')).not.toBeVisible();
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByText(/No local profile is selected/)).toBeVisible();

  await page.goForward();
  await expect(page.getByRole('combobox', { name: 'Local profile' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-contributor');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, Local Contributor' })).toBeVisible();

  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  await expect(page.getByText('Welcome, Local Contributor')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Local Contributor' })).toBeVisible();
  await expect(page.getByText('Welcome, Local PMO')).not.toBeVisible();

  await page.getByRole('link', { name: 'PMO Hub', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await page.goBack();
  await expect(page.getByText('Welcome, Local Contributor')).toBeVisible();
  await expect(page.getByText('Welcome, Local PMO')).not.toBeVisible();
});

test('profile menu theme is keyboard operable, readable, and shared across both apps in the current tab', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pmo-hub.local-user-id', 'local-contributor'));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  const profileTrigger = page.getByRole('button', { name: 'Local Contributor' });
  const selectDarkWithKeyboard = async () => {
    const lightTheme = page.getByRole('button', { name: 'Light' });
    const darkTheme = page.getByRole('button', { name: 'Dark' });
    if (!(await darkTheme.isVisible())) {
      await profileTrigger.focus();
      await page.keyboard.press('Enter');
    }
    await profileTrigger.focus();
    await expect(lightTheme).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(lightTheme).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(darkTheme).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(darkTheme).toHaveAttribute('aria-pressed', 'true');
    await expect(lightTheme).toHaveAttribute('aria-pressed', 'false');
  };
  const assertReadableTheme = async () => {
    const ratios = await getThemeContrastRatios(page);
    const { focus, ...textAndControlRatios } = ratios;
    expect(Object.values(textAndControlRatios).every((ratio) => ratio >= 4.5)).toBe(true);
    if (focus !== null) expect(focus).toBeGreaterThanOrEqual(3);
  };
  const selectLightWithKeyboard = async () => {
    const lightTheme = page.getByRole('button', { name: 'Light' });
    const darkTheme = page.getByRole('button', { name: 'Dark' });
    await expect(darkTheme).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(lightTheme).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(lightTheme).toHaveAttribute('aria-pressed', 'true');
    await expect(darkTheme).toHaveAttribute('aria-pressed', 'false');
  };

  await profileTrigger.click();
  await expect(page.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'false');
  await assertReadableTheme();

  await selectDarkWithKeyboard();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.module-action')).toHaveCSS('background-color', 'rgb(24, 104, 219)');
  await assertReadableTheme();

  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Local Contributor' }).focus();
  await page.keyboard.press('Enter');
  const darkTheme = page.getByRole('button', { name: 'Dark' });
  await expect(darkTheme).toHaveAttribute('aria-pressed', 'true');
  await assertReadableTheme();
  await darkTheme.focus();
  await selectLightWithKeyboard();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.primary-link')).toHaveCSS('background-color', 'rgb(24, 104, 219)');
  await assertReadableTheme();

  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  if (!(await page.getByRole('button', { name: 'Light' }).isVisible())) {
    await page.getByRole('button', { name: 'Local Contributor' }).click();
  }
  await expect(page.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
  await selectDarkWithKeyboard();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.reload();
  await page.getByRole('button', { name: 'Local Contributor' }).click();
  await expect(page.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  const freshTab = await page.context().newPage();
  await freshTab.addInitScript(() => localStorage.setItem('pmo-hub.local-user-id', 'local-contributor'));
  await freshTab.goto('/');
  await expect(freshTab.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await freshTab.getByRole('button', { name: 'Local Contributor' }).click();
  await expect(freshTab.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
  await expect(freshTab.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'false');
});

test('migrates the existing Lessons Learned theme preference to the shared session preference', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pmo-hub.local-user-id', 'local-contributor');
    sessionStorage.setItem('pmo-hub.lessons-learned.theme', 'dark');
  });
  await page.goto('/lessons-learned');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Local Contributor' }).click();
  await expect(page.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => sessionStorage.getItem('pmo-hub.theme'))).toBe('dark');
  expect(await page.evaluate(() => sessionStorage.getItem('pmo-hub.lessons-learned.theme'))).toBeNull();
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
  await expect(page.getByText('Contributor', { exact: true })).toBeVisible();
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

test('a direct module URL denies a saved Hub profile without module access', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pmo-hub.local-user-id', 'local-no-access'));
  await page.goto('/lessons-learned');

  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('button', { name: 'local-no-access' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Contact the PMO');
  await expect(page.getByRole('navigation', { name: 'Lessons Learned' })).toHaveCount(0);
  await expect(page.getByText(/No local profile is selected/)).toHaveCount(0);
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
