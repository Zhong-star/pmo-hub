import { expect, test, type Page } from '@playwright/test';

const apiRoot = '**/api/resource-allocation/v1';
const profileStorageKey = 'pmo-hub.local-user-id';
const notificationId = '20000000-0000-4000-8000-000000000070';
const requestId = '20000000-0000-4000-8000-000000000071';

const user = {
  id: 'person-user',
  localUserId: 'profile-user',
  displayName: 'Taylor User',
  role: 'ALLOCATION_MODERATOR',
  coveredGroupIds: [],
};

async function installModuleFixtures(page: Page, person = user) {
  await page.route(`${apiRoot}/access`, async (route) => route.fulfill({ json: { person } }));
  await page.route(`${apiRoot}/groups**`, async (route) => route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 100 } } }));
  await page.route(`${apiRoot}/resource-profiles**`, async (route) => route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 100 } } }));
  await page.route(`${apiRoot}/initiatives**`, async (route) => route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 100 } } }));
  await page.route(`${apiRoot}/submissions**`, async (route) => route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 50 } } }));
  await page.route(`${apiRoot}/requests**`, async (route) => route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 50 } } }));
  await page.route(`${apiRoot}/request-queues/**`, async (route) => route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 50 } } }));
}

function notification(id: string, title: string, available: boolean, readAt: string | null = null) {
  return {
    id,
    eventCode: 'REQUEST_SUBMITTED',
    title,
    message: 'A resource request needs your attention.',
    createdAt: '2026-11-20T12:00:00.000000Z',
    readAt,
    etag: `"etag-${id.slice(-2)}-${readAt ? 'read' : 'new'}"`,
    target: {
      type: 'REQUEST',
      requestId,
      available,
      destination: available ? 'REQUEST_DETAIL' : null,
    },
  };
}

async function openAsUser(page: Page) {
  await page.addInitScript(({ key }) => window.localStorage.setItem(key, 'profile-user'), {
    key: profileStorageKey,
  });
  await page.goto('/resource-allocation/?page=notifications');
}

test('filters and reads inbox items while hiding unavailable targets', async ({ page }) => {
  await installModuleFixtures(page);
  const items = [
    notification(notificationId, 'Your request was received', true),
    notification('20000000-0000-4000-8000-000000000072', 'A request is unavailable', false),
    {
      ...notification('20000000-0000-4000-8000-000000000073', 'A team request needs review', true),
      target: {
        type: 'REQUEST' as const,
        requestId: '20000000-0000-4000-8000-000000000074',
        available: true,
        destination: 'TEAM_DECISION_QUEUE' as const,
      },
    },
  ];
  let readCount = 0;
  let markAllCount = 0;
  const notificationRequests: string[] = [];
  await page.route(`${apiRoot}/notifications**`, async (route) => {
    const apiRequest = route.request();
    const url = new URL(apiRequest.url());
    if (apiRequest.method() === 'POST') {
      const headers = apiRequest.headers();
      expect(headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
      if (url.pathname.endsWith('/notification-readings')) {
        markAllCount += 1;
        for (const item of items) {
          item.readAt = '2026-11-20T12:30:00.000000Z';
          item.etag = `"etag-${item.id.slice(-2)}-read"`;
        }
        await route.fulfill({ status: 200, json: { cutoffAt: '2026-11-20T12:30:00.000000Z', markedCount: items.length } });
        return;
      }
      expect(headers['if-match']).toBe(items[0].etag);
      readCount += 1;
      items[0].readAt = '2026-11-20T12:15:00.000000Z';
      items[0].etag = `"etag-${items[0].id.slice(-2)}-read"`;
      await route.fulfill({ status: 200, headers: { etag: items[0].etag }, json: items[0] });
      return;
    }

    notificationRequests.push(url.href);
    const filter = url.searchParams.get('read');
    const filtered = items.filter((item) => filter === null
      || (filter === 'true' ? item.readAt !== null : item.readAt === null));
    await route.fulfill({ json: { items: filtered, page: { nextCursor: null, limit: 50 } } });
  });
  await page.route(`${apiRoot}/notification-readings`, async (route) => {
    expect(route.request().headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
    markAllCount += 1;
    const markedCount = items.filter((item) => item.readAt === null).length;
    for (const item of items) {
      item.readAt = '2026-11-20T12:30:00.000000Z';
      item.etag = `"etag-${item.id.slice(-2)}-read"`;
    }
    await route.fulfill({ status: 200, json: { cutoffAt: '2026-11-20T12:30:00.000000Z', markedCount } });
  });

  await openAsUser(page);
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your request was received' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'A request is unavailable' })).toBeVisible();
  const availableLink = page.getByRole('link', { name: 'Open related request' });
  await expect(availableLink.nth(0)).toHaveAttribute('href', `/resource-allocation/?page=requests&requestId=${requestId}`);
  await expect(availableLink.nth(1)).toHaveAttribute(
    'href',
    '/resource-allocation/?page=request-queues&queue=team-decision&requestId=20000000-0000-4000-8000-000000000074',
  );
  await expect(page.getByText('This request is no longer available to you.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open related request' })).toHaveCount(2);

  await page.getByRole('button', { name: 'Mark as read' }).first().click();
  await expect(page.locator('.notification-status').filter({ hasText: /^Read$/ }).first()).toBeVisible();
  expect(readCount).toBe(1);

  await page.getByLabel('Show').selectOption('unread');
  await expect.poll(() => notificationRequests.some((value) => new URL(value).searchParams.get('read') === 'false')).toBe(true);
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByText('0 unread on this page')).toBeVisible();
  expect(markAllCount).toBe(1);

  await page.getByLabel('Show').selectOption('read');
  await expect(page.getByRole('heading', { name: 'Your request was received' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'A request is unavailable' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'A team request needs review' })).toBeVisible();
});

test('opens an owned notification in the scoped request detail view', async ({ page }) => {
  const requester = { ...user, id: 'person-owner', role: 'ALLOCATION_USER' };
  await installModuleFixtures(page, requester);
  const ownedRequest = {
    id: requestId,
    requesterSnapshot: { personId: requester.id, displayName: requester.displayName, role: requester.role },
    requestedConditions: {
      initiativeId: '20000000-0000-4000-8000-000000000075',
      initiativeCode: 'ITDM-70',
      initiativeName: 'Notification navigation',
      category: 'EXECUTION_PROJECT',
      groupId: '20000000-0000-4000-8000-000000000076',
      groupName: 'Platform Engineering',
      resourceProfileId: '20000000-0000-4000-8000-000000000077',
      resourceProfileName: 'API Engineering',
      startDate: '2027-01-05',
      endDate: '2027-01-19',
      weeklyHours: 8,
      comment: 'Original request text.',
    },
    decisionState: 'WAITING_FOR_PRESENTATION',
    receivedAt: '2026-11-20T12:00:00.000Z',
    stageEnteredAt: '2026-11-20T12:00:00.000Z',
    expirationDueAt: '2026-12-11T12:00:00.000Z',
    version: 1,
  };
  await page.route(`${apiRoot}/notifications**`, async (route) => route.fulfill({
    json: { items: [notification(notificationId, 'Your request was received', true)], page: { nextCursor: null, limit: 50 } },
  }));
  await page.route(`${apiRoot}/requests**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/requests/${requestId}`)) {
      await route.fulfill({ headers: { etag: '"1"' }, json: ownedRequest });
    } else {
      await route.fulfill({ json: { items: [ownedRequest], page: { nextCursor: null, limit: 50 } } });
    }
  });

  await openAsUser(page);
  await page.getByRole('link', { name: 'Open related request' }).click();
  await expect(page).toHaveURL(new RegExp(`requestId=${requestId}`));
  await expect(page.getByRole('heading', { name: 'My requests' })).toBeVisible();
  const requestDetail = page.getByRole('region', { name: 'ITDM-70' });
  await expect(requestDetail).toBeVisible();
  await expect(requestDetail.getByRole('textbox', { name: /Comment/ })).toHaveValue('Original request text.');
});

test('opens the scoped team queue from a notice without requesting private owner detail', async ({ page }) => {
  const groupId = '20000000-0000-4000-8000-000000000076';
  await installModuleFixtures(page, { ...user, coveredGroupIds: [groupId] });
  await page.route(`${apiRoot}/access`, (route) => route.fulfill({ json: { person: { ...user, groupId } } }));
  let ownerDetailRequests = 0;
  await page.route(`${apiRoot}/requests/${requestId}`, async (route) => {
    ownerDetailRequests += 1;
    await route.fulfill({ status: 404 });
  });
  await page.route(`${apiRoot}/notifications**`, (route) => route.fulfill({
    json: {
      items: [{
        ...notification(notificationId, 'Review the referred request', true),
        target: { type: 'REQUEST', requestId, available: true, destination: 'TEAM_DECISION_QUEUE' },
      }],
      page: { nextCursor: null, limit: 50 },
    },
  }));
  await page.route(`${apiRoot}/request-queues/team-decision**`, (route) => route.fulfill({
    json: {
      items: [{
        id: requestId,
        requester: { displayName: 'Jordan Requester', role: 'ALLOCATION_USER' },
        requestedConditions: {
          initiativeId: requestId, initiativeCode: 'ITDM-TEAM', initiativeName: 'Team planning',
          groupId, groupName: 'Platform Engineering', resourceProfileId: requestId,
          resourceProfileName: 'API Engineering', weeklyHours: 8,
          startDate: '2027-01-05', endDate: '2027-01-19',
        },
        decisionState: 'PENDING_TEAM_DECISION', receivedAt: '2026-11-20T12:00:00Z',
        stageEnteredAt: '2026-11-20T13:00:00Z', dueAt: null, nextResponsible: [],
        availableActions: [], impediments: [], version: 2,
      }],
      page: { nextCursor: null, limit: 50 },
    },
  }));

  await openAsUser(page);
  await page.getByRole('link', { name: 'Open related request' }).click();
  await expect(page).toHaveURL(new RegExp(`page=request-queues&queue=team-decision&requestId=${requestId}`));
  const item = page.locator(`[id="resource-request-${requestId}"]`);
  await expect(item).toContainText('Team planning');
  await expect(item).toBeFocused();
  expect(ownerDetailRequests).toBe(0);
});

test('refreshes every 30 seconds while visible and when the user returns to the tab', async ({ page }) => {
  await page.clock.install({ time: new Date('2099-01-01T00:00:00Z') });
  await installModuleFixtures(page);
  let notificationRequestCount = 0;
  await page.route(`${apiRoot}/notifications**`, async (route) => {
    notificationRequestCount += 1;
    await route.fulfill({ json: { items: [notification(notificationId, 'A fresh update', true)], page: { nextCursor: null, limit: 50 } } });
  });

  await openAsUser(page);
  await expect(page.getByRole('heading', { name: 'A fresh update' })).toBeVisible();
  await expect.poll(() => notificationRequestCount).toBeGreaterThan(0);
  const initialCount = notificationRequestCount;

  await page.clock.fastForward(30_000);
  await expect.poll(() => notificationRequestCount).toBeGreaterThan(initialCount);

  const visibleCount = notificationRequestCount;
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(60_000);
  expect(notificationRequestCount).toBe(visibleCount);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => notificationRequestCount).toBeGreaterThan(visibleCount);
});

test('keeps loaded notifications visible and offers retry when revalidation fails', async ({ page }) => {
  await page.clock.install({ time: new Date('2099-01-01T00:00:00Z') });
  await installModuleFixtures(page);
  let notificationRequestCount = 0;
  let revalidationFailed = false;
  await page.route(`${apiRoot}/notifications**`, async (route) => {
    notificationRequestCount += 1;
    if (!revalidationFailed && notificationRequestCount > 1) {
      revalidationFailed = true;
      await route.fulfill({
        status: 503,
        contentType: 'application/problem+json',
        body: JSON.stringify({ status: 503, title: 'Unavailable', detail: 'The notification service is unavailable.' }),
      });
      return;
    }
    await route.fulfill({
      json: { items: [notification(notificationId, 'Current inbox item', true)], page: { nextCursor: null, limit: 50 } },
    });
  });

  await openAsUser(page);
  await expect(page.getByRole('heading', { name: 'Current inbox item' })).toBeVisible();
  await page.clock.fastForward(30_000);
  await expect(page.getByText('Updates could not be checked. Your current inbox stays visible until you retry.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Current inbox item' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry refresh' }).click();
  await expect.poll(() => notificationRequestCount).toBe(3);
  await expect(page.getByRole('heading', { name: 'Current inbox item' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry refresh' })).toHaveCount(0);
});
