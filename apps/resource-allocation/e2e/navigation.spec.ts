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

  await expect(page.getByRole('alert')).toContainText('Resource profile administration is only available to Admins and in-scope resource leaders.');
  await expect(page.getByRole('link', { name: 'Requests', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Administration' })).toHaveCount(0);
  expect(administrationRequests).toBe(0);

  await page.getByRole('link', { name: 'Go to Requests' }).click();
  await expect(page).toHaveURL(/\?page=requests$/);
  await expect(page.getByRole('heading', { name: 'My requests' })).toBeVisible();
});

test('keeps a dirty request form when area navigation is canceled', async ({ page }) => {
  await openWithProfile(page, user, '/resource-allocation/?page=new-request');

  const weeklyHours = page.getByLabel('Weekly hours for line 1');
  await weeklyHours.fill('4.5');

  let confirmationMessage = '';
  page.once('dialog', async (dialog) => {
    confirmationMessage = dialog.message();
    await dialog.dismiss();
  });
  await page.getByRole('navigation', { name: 'Tech Resource Allocation' }).getByRole('link', { name: 'Requests' }).click();

  await expect(page).toHaveURL(/\?page=new-request$/);
  await expect(weeklyHours).toHaveValue('4.5');
  expect(confirmationMessage).toMatch(/unsaved changes/i);

  await weeklyHours.focus();
  await expect(weeklyHours).toBeFocused();
});

test('restores the current area and draft when browser back is canceled', async ({ page }) => {
  await openWithProfile(page);
  await page.getByRole('navigation', { name: 'Tech Resource Allocation' }).getByRole('link', { name: 'New request' }).click();
  const weeklyHours = page.getByLabel('Weekly hours for line 1');
  await weeklyHours.fill('6.5');

  const canceledPrompt = page.waitForEvent('dialog');
  await page.evaluate(() => window.history.back());
  const canceledDialog = await canceledPrompt;
  expect(canceledDialog.message()).toMatch(/unsaved changes/i);
  await canceledDialog.dismiss();

  await expect(page).toHaveURL(/\?page=new-request$/);
  await expect(weeklyHours).toHaveValue('6.5');

  const confirmedPrompt = page.waitForEvent('dialog');
  await page.evaluate(() => window.history.back());
  const confirmedDialog = await confirmedPrompt;
  await confirmedDialog.accept();
  await expect(page).toHaveURL(/\?page=requests$/);
  await expect(page.getByRole('heading', { name: 'My requests' })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\?page=new-request$/);
  await expect(page.getByRole('heading', { name: 'New request batch' })).toBeVisible();
});

test('keeps profile and form focus when profile change is canceled', async ({ page }) => {
  await openWithProfile(page, user, '/resource-allocation/?page=new-request');
  const weeklyHours = page.getByLabel('Weekly hours for line 1');
  await weeklyHours.fill('3.5');
  await page.getByRole('button', { name: 'Taylor User' }).click();
  const changeProfile = page.getByRole('button', { name: 'Change profile' });

  const prompt = page.waitForEvent('dialog');
  const click = changeProfile.click();
  const dialog = await prompt;
  expect(dialog.message()).toMatch(/unsaved changes/i);
  await dialog.dismiss();
  await click;

  await expect(page).toHaveURL(/\?page=new-request$/);
  await expect(weeklyHours).toHaveValue('3.5');
  await expect(changeProfile).toBeVisible();
  await expect(changeProfile).toBeFocused();
  expect(await page.evaluate((key) => window.localStorage.getItem(key), profileStorageKey)).toBe(user.localUserId);
});

for (const queue of ['Admin exceptions', 'Revalidation queue']) {
  test(`preserves a draft when forward to filtered ${queue} is canceled`, async ({ page }) => {
    await openWithProfile(page, admin, '/resource-allocation/?page=new-request');
    await page.route(`${apiRoot}/groups**`, (route) => route.fulfill({
      json: { items: [{ id: 'group-a', name: 'Platform Engineering' }], page: emptyPage },
    }));
    const navigation = page.getByRole('navigation', { name: 'Tech Resource Allocation' });
    await navigation.getByRole('link', { name: 'Request queues', exact: true }).click();
    await page.getByRole('tab', { name: queue, exact: true }).click();
    if (queue === 'Admin exceptions') {
      await page.getByRole('tab', { name: 'Pre N3', exact: true }).click();
    } else {
      await page.getByRole('group', { name: 'Filter revalidation requests' }).getByRole('combobox', { name: 'Group', exact: true }).selectOption({ label: 'Platform Engineering' });
    }
    const queueUrl = page.url();
    await navigation.getByRole('link', { name: 'Notifications', exact: true }).click();
    await page.goBack();
    await page.goBack();
    await expect(page).toHaveURL(/\?page=new-request$/);
    const hours = page.getByLabel('Weekly hours for line 1');
    await hours.fill('6.5');

    const canceledPrompt = page.waitForEvent('dialog');
    await page.evaluate(() => window.history.forward());
    await (await canceledPrompt).dismiss();
    await expect(page).toHaveURL(/\?page=new-request$/);
    await expect(hours).toHaveValue('6.5');
    await hours.focus();
    await expect(hours).toBeFocused();

    const confirmedPrompt = page.waitForEvent('dialog');
    await page.evaluate(() => window.history.forward());
    await (await confirmedPrompt).accept();
    await expect(page).toHaveURL(queueUrl);
    await expect(page.getByRole('tab', { name: queue, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(hours).toHaveCount(0);
    await page.goForward();
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
  });
}

test('protects the PMO Hub brand link and native reload with the current draft', async ({ page }) => {
  await openWithProfile(page, user, '/resource-allocation/?page=new-request');
  const weeklyHours = page.getByLabel('Weekly hours for line 1');
  await weeklyHours.fill('2.5');

  const brandPrompt = page.waitForEvent('dialog');
  const brandClick = page.getByRole('link', { name: 'PMO Hub' }).click();
  const brandDialog = await brandPrompt;
  await brandDialog.dismiss();
  await brandClick;
  await expect(page).toHaveURL(/\?page=new-request$/);
  await expect(weeklyHours).toHaveValue('2.5');

  let unloadDialogType = '';
  page.on('dialog', async (dialog) => {
    unloadDialogType = dialog.type();
    await dialog.dismiss();
  });
  await page.reload({ timeout: 2500 }).catch(() => null);
  expect(unloadDialogType).toBe('beforeunload');
  await expect(weeklyHours).toHaveValue('2.5');
});

test('clears a dirty form immediately when another tab changes the selected profile', async ({ page }) => {
  await openWithProfile(page, user, '/resource-allocation/?page=new-request');
  const weeklyHours = page.getByLabel('Weekly hours for line 1');
  await weeklyHours.fill('8');

  let confirmationCount = 0;
  page.on('dialog', async (dialog) => {
    confirmationCount += 1;
    await dialog.dismiss();
  });
  await page.evaluate((key) => {
    window.localStorage.setItem(key, 'profile-from-another-tab');
    window.dispatchEvent(new StorageEvent('storage', { key }));
  }, profileStorageKey);

  await expect(page.getByRole('button', { name: 'Taylor User' })).toBeVisible();
  await expect(weeklyHours).toHaveValue('');
  expect(confirmationCount).toBe(0);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), profileStorageKey)).toBe('profile-from-another-tab');
});
