import { expect, test, type Page } from '@playwright/test';

const accessPath = '**/api/resource-allocation/v1/access';
const selectedProfileKey = 'pmo-hub.local-user-id';
const profilePath = '**/api/resource-allocation/v1/admin/resource-profiles**';
const groupPath = '**/api/resource-allocation/v1/admin/resource-profile-groups**';
const pageInfo = { nextCursor: null, limit: 50 };

const platform = { id: '00000000-0000-4000-8000-000000000001', name: 'Platform' };
const dataGroup = { id: '00000000-0000-4000-8000-000000000002', name: 'Data' };
const existingProfile = {
  id: '00000000-0000-4000-8000-000000000003',
  name: 'Platform Engineer',
  groupId: platform.id,
  active: true,
  version: 1,
};
const inactiveProfile = { ...existingProfile, active: false, version: 2 };

async function openWithProfile(page: Page, profileId: string) {
  await page.route(accessPath, async (route) => {
    const role = profileId.includes('supervisor') ? 'ALLOCATION_SUPERVISOR'
      : profileId.includes('manager') ? 'ALLOCATION_MANAGER'
        : profileId.includes('user') ? 'ALLOCATION_USER'
          : profileId.includes('admin') ? 'ALLOCATION_ADMIN'
            : 'ALLOCATION_MODERATOR';
    await route.fulfill({ json: { person: {
      id: `person-${profileId}`,
      localUserId: profileId,
      displayName: profileId,
      role,
      groupId: role === 'ALLOCATION_MODERATOR' ? platform.id : null,
      coveredGroupIds: [],
    } } });
  });
  await page.route('**/api/resource-allocation/v1/notifications**', async (route) => route.fulfill({
    json: { items: [], page: pageInfo },
  }));
  await page.addInitScript(({ key, value }) => {
    window.localStorage.setItem(key, value);
  }, { key: selectedProfileKey, value: profileId });
  await page.goto('/resource-allocation/?page=administration');
}

test('shows scoped profile administration without requesting global people or groups', async ({ page }) => {
  const requestedAdminPaths: string[] = [];
  await page.route(groupPath, async (route) => {
    requestedAdminPaths.push(new URL(route.request().url()).pathname);
    await route.fulfill({ json: { items: [platform], page: pageInfo } });
  });
  await page.route(profilePath, async (route) => {
    requestedAdminPaths.push(new URL(route.request().url()).pathname);
    await route.fulfill({ json: { items: [existingProfile], page: pageInfo } });
  });

  await openWithProfile(page, 'profile-moderator');

  await expect(page.getByRole('link', { name: 'Resource profiles' })).toBeVisible();
  await expect(page.locator('#profile-administration-title')).toBeVisible();
  await expect(page.getByText('Platform Engineer')).toBeVisible();
  expect(requestedAdminPaths).toEqual(expect.arrayContaining([
    '/api/resource-allocation/v1/admin/resource-profiles',
    '/api/resource-allocation/v1/admin/resource-profile-groups',
  ]));
  expect(requestedAdminPaths.some((path) => /\/admin\/(people|groups|initiatives)$/.test(path))).toBe(false);
  await expect(page.getByRole('tab', { name: 'People' })).toHaveCount(0);
  await expect(page.getByText('morgan.admin@example.test')).toHaveCount(0);
});

test('creates a profile for the scoped group and invalidates the list after saving', async ({ page }) => {
  let created: Record<string, unknown> | null = null;
  let createPayload: Record<string, unknown> | undefined;
  await page.route(groupPath, async (route) => route.fulfill({ json: { items: [platform], page: pageInfo } }));
  await page.route(profilePath, async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      createPayload = request.postDataJSON() as Record<string, unknown>;
      created = { id: '00000000-0000-4000-8000-000000000004', ...createPayload, version: 1 };
      await route.fulfill({ status: 201, headers: { etag: '"1"' }, json: created });
      return;
    }
    const items = created ? [existingProfile, created] : [existingProfile];
    await route.fulfill({ json: { items, page: pageInfo } });
  });

  await openWithProfile(page, 'profile-moderator');
  await page.getByRole('button', { name: 'Add resource profile' }).click();
  await page.getByLabel('Resource profile name').fill('Site Reliability Engineer');
  await expect(page.getByLabel('Group')).toHaveValue(platform.id);
  await page.getByRole('button', { name: 'Save resource profile' }).click();

  await expect(page.getByText('Resource profile created.')).toBeVisible();
  await expect(page.getByText('Site Reliability Engineer')).toBeVisible();
  expect(createPayload).toMatchObject({ name: 'Site Reliability Engineer', groupId: platform.id, active: true });
});

test('deactivates a profile with an ETag and explains that existing allocations stay intact', async ({ page }) => {
  let patchPayload: Record<string, unknown> | undefined;
  let patchHeaders: Record<string, string> | undefined;
  await page.route(groupPath, async (route) => route.fulfill({ json: { items: [platform], page: pageInfo } }));
  await page.route(profilePath, async (route) => {
    const request = route.request();
    if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith(existingProfile.id)) {
      await route.fulfill({ headers: { etag: '"1"' }, json: existingProfile });
      return;
    }
    if (request.method() === 'PATCH') {
      patchPayload = request.postDataJSON() as Record<string, unknown>;
      patchHeaders = request.headers();
      await route.fulfill({ headers: { etag: '"2"' }, json: { ...existingProfile, ...patchPayload, version: 2 } });
      return;
    }
    await route.fulfill({ json: { items: [existingProfile], page: pageInfo } });
  });

  await openWithProfile(page, 'profile-supervisor');
  await page.getByRole('button', { name: 'Edit resource profile Platform Engineer' }).click();
  await expect(page.locator('form').getByText(/existing allocations and capacity remain unchanged/i)).toBeVisible();
  await page.getByLabel('Active').uncheck();
  await page.getByRole('button', { name: 'Save resource profile' }).click();

  await expect(page.getByText('Resource profile updated.')).toBeVisible();
  expect(patchPayload).toMatchObject({ active: false });
  expect(patchHeaders?.['if-match']).toBe('"1"');
});

test('leaders cannot reactivate inactive profiles', async ({ page }) => {
  let leaderPatch: Record<string, unknown> | undefined;
  await page.route(groupPath, async (route) => route.fulfill({ json: { items: [platform], page: pageInfo } }));
  await page.route(profilePath, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path.endsWith(existingProfile.id)) {
      await route.fulfill({ headers: { etag: '"2"' }, json: inactiveProfile });
      return;
    }
    if (request.method() === 'PATCH') {
      leaderPatch = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        headers: { etag: '"3"' },
        json: { ...inactiveProfile, ...leaderPatch, version: 3 },
      });
      return;
    }
    await route.fulfill({ json: { items: [inactiveProfile], page: pageInfo } });
  });

  await openWithProfile(page, 'profile-moderator');
  await page.getByRole('button', { name: 'Edit resource profile Platform Engineer' }).click();
  const leaderActive = page.getByLabel('Active');
  await expect(leaderActive).not.toBeChecked();
  await expect(leaderActive).toBeDisabled();
  await expect(page.getByText('Only an Admin can reactivate an inactive resource profile.')).toBeVisible();
  await page.getByLabel('Resource profile name').fill('Renamed inactive profile');
  await page.getByRole('button', { name: 'Save resource profile' }).click();
  await expect(page.getByText('Resource profile updated.')).toBeVisible();
  expect(leaderPatch?.active).not.toBe(true);
});

test('Admins can reactivate inactive profiles', async ({ page }) => {
  let adminPatch: Record<string, unknown> | undefined;
  await page.route(groupPath, async (route) => route.fulfill({ json: { items: [platform], page: pageInfo } }));
  await page.route(/\/api\/resource-allocation\/v1\/admin\/(people|groups|initiatives)(?:\?|$)/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const items = path.endsWith('/groups')
      ? [{ id: platform.id, name: platform.name, active: true, supervisorId: null, managerId: null, version: 1 }]
      : [];
    await route.fulfill({ json: { items, page: pageInfo } });
  });
  await page.route(profilePath, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path.endsWith(existingProfile.id)) {
      await route.fulfill({ headers: { etag: '"2"' }, json: inactiveProfile });
      return;
    }
    if (request.method() === 'PATCH') {
      adminPatch = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({ headers: { etag: '"3"' }, json: { ...inactiveProfile, ...adminPatch, version: 3 } });
      return;
    }
    await route.fulfill({ json: { items: [inactiveProfile], page: pageInfo } });
  });
  await openWithProfile(page, 'profile-admin');
  await page.getByRole('tab', { name: 'Resource profiles' }).click();
  await page.getByRole('button', { name: 'Edit resource profile Platform Engineer' }).click();
  const adminActive = page.getByLabel('Active');
  await expect(adminActive).toBeEnabled();
  await adminActive.check();
  await page.getByRole('button', { name: 'Save resource profile' }).click();
  await expect(page.getByText('Resource profiles record updated.')).toBeVisible();
  expect(adminPatch).toMatchObject({ active: true });
});

test('keeps dirty profile edits and the original ETag after a focus refetch', async ({ page }) => {
  let detailReads = 0;
  let patchIfMatch: string | undefined;
  await page.route(groupPath, async (route) => route.fulfill({ json: { items: [platform], page: pageInfo } }));
  await page.route(profilePath, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path.endsWith(existingProfile.id)) {
      detailReads += 1;
      const current = detailReads === 1
        ? existingProfile
        : { ...existingProfile, name: 'Updated by another admin', version: 2 };
      await route.fulfill({ headers: { etag: `"${current.version}"` }, json: current });
      return;
    }
    if (request.method() === 'PATCH') {
      patchIfMatch = request.headers()['if-match'];
      await route.fulfill({
        status: 412,
        contentType: 'application/problem+json',
        json: {
          type: 'https://pmo-hub.example/problems/precondition-failed',
          title: 'Precondition failed',
          status: 412,
          detail: 'The resource profile changed. Reload the record before saving.',
          code: 'PRECONDITION_FAILED',
        },
      });
      return;
    }
    await route.fulfill({ json: { items: [existingProfile], page: pageInfo } });
  });

  await openWithProfile(page, 'profile-moderator');
  await page.getByRole('button', { name: 'Edit resource profile Platform Engineer' }).click();
  const name = page.getByLabel('Resource profile name');
  await expect(name).toHaveValue('Platform Engineer');
  await name.fill('My unsaved profile name');

  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => detailReads).toBe(2);
  await expect(name).toHaveValue('My unsaved profile name');

  const prompt = page.waitForEvent('dialog');
  const close = page.getByRole('button', { name: 'Close form' }).click();
  const dialog = await prompt;
  expect(dialog.message()).toMatch(/unsaved changes/i);
  await dialog.dismiss();
  await close;

  await page.getByRole('button', { name: 'Save resource profile' }).click();
  await expect(page.getByRole('alert')).toContainText('Your edits are still here.');
  await expect(name).toHaveValue('My unsaved profile name');
  expect(patchIfMatch).toBe('"1"');

  const discardPrompt = page.waitForEvent('dialog');
  const closeAfterConflict = page.getByRole('button', { name: 'Close form' }).click();
  const discardDialog = await discardPrompt;
  await discardDialog.accept();
  await closeAfterConflict;
  await page.getByRole('button', { name: 'Edit resource profile Platform Engineer' }).click();
  await expect(page.getByLabel('Resource profile name')).toHaveValue('Updated by another admin');
});

test('keeps dirty profile edits visible when a background refresh fails', async ({ page }) => {
  let detailReads = 0;
  await page.route(groupPath, async (route) => route.fulfill({ json: { items: [platform], page: pageInfo } }));
  await page.route(profilePath, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path.endsWith(existingProfile.id)) {
      detailReads += 1;
      if (detailReads === 1) {
        await route.fulfill({ headers: { etag: '"1"' }, json: existingProfile });
      } else {
        await route.fulfill({
          status: 500,
          contentType: 'application/problem+json',
          json: { status: 500, title: 'Unexpected error', detail: 'The latest profile version could not be checked.' },
        });
      }
      return;
    }
    await route.fulfill({ json: { items: [existingProfile], page: pageInfo } });
  });

  await openWithProfile(page, 'profile-moderator');
  await page.getByRole('button', { name: 'Edit resource profile Platform Engineer' }).click();
  const name = page.getByLabel('Resource profile name');
  await name.fill('My unsaved profile name');
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));

  await expect.poll(() => detailReads).toBe(2);
  await expect(name).toHaveValue('My unsaved profile name');
  await expect(page.getByRole('alert')).toContainText('Your current values are still here.');

  const prompt = page.waitForEvent('dialog');
  const close = page.getByRole('button', { name: 'Close form' }).click();
  const dialog = await prompt;
  expect(dialog.message()).toMatch(/unsaved changes/i);
  await dialog.dismiss();
  await close;
  await expect(name).toHaveValue('My unsaved profile name');
});

test('shows a close action when an existing profile cannot be loaded', async ({ page }) => {
  await page.route(groupPath, async (route) => route.fulfill({ json: { items: [platform], page: pageInfo } }));
  await page.route(profilePath, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path.endsWith(existingProfile.id)) {
      await route.fulfill({ status: 500, contentType: 'application/problem+json', json: { status: 500, title: 'Unexpected error' } });
      return;
    }
    await route.fulfill({ json: { items: [existingProfile], page: pageInfo } });
  });

  await openWithProfile(page, 'profile-moderator');
  await page.getByRole('button', { name: 'Edit resource profile Platform Engineer' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('heading', { name: 'Edit resource profile' })).toHaveCount(0);
});

test('denies User direct navigation without requesting profile administration data', async ({ page }) => {
  let administrationRequests = 0;
  await page.route(groupPath, async (route) => {
    administrationRequests += 1;
    await route.fulfill({ json: { items: [], page: pageInfo } });
  });
  await page.route(profilePath, async (route) => {
    administrationRequests += 1;
    await route.fulfill({ json: { items: [], page: pageInfo } });
  });
  await openWithProfile(page, 'profile-user');

  await expect(page.getByText(/resource profile administration is only available/i)).toBeVisible();
  await expect(page.locator('#profile-administration-title')).toHaveCount(0);
  expect(administrationRequests).toBe(0);
});

test('clears profile data and disables the form when backend scope is revoked before save', async ({ page }) => {
  await page.route(groupPath, async (route) => route.fulfill({ json: { items: [platform], page: pageInfo } }));
  await page.route(profilePath, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path.endsWith(existingProfile.id)) {
      await route.fulfill({ headers: { etag: '"1"' }, json: existingProfile });
      return;
    }
    if (request.method() === 'PATCH') {
      await route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        json: { status: 403, code: 'ACCESS_DENIED', title: 'Access denied', detail: 'The resource profile is outside your current group scope.' },
      });
      return;
    }
    await route.fulfill({ json: { items: [existingProfile], page: pageInfo } });
  });

  await openWithProfile(page, 'profile-moderator');
  await page.getByRole('button', { name: 'Edit resource profile Platform Engineer' }).click();
  await page.getByLabel('Resource profile name').fill('Changed after scope loss');
  await page.getByRole('button', { name: 'Save resource profile' }).click();

  await expect(page.getByText(/current profile-management scope could not be confirmed/i)).toBeVisible();
  await expect(page.getByText('Platform Engineer')).toHaveCount(0);
  await expect(page.getByLabel('Resource profile name')).toHaveCount(0);
});

test('protects unsaved profile edits when the editor closes', async ({ page }) => {
  await page.route(groupPath, async (route) => route.fulfill({ json: { items: [platform], page: pageInfo } }));
  await page.route(profilePath, async (route) => {
    const request = route.request();
    if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith(existingProfile.id)) {
      await route.fulfill({ headers: { etag: '"1"' }, json: existingProfile });
      return;
    }
    await route.fulfill({ json: { items: [existingProfile], page: pageInfo } });
  });

  await openWithProfile(page, 'profile-moderator');
  await page.getByRole('button', { name: 'Edit resource profile Platform Engineer' }).click();
  const name = page.getByLabel('Resource profile name');
  await name.fill('Unsaved profile name');
  const prompt = page.waitForEvent('dialog');
  const close = page.getByRole('button', { name: 'Close form' }).click();
  const dialog = await prompt;
  expect(dialog.message()).toMatch(/unsaved changes/i);
  await dialog.dismiss();
  await close;
  await expect(name).toHaveValue('Unsaved profile name');
  await expect(page.getByRole('button', { name: 'Close form' })).toBeFocused();
});

test('supports keyboard editing and captures desktop, narrow, 200% zoom, and both themes', async ({ page }, testInfo) => {
  await page.route(groupPath, async (route) => route.fulfill({ json: { items: [platform, dataGroup], page: pageInfo } }));
  await page.route(profilePath, async (route) => route.fulfill({ json: { items: [existingProfile], page: pageInfo } }));
  await openWithProfile(page, 'profile-manager');

  const editButton = page.getByRole('button', { name: 'Edit resource profile Platform Engineer' });
  await editButton.focus();
  await expect(editButton).toBeFocused();
  await page.getByRole('button', { name: 'Dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: testInfo.outputPath('profile-administration-dark-desktop.png'), fullPage: true });

  await page.getByRole('button', { name: 'Dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: testInfo.outputPath('profile-administration-light-desktop.png'), fullPage: true });

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.locator('#profile-administration-title')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('profile-administration-light-narrow.png'), fullPage: true });
  const narrowOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(narrowOverflow).toBe(false);

  await page.getByRole('button', { name: 'Dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: testInfo.outputPath('profile-administration-dark-narrow.png'), fullPage: true });

  await page.evaluate(() => { document.body.style.zoom = '200%'; });
  await page.screenshot({ path: testInfo.outputPath('profile-administration-dark-zoom-200.png'), fullPage: true });
});
