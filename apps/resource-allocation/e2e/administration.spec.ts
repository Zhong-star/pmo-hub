import { expect, test, type Page } from '@playwright/test';

const accessPath = '**/api/resource-allocation/v1/access';
const selectedProfileKey = 'pmo-hub.local-user-id';
const adminApiPath = /\/api\/resource-allocation\/v1\/admin\//;
const adminPeoplePath = /\/api\/resource-allocation\/v1\/admin\/people(?:\?|$)/;
const emptySelectionPage = { nextCursor: null, limit: 100 };

const adminPerson = {
  id: 'person-admin',
  localUserId: 'profile-admin',
  displayName: 'Morgan Admin',
  email: 'morgan.admin@example.test',
  active: true,
  role: 'ALLOCATION_ADMIN',
  groupId: null,
  coveredGroupIds: [],
  version: 1,
};

async function openWithProfile(page: Page, profileId: string) {
  await page.route('**/api/resource-allocation/v1/initiatives**', async (route) => route.fulfill({
    json: { items: [], page: emptySelectionPage },
  }));
  await page.route('**/api/resource-allocation/v1/groups**', async (route) => route.fulfill({
    json: { items: [], page: emptySelectionPage },
  }));
  await page.route('**/api/resource-allocation/v1/resource-profiles**', async (route) => route.fulfill({
    json: { items: [], page: emptySelectionPage },
  }));
  await page.route('**/api/resource-allocation/v1/submissions**', async (route) => route.fulfill({
    json: { items: [], page: { ...emptySelectionPage, limit: 50 } },
  }));
  await page.route('**/api/resource-allocation/v1/requests**', async (route) => route.fulfill({
    json: { items: [], page: { ...emptySelectionPage, limit: 50 } },
  }));
  await page.addInitScript(({ key, value }) => {
    if (!window.localStorage.getItem(key)) window.localStorage.setItem(key, value);
  }, {
    key: selectedProfileKey,
    value: profileId,
  });
  await page.goto('/resource-allocation/');
}

async function installAdminAccess(page: Page) {
  await page.route(accessPath, async (route) => {
    await route.fulfill({ json: { person: adminPerson } });
  });
}

async function installEmptyAdminCollections(page: Page) {
  await page.route(adminApiPath, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 50 } } });
      return;
    }
    await route.fallback();
  });
}

test('shows administrative collections only after current access confirms Admin', async ({ page }) => {
  await installAdminAccess(page);
  await installEmptyAdminCollections(page);

  await openWithProfile(page, 'profile-admin');

  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'People' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Groups' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Resource profiles' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Initiatives' })).toBeVisible();
  await expect(page.getByText('No people have been added yet.')).toBeVisible();
});

test('does not request or display administrative records for a non-Admin', async ({ page }) => {
  let adminRequests = 0;
  await page.route(accessPath, async (route) => {
    await route.fulfill({ json: { person: { ...adminPerson, role: 'ALLOCATION_USER' } } });
  });
  await page.route(adminApiPath, async (route) => {
    adminRequests += 1;
    await route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 50 } } });
  });

  await openWithProfile(page, 'profile-user');

  await expect(page.getByText('Morgan Admin')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Administration' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'People' })).toHaveCount(0);
  expect(adminRequests).toBe(0);
});

test('clears cached administrative details when the selected Hub profile changes', async ({ page }) => {
  const adminProfiles: string[] = [];
  await page.route(accessPath, async (route) => {
    const profileId = route.request().headers()['x-pmo-local-user-id'];
    await route.fulfill({
      json: {
        person: {
          ...adminPerson,
          localUserId: profileId,
          displayName: profileId === 'profile-admin' ? 'Morgan Admin' : 'Taylor User',
          role: profileId === 'profile-admin' ? 'ALLOCATION_ADMIN' : 'ALLOCATION_USER',
        },
      },
    });
  });
  await page.route(adminApiPath, async (route) => {
    const profileId = route.request().headers()['x-pmo-local-user-id'] ?? '';
    adminProfiles.push(profileId);
    const url = new URL(route.request().url());
    const items = url.pathname.endsWith('/admin/people') ? [{
      ...adminPerson,
      id: 'person-private',
      displayName: 'Private Staff Record',
      email: 'private.staff@example.test',
    }] : [];
    await route.fulfill({ json: { items, page: { nextCursor: null, limit: 50 } } });
  });

  await openWithProfile(page, 'profile-admin');
  await expect(page.getByText('Private Staff Record')).toBeVisible();
  await expect(page.getByText('private.staff@example.test')).toBeVisible();

  await page.evaluate(({ key }) => {
    window.localStorage.setItem(key, 'profile-user');
    window.dispatchEvent(new StorageEvent('storage', { key }));
  }, { key: selectedProfileKey });

  await expect(page.getByText('Private Staff Record')).toHaveCount(0);
  await expect(page.getByText('private.staff@example.test')).toHaveCount(0);
  await expect(page.getByText('Taylor User')).toBeVisible();
  expect(adminProfiles).not.toContain('profile-user');
});

test('allows an Admin to remain ungrouped while exposing an optional primary group field', async ({ page }) => {
  await installAdminAccess(page);
  let personPayload: Record<string, unknown> | undefined;
  let person: Record<string, unknown> | null = null;
  await page.route(adminApiPath, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/admin/people') && request.method() === 'POST') {
      personPayload = request.postDataJSON() as Record<string, unknown>;
      person = { id: 'new-admin', ...personPayload, coveredGroupIds: [], version: 1 };
      await route.fulfill({ status: 201, headers: { etag: '"1"' }, json: person });
      return;
    }
    if (request.method() === 'GET') {
      const items = url.pathname.endsWith('/admin/people') && person ? [person] : [];
      await route.fulfill({ json: { items, page: { nextCursor: null, limit: 50 } } });
      return;
    }
    await route.fallback();
  });

  await openWithProfile(page, 'profile-admin');
  await page.getByRole('button', { name: 'Add person' }).click();
  await page.getByLabel('Local user ID').fill('profile-new-admin');
  await page.getByLabel('Display name').fill('Casey Admin');
  await page.getByLabel('Email').fill('casey.admin@example.test');
  await page.getByLabel('Role').selectOption('ALLOCATION_ADMIN');

  await expect(page.locator('#admin-groupId')).toBeVisible();
  await page.getByRole('button', { name: 'Save person' }).click();

  await expect(page.getByText('Casey Admin')).toBeVisible();
  expect(personPayload).toMatchObject({
    localUserId: 'profile-new-admin',
    role: 'ALLOCATION_ADMIN',
    groupId: null,
    active: true,
  });
});

test('creates and conditionally edits an initiative through the admin form', async ({ page }) => {
  await installAdminAccess(page);

  let initiative: Record<string, unknown> | null = null;
  let createHeaders: Record<string, string> | undefined;
  const createAttemptKeys: string[] = [];
  let patchHeaders: Record<string, string> | undefined;
  let patchBody: Record<string, unknown> | undefined;

  await page.route(adminApiPath, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/admin/initiatives') && request.method() === 'GET') {
      await route.fulfill({
        json: { items: initiative ? [initiative] : [], page: { nextCursor: null, limit: 50 } },
      });
      return;
    }
    if (url.pathname.endsWith('/admin/initiatives') && request.method() === 'POST') {
      createHeaders = request.headers();
      createAttemptKeys.push(createHeaders['idempotency-key']);
      if (createAttemptKeys.length === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          json: { status: 503, code: 'DEPENDENCY_UNAVAILABLE', detail: 'Try again.' },
        });
        return;
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      initiative = { id: 'initiative-1', ...body, version: 1 };
      await route.fulfill({ status: 201, headers: { etag: '"1"' }, json: initiative });
      return;
    }
    if (url.pathname.endsWith('/admin/initiatives/initiative-1') && request.method() === 'GET') {
      await route.fulfill({ headers: { etag: '"1"' }, json: initiative });
      return;
    }
    if (url.pathname.endsWith('/admin/initiatives/initiative-1') && request.method() === 'PATCH') {
      patchHeaders = request.headers();
      patchBody = request.postDataJSON() as Record<string, unknown>;
      initiative = { ...initiative, ...patchBody, version: 2 };
      await route.fulfill({ headers: { etag: '"2"' }, json: initiative });
      return;
    }
    if (request.method() === 'GET') {
      await route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 50 } } });
      return;
    }
    await route.fallback();
  });

  await openWithProfile(page, 'profile-admin');
  await page.getByRole('tab', { name: 'Initiatives' }).click();
  await page.getByRole('button', { name: 'Add initiative' }).click();
  await page.getByLabel('Code').fill('ITDM-9');
  await page.getByLabel('Name').fill('Client platform rollout');
  await page.getByRole('button', { name: 'Save initiative' }).click();
  await expect(page.getByRole('region', { name: 'Administration' }).getByRole('alert')).toContainText('Try again.');
  await expect(page.getByLabel('Name')).toHaveValue('Client platform rollout');
  await page.getByRole('button', { name: 'Save initiative' }).click();

  await expect(page.getByText('Client platform rollout')).toBeVisible();
  expect(createHeaders?.['x-pmo-local-user-id']).toBe('profile-admin');
  expect(createAttemptKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  expect(createAttemptKeys[1]).toBe(createAttemptKeys[0]);
  expect(initiative).toMatchObject({ code: 'ITDM-9', name: 'Client platform rollout', active: true });

  await page.getByRole('button', { name: 'Edit initiative ITDM-9' }).click();
  await expect(page.getByLabel('Name')).toHaveValue('Client platform rollout');
  await page.getByLabel('Name').fill('Client platform refresh');
  await page.getByRole('button', { name: 'Save initiative' }).click();

  await expect(page.getByText('Client platform refresh')).toBeVisible();
  expect(patchHeaders?.['x-pmo-local-user-id']).toBe('profile-admin');
  expect(patchHeaders?.['if-match']).toBe('"1"');
  expect(patchHeaders?.['content-type']).toContain('application/merge-patch+json');
  expect(patchBody).toEqual({ code: 'ITDM-9', name: 'Client platform refresh', active: true });
});

test('limits group leadership selectors to active people in the matching role', async ({ page }) => {
  await installAdminAccess(page);
  await page.route(adminApiPath, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 50 } } });
      return;
    }
    await route.fallback();
  });
  await page.route(adminPeoplePath, async (route) => {
    await route.fulfill({
      json: {
        items: [
          { ...adminPerson, id: 'supervisor-1', displayName: 'Avery Supervisor', role: 'ALLOCATION_SUPERVISOR', active: true },
          { ...adminPerson, id: 'supervisor-inactive', displayName: 'Inactive Supervisor', role: 'ALLOCATION_SUPERVISOR', active: false },
          { ...adminPerson, id: 'manager-1', displayName: 'Jamie Manager', role: 'ALLOCATION_MANAGER', active: true },
          { ...adminPerson, id: 'user-1', displayName: 'Regular User', role: 'ALLOCATION_USER', active: true },
        ],
        page: { nextCursor: null, limit: 50 },
      },
    });
  });

  await openWithProfile(page, 'profile-admin');
  await page.getByRole('tab', { name: 'Groups' }).click();
  await page.getByRole('button', { name: 'Add group' }).click();

  await expect(page.getByLabel('Supervisor')).toContainText('Avery Supervisor');
  await expect(page.getByLabel('Supervisor')).not.toContainText('Inactive Supervisor');
  await expect(page.getByLabel('Supervisor')).not.toContainText('Regular User');
  await expect(page.getByLabel('Manager')).toContainText('Jamie Manager');
  await expect(page.getByLabel('Manager')).not.toContainText('Avery Supervisor');
});
