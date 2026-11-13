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

  await menuButton.click();
  await expect(navigation).toBeVisible();
  await expect(homeLink).toHaveAttribute('href', '/lessons-learned/');
  await homeLink.click();

  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await expect(navigation).toBeHidden();
});

test('Lessons Learned navigation stays beside Home on wide screens', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem('pmo-hub.local-user-id', 'local-contributor'));
  await page.goto('/lessons-learned/');

  const sidebar = page.getByRole('complementary', { name: 'Lessons Learned navigation' });
  const navigation = page.getByRole('navigation', { name: 'Lessons Learned' });
  const menuButton = page.getByRole('button', { name: 'Module menu' });
  const homeContent = page.getByRole('heading', { name: 'Home' });

  await expect(navigation).toBeVisible();
  await expect(menuButton).toBeHidden();
  await expect(navigation.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');

  const [sidebarBounds, contentBounds] = await Promise.all([
    sidebar.boundingBox(),
    homeContent.boundingBox(),
  ]);
  expect(sidebarBounds).not.toBeNull();
  expect(contentBounds).not.toBeNull();
  expect(sidebarBounds!.x + sidebarBounds!.width).toBeLessThan(contentBounds!.x);
});
