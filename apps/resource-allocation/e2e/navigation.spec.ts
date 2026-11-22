import { expect, test, type Page } from '@playwright/test';

const apiRoot = '**/api/resource-allocation/v1';
const profileStorageKey = 'pmo-hub.local-user-id';
const emptyPage = { nextCursor: null, limit: 50 };

const user = {
  id: 'person-user',
  localUserId: 'profile-user',
  displayName: 'Taylor User',
  role: 'ALLOCATION_USER',
  coveredGroupIds: [],
};

const moderator = {
  id: 'person-moderator',
  localUserId: 'profile-moderator',
  displayName: 'Morgan Moderator',
  role: 'ALLOCATION_MODERATOR',
  groupId: 'group-a',
  coveredGroupIds: [],
};

const admin = {
  id: 'person-admin',
  localUserId: 'profile-admin',
  displayName: 'Casey Admin',
  role: 'ALLOCATION_ADMIN',
  groupId: 'group-a',
  coveredGroupIds: [],
};

async function openWithProfile(page: Page, person = user, url = '/resource-allocation/') {
  await page.route(`${apiRoot}/access`, async (route) => route.fulfill({ json: { person } }));
  await page.route(`${apiRoot}/groups**`, async (route) => route.fulfill({ json: { items: [], page: { ...emptyPage, limit: 100 } } }));
  await page.route(`${apiRoot}/resource-profiles**`, async (route) => route.fulfill({ json: { items: [], page: { ...emptyPage, limit: 100 } } }));
  await page.route(`${apiRoot}/initiatives**`, async (route) => route.fulfill({ json: { items: [], page: { ...emptyPage, limit: 100 } } }));
  await page.route(`${apiRoot}/submissions**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/requests**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/request-queues/**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/notifications**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.addInitScript(({ key, localUserId }) => window.localStorage.setItem(key, localUserId), {
    key: profileStorageKey,
    localUserId: person.localUserId,
  });
  await page.goto(url);
}

test('navigates between one area at a time and follows browser history', async ({ page }) => {
  await openWithProfile(page);

  await expect(page).toHaveURL(/\?page=requests$/);
  const navigation = page.getByRole('navigation', { name: 'Tech Resource Allocation' });
  await expect(navigation.getByRole('link', { name: 'Requests' })).toHaveAttribute('aria-current', 'page');
  await expect(navigation.getByRole('link', { name: 'New request' })).toHaveAttribute('href', '/resource-allocation/?page=new-request');
  await expect(navigation.getByRole('link', { name: 'Request queues' })).toHaveCount(0);
  await expect(navigation.getByRole('link', { name: 'Administration' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'My requests' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'New request batch' })).toHaveCount(0);

  await navigation.getByRole('link', { name: 'New request' }).click();
  await expect(page).toHaveURL(/\?page=new-request$/);
  await expect(page.getByRole('heading', { name: 'New request batch' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'My requests' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'New request batch' })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\?page=requests$/);
  await expect(page.getByRole('heading', { name: 'My requests' })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\?page=new-request$/);
  await expect(page.getByRole('heading', { name: 'New request batch' })).toBeVisible();
});

test('shows a queue deep link in Request queues with its requested tab selected', async ({ page }) => {
  await openWithProfile(page, moderator, '/resource-allocation/?queue=team-decision&requestId=request-a');

  await expect(page).toHaveURL(/page=request-queues/);
  await expect(page.getByRole('heading', { name: 'Request queues' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Group decision queue' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('navigation', { name: 'Tech Resource Allocation' }).getByRole('link', { name: 'Request queues' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'My requests' })).toHaveCount(0);
});

test('shows the Admin destinations and group queues allowed by the current profile', async ({ page }) => {
  await page.route(`${apiRoot}/admin/**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await openWithProfile(page, admin);

  const navigation = page.getByRole('navigation', { name: 'Tech Resource Allocation' });
  for (const label of ['Requests', 'New request', 'Request queues', 'Allocations and capacity', 'Notifications', 'Administration']) {
    await expect(navigation.getByRole('link', { name: label, exact: true })).toBeVisible();
  }

  await navigation.getByRole('link', { name: 'Request queues' }).click();
  await expect(page.getByRole('tab', { name: 'Presentation queue' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Group decision queue' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Admin exceptions' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Revalidation queue' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Requester response queue' })).toHaveCount(0);

  await navigation.getByRole('link', { name: 'Administration' }).click();
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();
});

test('omits Group decision from an ungrouped Admin queue', async ({ page }) => {
  const ungroupedAdmin = { ...admin, localUserId: 'profile-ungrouped-admin', groupId: undefined };
  await openWithProfile(page, ungroupedAdmin, '/resource-allocation/?page=request-queues');

  await expect(page.getByRole('tab', { name: 'Presentation queue' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Admin exceptions' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Revalidation queue' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Group decision queue' })).toHaveCount(0);
});

test('opens the Requests area for an unknown page and closes the responsive menu after selection', async ({ page }) => {
  await openWithProfile(page, user, '/resource-allocation/?page=unknown');
  await expect(page).toHaveURL(/\?page=requests$/);
  await expect(page.getByRole('heading', { name: 'My requests' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.getByRole('button', { name: 'Module menu' });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('navigation', { name: 'Tech Resource Allocation' }).getByRole('link', { name: 'New request' }).click();
  await expect(page).toHaveURL(/\?page=new-request$/);
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('heading', { name: 'New request batch' })).toBeVisible();
});

test('does not mount Administration for a user who opens its URL directly', async ({ page }) => {
  let administrationRequests = 0;
  await page.route(`${apiRoot}/admin/**`, async (route) => {
    administrationRequests += 1;
    await route.fulfill({ json: { items: [], page: emptyPage } });
  });
  await openWithProfile(page, user, '/resource-allocation/?page=administration');

  await expect(page.getByRole('alert')).toContainText('Administration is only available to Admins.');
  await expect(page.getByRole('link', { name: 'Requests', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Administration' })).toHaveCount(0);
  expect(administrationRequests).toBe(0);

  await page.getByRole('link', { name: 'Go to Requests' }).click();
  await expect(page).toHaveURL(/\?page=requests$/);
  await expect(page.getByRole('heading', { name: 'My requests' })).toBeVisible();
});
