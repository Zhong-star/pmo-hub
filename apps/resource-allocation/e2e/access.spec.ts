import { expect, test, type Page } from '@playwright/test';

const accessPath = '**/api/resource-allocation/v1/access';
const selectedProfileKey = 'pmo-hub.local-user-id';
const emptyPage = { nextCursor: null, limit: 100 };

const people = {
  'profile-user': {
    id: 'person-user',
    localUserId: 'profile-user',
    displayName: 'Taylor User',
    role: 'ALLOCATION_USER',
    coveredGroupIds: [],
  },
  'profile-leader': {
    id: 'person-leader',
    localUserId: 'profile-leader',
    displayName: 'Morgan Leader',
    role: 'ALLOCATION_SUPERVISOR',
    coveredGroupIds: [],
  },
};

async function openWithProfile(page: Page, profileId: string, url = '/resource-allocation/') {
  await page.route('**/api/resource-allocation/v1/initiatives**', async (route) => route.fulfill({
    json: { items: [], page: emptyPage },
  }));
  await page.route('**/api/resource-allocation/v1/groups**', async (route) => route.fulfill({
    json: { items: [], page: emptyPage },
  }));
  await page.route('**/api/resource-allocation/v1/resource-profiles**', async (route) => route.fulfill({
    json: { items: [], page: emptyPage },
  }));
  await page.route('**/api/resource-allocation/v1/submissions**', async (route) => route.fulfill({
    json: { items: [], page: { ...emptyPage, limit: 50 } },
  }));
  await page.route('**/api/resource-allocation/v1/requests**', async (route) => route.fulfill({
    json: { items: [], page: { ...emptyPage, limit: 50 } },
  }));
  await page.route('**/api/resource-allocation/v1/notifications**', async (route) => route.fulfill({
    json: { items: [], page: { ...emptyPage, limit: 50 } },
  }));
  await page.addInitScript(({ key, value }) => {
    if (!window.localStorage.getItem(key)) window.localStorage.setItem(key, value);
  }, {
    key: selectedProfileKey,
    value: profileId,
  });
  await page.goto(url);
}

async function measureInterfaceContrast(page: Page) {
  return page.evaluate(() => {
    const luminance = (color: string) => {
      const channels = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((value) => {
        const normalized = value / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const ratio = (foreground: string, background: string) => {
      const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    const body = getComputedStyle(document.body);
    const topbar = getComputedStyle(document.querySelector('.hub-header')!);
    const brand = getComputedStyle(document.querySelector('.hub-header__brand')!);
    const control = getComputedStyle(document.querySelector('#new-request-batch select')!);
    const focus = getComputedStyle(document.querySelector('.skip-link')!);
    return {
      body: ratio(body.color, body.backgroundColor),
      brand: ratio(brand.color, topbar.backgroundColor),
      control: ratio(control.color, control.backgroundColor),
      focus: ratio(focus.outlineColor, body.backgroundColor),
    };
  });
}

test('opens with the selected Hub profile and links back to the catalog', async ({ page }) => {
  let sentProfile: string | undefined;
  await page.route(accessPath, async (route) => {
    sentProfile = route.request().headers()['x-pmo-local-user-id'];
    await route.fulfill({ json: { person: people['profile-user'] } });
  });

  await openWithProfile(page, 'profile-user');

  await expect(page.getByRole('heading', { name: 'Tech Resource Allocation' })).toBeVisible();
  await expect(page.getByText('Taylor User')).toBeVisible();
  await expect(page.locator('.module-role')).toHaveText('User');
  await expect(page.getByRole('link', { name: 'PMO Hub' })).toHaveAttribute('href', '/');
  expect(sentProfile).toBe('profile-user');
});

test('asks for a Hub profile before contacting the access API', async ({ page }) => {
  let requestCount = 0;
  await page.route(accessPath, async (route) => {
    requestCount += 1;
    await route.fulfill({ status: 401, json: { status: 401, code: 'AUTHENTICATION_REQUIRED' } });
  });

  await page.goto('/resource-allocation/');

  await expect(page.getByRole('heading', { name: 'Select a local profile in PMO Hub' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'PMO Hub' })).toBeVisible();
  expect(requestCount).toBe(0);
});

test('shows active administrator contacts when the selected profile is denied', async ({ page }) => {
  await page.route(accessPath, async (route) => {
    await route.fulfill({
      status: 403,
      contentType: 'application/problem+json',
      json: {
        status: 403,
        code: 'ACCESS_DENIED',
        detail: 'You do not have active Tech Resource Allocation access. Contact an active Admin.',
        administrators: [
          { displayName: 'Morgan Admin', email: 'morgan.admin@example.test' },
          { displayName: 'Casey Admin', email: 'casey.admin@example.test' },
        ],
      },
    });
  });

  await openWithProfile(page, 'profile-without-access');

  await expect(page.getByRole('heading', { name: 'Access not available' })).toBeVisible();
  await expect(page.getByText('Morgan Admin')).toBeVisible();
  await expect(page.getByRole('link', { name: 'morgan.admin@example.test' }))
    .toHaveAttribute('href', 'mailto:morgan.admin@example.test');
  await expect(page.getByText('Casey Admin')).toBeVisible();
  await expect(page.getByRole('link', { name: 'casey.admin@example.test' }))
    .toHaveAttribute('href', 'mailto:casey.admin@example.test');
  await expect(page.getByText('Taylor User')).toHaveCount(0);
});

test('can retry after a network failure', async ({ page }) => {
  let requestCount = 0;
  await page.route(accessPath, async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({ json: { person: people['profile-user'] } });
  });

  await openWithProfile(page, 'profile-user', '/resource-allocation/?page=new-request');

  await expect(page.getByRole('heading', { name: 'Could not reach Tech Resource Allocation' })).toBeVisible();
  const attemptsBeforeRetry = requestCount;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Taylor User')).toBeVisible();
  expect(requestCount).toBeGreaterThan(attemptsBeforeRetry);
});

test('refreshes access for the new Hub profile without showing the previous profile', async ({ page }) => {
  const sentProfiles: string[] = [];
  await page.route(accessPath, async (route) => {
    const profileId = route.request().headers()['x-pmo-local-user-id'] ?? '';
    sentProfiles.push(profileId);
    const person = profileId === 'profile-leader' ? people['profile-leader'] : people['profile-user'];
    await route.fulfill({ json: { person } });
  });

  await openWithProfile(page, 'profile-user');
  await expect(page.getByText('Taylor User')).toBeVisible();

  await page.evaluate(({ key }) => window.localStorage.setItem(key, 'profile-leader'), {
    key: selectedProfileKey,
  });
  await page.reload();

  await expect(page.getByText('Morgan Leader')).toBeVisible();
  await expect(page.getByText('Taylor User')).toHaveCount(0);
  expect(sentProfiles[0]).toBe('profile-user');
  expect(sentProfiles.at(-1)).toBe('profile-leader');
});

test('uses the shared theme preference already saved in this tab', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('pmo-hub.theme')) sessionStorage.setItem('pmo-hub.theme', 'dark');
  });
  await page.route(accessPath, async (route) => {
    await route.fulfill({ json: { person: people['profile-user'] } });
  });

  await openWithProfile(page, 'profile-user', '/resource-allocation/?page=new-request');

  await expect(page.getByRole('heading', { name: 'Tech Resource Allocation' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(16, 18, 20)');
  await expect(page.getByLabel('Initiative', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Category', { exact: true })).toBeVisible();

  await page.keyboard.press('Tab');
  const contrast = await measureInterfaceContrast(page);
  expect(contrast.body).toBeGreaterThanOrEqual(4.5);
  expect(contrast.brand).toBeGreaterThanOrEqual(4.5);
  expect(contrast.control).toBeGreaterThanOrEqual(4.5);
  expect(contrast.focus).toBeGreaterThanOrEqual(3);

  await page.evaluate(() => sessionStorage.setItem('pmo-hub.theme', 'light'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.getByLabel('Initiative', { exact: true })).toBeVisible();
  await page.keyboard.press('Tab');
  const lightContrast = await measureInterfaceContrast(page);
  expect(lightContrast.body).toBeGreaterThanOrEqual(4.5);
  expect(lightContrast.brand).toBeGreaterThanOrEqual(4.5);
  expect(lightContrast.control).toBeGreaterThanOrEqual(4.5);
  expect(lightContrast.focus).toBeGreaterThanOrEqual(3);
});

test('skip link moves keyboard focus to the main content', async ({ page }) => {
  await page.route(accessPath, async (route) => {
    await route.fulfill({ json: { person: people['profile-user'] } });
  });
  await openWithProfile(page, 'profile-user', '/resource-allocation/?page=new-request');

  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skipLink).toBeAttached();
  await page.keyboard.press('Tab');
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeInViewport();
  await expect(skipLink).toHaveCSS('outline-style', 'solid');
  await expect(skipLink).toHaveCSS('outline-width', '3px');
  await page.keyboard.press('Enter');

  await expect(page.locator('#main-content')).toBeFocused();
});

test('keeps the page within desktop widths used at 200 percent zoom', async ({ page }) => {
  await page.route(accessPath, async (route) => {
    await route.fulfill({ json: { person: people['profile-user'] } });
  });
  await openWithProfile(page, 'profile-user');
  await expect(page.getByRole('heading', { name: 'Tech Resource Allocation' })).toBeVisible();

  for (const width of [640, 700]) {
    await page.setViewportSize({ width, height: 960 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow, `page should not overflow at ${width}px`).toBe(false);
  }
});
