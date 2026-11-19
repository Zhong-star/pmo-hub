import { expect, test } from '@playwright/test';

test('Module menu works by pointer and keyboard on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('pmo-hub.local-user-id', 'local-contributor'));
  await page.goto('/lessons-learned/');

  const menuButton = page.getByRole('button', { name: 'Module menu' });
  const navigation = page.getByRole('navigation', { name: 'Lessons Learned' });
  const homeLink = page.getByRole('link', { name: 'Home' });

  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await expect(navigation).toBeHidden();

  await menuButton.focus();
  await page.keyboard.press('Enter');
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
  await expect(navigation).toBeVisible();

  await page.keyboard.press('Enter');
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await expect(navigation).toBeHidden();

  const panel = page.getByRole('main');
  const closedTop = (await panel.boundingBox())!.y;
  await menuButton.click();
  await expect(navigation).toBeVisible();
  expect((await panel.boundingBox())!.y).toBeGreaterThan(closedTop);
  await expect(homeLink).toHaveAttribute('href', '/lessons-learned/');
  await homeLink.focus();
  await page.keyboard.press('Escape');
  await expect(menuButton).toBeFocused();
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await menuButton.click();
  await homeLink.click();

  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await expect(navigation).toBeHidden();
});

test('Lessons Learned navigation stays beside Home at 1280 × 720 and after desktop resize', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(() => localStorage.setItem('pmo-hub.local-user-id', 'local-contributor'));
  await page.goto('/lessons-learned/');

  const sidebar = page.getByRole('complementary', { name: 'Lessons Learned navigation' });
  const navigation = page.getByRole('navigation', { name: 'Lessons Learned' });
  const menuButton = page.getByRole('button', { name: 'Module menu' });
  const homeContent = page.getByRole('heading', { name: 'Home' });

  await expect(navigation).toBeVisible();
  await expect(menuButton).toBeHidden();
  await expect(navigation.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');

  const panel = page.getByRole('main');
  const header = page.getByRole('banner');
  const [sidebarBounds, contentBounds, panelBounds, headerBounds] = await Promise.all([
    sidebar.boundingBox(),
    homeContent.boundingBox(),
    panel.boundingBox(),
    header.boundingBox(),
  ]);
  expect(sidebarBounds).not.toBeNull();
  expect(contentBounds).not.toBeNull();
  expect(sidebarBounds!.x + sidebarBounds!.width).toBeLessThan(contentBounds!.x);
  expect(sidebarBounds!.x).toBe(0);
  expect(sidebarBounds!.y).toBe(headerBounds!.height);
  expect(sidebarBounds!.y + sidebarBounds!.height).toBe(720);
  expect(panelBounds!.x + panelBounds!.width).toBe(1280);
  expect(panelBounds!.y + panelBounds!.height).toBe(720);
  const primary = page.getByRole('region', { name: 'Recommended next action' }).getByRole('button');
  expect((await primary.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(navigation).toBeVisible();
  expect((await panel.boundingBox())!.x + (await panel.boundingBox())!.width).toBe(1600);
  await page.setViewportSize({ width: 720, height: 600 });
  await expect(menuButton).toBeVisible();
  await expect(navigation).toBeHidden();
});

test('My Submissions scrolls inside the desktop panel and opens the draft editor', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.addInitScript(() => localStorage.setItem('pmo-hub.local-user-id', 'local-contributor'));
  await page.route('**/api/lessons-learned/v1/lessons/mine', (route) => route.fulfill({
    json: Array.from({ length: 30 }, (_, index) => ({
      id: index + 1,
      title: `Layout test lesson ${index + 1}`,
      status: 'Open',
    })),
  }));
  await page.goto('/lessons-learned/?page=my-submissions');

  const panel = page.getByRole('main');
  const sidebar = page.getByRole('complementary', { name: 'Lessons Learned navigation' });
  const header = page.getByRole('banner');
  await expect(page.getByText('Layout test lesson 30', { exact: true })).toBeAttached();
  await expect(sidebar.getByRole('link', { name: 'My Submissions' })).toHaveAttribute('aria-current', 'page');

  const headerBefore = await header.boundingBox();
  const sidebarBefore = await sidebar.boundingBox();
  await panel.hover();
  await page.mouse.wheel(0, 800);
  await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await header.boundingBox()).toEqual(headerBefore);
  expect(await sidebar.boundingBox()).toEqual(sidebarBefore);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await page.getByRole('button', { name: 'Create lesson' }).click();
  await expect(page.getByRole('dialog', { name: 'Create lesson' })).toBeVisible();
});
