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
  await page.goto('/resource-allocation/');
}

test('renders the header notifications bell menu, reads single and all items, and closes on Escape or outside click', async ({ page }) => {
  await installModuleFixtures(page);
  const items = [
    notification(notificationId, 'Your request was received', true),
    notification('20000000-0000-4000-8000-000000000072', 'A request is unavailable', false),
    {
      ...notification('20000000-0000-4000-8000-000000000073', 'A team request needs review', true),
      eventCode: 'REQUEST_REFERRED_2',
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
  await page.route(`${apiRoot}/notifications**`, async (route) => {
    const apiRequest = route.request();
    const url = new URL(apiRequest.url());
    if (apiRequest.method() === 'POST') {
      const headers = apiRequest.headers();
      expect(headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
      expect(headers['if-match']).toBe(items[0].etag);
      readCount += 1;
      items[0].readAt = '2026-11-20T12:15:00.000000Z';
      items[0].etag = `"etag-${items[0].id.slice(-2)}-read"`;
      await route.fulfill({ status: 200, headers: { etag: items[0].etag }, json: items[0] });
      return;
    }

    expect(url.searchParams.get('read')).toBeNull();
    await route.fulfill({ json: { items, page: { nextCursor: null, limit: 50 } } });
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
  const trigger = page.getByRole('button', { name: 'Notifications (3 unread)' });
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');

  const menu = page.getByRole('region', { name: 'Notifications' });
  await expect(menu.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(menu.getByText('3 unread')).toBeVisible();
  await expect(menu.getByText('Request submitted')).toHaveCount(2);
  await expect(menu.getByText('Request referred')).toBeVisible();
  await expect(menu.getByText('Your request was received')).toBeVisible();
  await expect(menu.getByText('A request is unavailable')).toBeVisible();

  const availableLinks = menu.locator('a.notifications-menu__open-button');
  await expect(availableLinks).toHaveCount(2);
  await expect(availableLinks.nth(0)).toHaveAttribute('href', `/resource-allocation/?page=requests&requestId=${requestId}`);
  await expect(availableLinks.nth(1)).toHaveAttribute(
    'href',
    '/resource-allocation/?page=request-queues&queue=team-decision&requestId=20000000-0000-4000-8000-000000000074',
  );
  await expect(menu.getByText('This request is no longer available to you.')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(menu).toBeVisible();
  await page.getByRole('heading', { name: 'My requests' }).click();
  await expect(menu).toHaveCount(0);

  await trigger.click();
  await menu.getByRole('button', { name: 'Mark "Your request was received" as read' }).click();
  await expect(menu.getByText('Read', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Notifications (2 unread)' })).toBeVisible();
  expect(readCount).toBe(1);

  await menu.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(menu.getByText('All caught up')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
  expect(markAllCount).toBe(1);
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
  await page.getByRole('button', { name: 'Notifications (1 unread)' }).click();
  await page.getByRole('link', { name: /Open related request: Your request was received/ }).click();
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
  await page.getByRole('button', { name: 'Notifications (1 unread)' }).click();
  await page.getByRole('link', { name: /Open related request: Review the referred request/ }).click();
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
  await expect(page.getByRole('button', { name: 'Notifications (1 unread)' })).toBeVisible();
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
  let failRefresh = false;
  await page.route(`${apiRoot}/notifications**`, async (route) => {
    notificationRequestCount += 1;
    if (failRefresh) {
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
  const trigger = page.getByRole('button', { name: 'Notifications (1 unread)' });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const menu = page.getByRole('region', { name: 'Notifications' });
  await expect(menu.getByText('Current inbox item')).toBeVisible();

  failRefresh = true;
  await page.clock.fastForward(30_000);
  await expect(menu.getByText('Updates could not be checked. Your current notifications stay visible until you retry.')).toBeVisible();
  await expect(menu.getByText('Current inbox item')).toBeVisible();

  failRefresh = false;
  const countBeforeRetry = notificationRequestCount;
  await menu.getByRole('button', { name: 'Retry refresh' }).click();
  await expect.poll(() => notificationRequestCount).toBeGreaterThan(countBeforeRetry);
  await expect(menu.getByText('Current inbox item')).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Retry refresh' })).toHaveCount(0);
});
