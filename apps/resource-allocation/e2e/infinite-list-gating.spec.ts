import { expect, test, type Page } from '@playwright/test';

const apiRoot = '**/api/resource-allocation/v1';
const profileStorageKey = 'pmo-hub.local-user-id';
const emptyPage = { nextCursor: null, limit: 50 };
const emptySelectionPage = { nextCursor: null, limit: 100 };

const adminUser = {
  id: 'person-admin',
  localUserId: 'profile-admin',
  displayName: 'Morgan Admin',
  email: 'morgan.admin@example.test',
  active: true,
  role: 'ALLOCATION_ADMIN',
  groupId: 'group-1',
  coveredGroupIds: [],
  version: 1,
};

async function installBaselineRoutes(page: Page, user = adminUser) {
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
    key: profileStorageKey,
    value: user.localUserId,
  });
  await page.route(`${apiRoot}/access`, async (route) => route.fulfill({ json: { person: user } }));
  await page.route(`${apiRoot}/groups**`, async (route) => route.fulfill({ json: { items: [{ id: 'group-1', name: 'Platform Engineering' }], page: emptySelectionPage } }));
  await page.route(`${apiRoot}/resource-profiles**`, async (route) => route.fulfill({ json: { items: [{ id: 'profile-1', name: 'API Engineering', groupId: 'group-1' }], page: emptySelectionPage } }));
  await page.route(`${apiRoot}/initiatives**`, async (route) => route.fulfill({ json: { items: [{ id: 'init-1', code: 'ITDM-1', name: 'Alpha' }], page: emptySelectionPage } }));
  await page.route(`${apiRoot}/submissions**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/notifications**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/requests**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/request-queues/**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/allocations**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/allocation-load**`, async (route) => route.fulfill({ json: { date: '2026-11-21', items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/admin/**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
}

function unavailableProblem(detail = 'Temporarily unavailable') {
  return { status: 503, contentType: 'application/problem+json', json: { status: 503, code: 'DEPENDENCY_UNAVAILABLE', detail } };
}

test('keeps loaded selection options without a top-level banner on next-page failure and gates selection pagination during active fetches and refresh failures', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-21T12:00:00.000Z') });
  await installBaselineRoutes(page);

  let failNextPage = true;
  let failGroupsRefresh = false;

  await page.route(`${apiRoot}/initiatives**`, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (cursor === 'init-page-2') {
      if (failNextPage) {
        await route.fulfill(unavailableProblem());
        return;
      }
      await route.fulfill({
        json: {
          items: [{ id: 'init-2', code: 'ITDM-2', name: 'Beta' }],
          page: emptySelectionPage,
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        items: [{ id: 'init-1', code: 'ITDM-1', name: 'Alpha' }],
        page: { nextCursor: 'init-page-2', limit: 100 },
      },
    });
  });

  await page.route(`${apiRoot}/groups**`, async (route) => {
    if (failGroupsRefresh) {
      await route.fulfill(unavailableProblem());
      return;
    }
    await route.fulfill({ json: { items: [{ id: 'group-1', name: 'Platform Engineering' }], page: emptySelectionPage } });
  });

  await page.goto('/resource-allocation/?page=requests');
  await page.getByRole('button', { name: 'New request' }).click();
  const batchPanel = page.locator('#new-request-batch');
  const initiativeSelect = batchPanel.getByRole('combobox', { name: 'Initiative', exact: true });
  const loadMoreButton = batchPanel.getByRole('button', { name: /Load more selection options|Loading more selection options/i });

  await expect(initiativeSelect).toContainText('ITDM-1 — Alpha');
  await expect(loadMoreButton).toBeEnabled();

  // Hold page-2 request in flight so we can verify disabled state during active fetch
  let unblockPage2!: () => void;
  const page2Gate = new Promise<void>((resolve) => { unblockPage2 = resolve; });
  await page.unroute(`${apiRoot}/initiatives**`);
  await page.route(`${apiRoot}/initiatives**`, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (cursor === 'init-page-2') {
      await page2Gate;
      if (failNextPage) {
        await route.fulfill(unavailableProblem());
        return;
      }
      await route.fulfill({
        json: { items: [{ id: 'init-2', code: 'ITDM-2', name: 'Beta' }], page: emptySelectionPage },
      });
      return;
    }
    await route.fulfill({
      json: { items: [{ id: 'init-1', code: 'ITDM-1', name: 'Alpha' }], page: { nextCursor: 'init-page-2', limit: 100 } },
    });
  });

  await loadMoreButton.click();
  await expect(loadMoreButton).toBeDisabled();
  unblockPage2();

  // Next-page failure keeps ITDM-1 visible, shows NO top-level error banner, and shows localized error near Load more
  await expect(batchPanel.getByText('More request options could not be loaded.')).toBeVisible();
  await expect(batchPanel.getByText('Request options could not be loaded. Your submission history remains available.')).toHaveCount(0);
  await expect(initiativeSelect).toContainText('ITDM-1 — Alpha');
  await expect(loadMoreButton).toBeEnabled();
  const localizedRetry = batchPanel.locator('.load-more-error').getByRole('button', { name: 'Try again' });
  await expect(localizedRetry).toBeEnabled();

  // While retrying page 2 via localized Try again, both Load more selection options and Try again stay disabled
  let unblockRetryPage2!: () => void;
  const retryGate = new Promise<void>((resolve) => { unblockRetryPage2 = resolve; });
  await page.unroute(`${apiRoot}/initiatives**`);
  await page.route(`${apiRoot}/initiatives**`, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (cursor === 'init-page-2') {
      await retryGate;
      if (failNextPage) {
        await route.fulfill(unavailableProblem());
        return;
      }
      await route.fulfill({
        json: { items: [{ id: 'init-2', code: 'ITDM-2', name: 'Beta' }], page: emptySelectionPage },
      });
      return;
    }
    await route.fulfill({
      json: { items: [{ id: 'init-1', code: 'ITDM-1', name: 'Alpha' }], page: { nextCursor: 'init-page-2', limit: 100 } },
    });
  });

  await localizedRetry.click();
  await expect(loadMoreButton).toBeDisabled();
  await expect(localizedRetry).toBeDisabled();
  unblockRetryPage2();
  await expect(localizedRetry).toBeEnabled();

  // Background refresh failure disables Load more selection options until top-level retry succeeds
  failGroupsRefresh = true;
  await page.clock.fastForward(30_000);
  await expect(batchPanel.getByText('Request options could not be loaded. Your submission history remains available.')).toBeVisible();
  await expect(loadMoreButton).toBeDisabled();

  // Recover background refresh via top-level Try again, then retry next page and load ITDM-2
  failGroupsRefresh = false;
  failNextPage = false;
  await batchPanel.locator('.form-error').filter({ hasText: 'Request options could not be loaded. Your submission history remains available.' }).getByRole('button', { name: 'Try again' }).click();
  await expect(batchPanel.getByText('Request options could not be loaded. Your submission history remains available.')).toHaveCount(0);
  await expect(loadMoreButton).toBeEnabled();

  await loadMoreButton.click();
  await expect(initiativeSelect).toContainText('ITDM-2 — Beta');
});

test('gates My submissions Load more and Try again buttons during active fetches and background refresh failures', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-21T12:00:00.000Z') });
  await installBaselineRoutes(page);

  let failPage2 = true;
  let failRefresh = false;
  let page2Gate: Promise<void> | null = null;
  let unblockPage2: (() => void) | null = null;
  let refreshGate: Promise<void> | null = null;
  let unblockRefresh: (() => void) | null = null;

  const submissionItem = (id: string) => ({
    id,
    initiativeId: 'init-1',
    initiative: { id: 'init-1', code: 'ITDM-1', name: 'Alpha' },
    category: 'EXECUTION_PROJECT',
    receivedAt: '2026-11-20T12:00:00.000Z',
    lineCount: 1,
    counts: { received: 0, processing: 0, succeeded: 1, failed: 0 },
  });

  await page.route(`${apiRoot}/submissions**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/lines')) {
      await route.fulfill({ json: { items: [], page: emptySelectionPage } });
      return;
    }
    if (!url.pathname.endsWith('/submissions')) {
      await route.fulfill({ json: submissionItem('sub-1') });
      return;
    }
    const cursor = url.searchParams.get('cursor');
    if (cursor === 'sub-page-2') {
      if (page2Gate) await page2Gate;
      if (failPage2) {
        await route.fulfill(unavailableProblem());
        return;
      }
      await route.fulfill({ json: { items: [submissionItem('sub-2')], page: emptyPage } });
      return;
    }
    if (refreshGate) await refreshGate;
    if (failRefresh) {
      await route.fulfill(unavailableProblem());
      return;
    }
    await route.fulfill({ json: { items: [submissionItem('sub-1')], page: { nextCursor: 'sub-page-2', limit: 50 } } });
  });

  await page.goto('/resource-allocation/?page=requests');
  const panel = page.getByRole('region', { name: 'My submissions' });
  const loadMoreButton = panel.locator('.load-submissions-button');

  await expect(panel.getByText('sub-1', { exact: false }).first()).toBeVisible();
  await expect(loadMoreButton).toBeEnabled();

  // Fail page 2 -> localized error only, sub-1 stays visible, no top-level banner
  await loadMoreButton.click();
  await expect(panel.getByText('More saved submissions could not be loaded.')).toBeVisible();
  await expect(panel.getByText('Saved submissions could not be loaded. You can retry without losing the current form.')).toHaveCount(0);
  await expect(panel.getByText('sub-1', { exact: false }).first()).toBeVisible();

  const localizedRetry = panel.locator('.load-more-error').getByRole('button', { name: 'Try again' });
  await expect(localizedRetry).toBeEnabled();

  // Hold localized retry in flight -> both Load more submissions and localized Try again must be disabled
  page2Gate = new Promise<void>((resolve) => { unblockPage2 = resolve; });
  await localizedRetry.click();
  await expect(loadMoreButton).toBeDisabled();
  await expect(localizedRetry).toBeDisabled();
  unblockPage2?.();
  page2Gate = null;
  await expect(localizedRetry).toBeEnabled();

  // Background refresh failure -> top-level banner appears and Load more submissions is disabled
  failRefresh = true;
  await page.clock.fastForward(30_000);
  await expect(panel.getByText('Saved submissions could not be loaded. You can retry without losing the current form.')).toBeVisible();
  await expect(loadMoreButton).toBeDisabled();

  // Top-level Try again is disabled while refetching, then recovers and re-enables Load more submissions
  const topRetry = panel.locator('.form-error').filter({ hasText: 'Saved submissions could not be loaded. You can retry without losing the current form.' }).getByRole('button', { name: 'Try again' });
  refreshGate = new Promise<void>((resolve) => { unblockRefresh = resolve; });
  failRefresh = false;
  failPage2 = false;
  await topRetry.click();
  await expect(topRetry).toBeDisabled();
  unblockRefresh?.();
  refreshGate = null;

  await expect(panel.getByText('Saved submissions could not be loaded. You can retry without losing the current form.')).toHaveCount(0);
  await expect(loadMoreButton).toBeEnabled();
  await loadMoreButton.click();
  await expect(panel.getByText('sub-2', { exact: false }).first()).toBeVisible();
});

test('keeps loaded notifications visible and gates pagination retry while another page is loading', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-21T12:00:00.000Z') });
  await installBaselineRoutes(page);

  let failPage2 = true;
  let page2RequestCount = 0;
  let page2Gate: Promise<void> | null = null;
  let unblockPage2: (() => void) | null = null;
  const notification = {
    id: 'notification-1',
    eventCode: 'REQUEST_SUBMITTED',
    title: 'Current inbox item',
    message: 'A resource request needs your attention.',
    createdAt: '2026-11-20T12:00:00.000Z',
    readAt: null,
    etag: '"notification-1"',
    target: {
      type: 'REQUEST',
      requestId: 'request-1',
      available: true,
      destination: 'REQUEST_DETAIL',
    },
  };

  await page.route(`${apiRoot}/notifications**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('cursor') === 'notification-page-2') {
      page2RequestCount += 1;
      if (page2Gate) await page2Gate;
      if (failPage2) {
        await route.fulfill(unavailableProblem());
        return;
      }
      await route.fulfill({ json: { items: [{ ...notification, id: 'notification-2', title: 'Next inbox item' }], page: emptyPage } });
      return;
    }
    await route.fulfill({ json: { items: [notification], page: { nextCursor: 'notification-page-2', limit: 50 } } });
  });

  await page.goto('/resource-allocation/');
  await page.getByRole('button', { name: 'Notifications (1 unread)' }).click();
  const inbox = page.getByRole('region', { name: 'Notifications' });
  const loadMore = inbox.locator('.notifications-menu__load-more');
  await expect(inbox.getByText('Current inbox item')).toBeVisible();

  await loadMore.click();
  await expect(inbox.getByText('More notifications could not be loaded.')).toBeVisible();
  await expect(inbox.getByText('Current inbox item')).toBeVisible();
  await expect(inbox.getByText('Updates could not be checked. Your current notifications stay visible until you retry.')).toHaveCount(0);

  await expect(loadMore).toBeEnabled();
  failPage2 = false;
  page2Gate = new Promise<void>((resolve) => { unblockPage2 = resolve; });
  await loadMore.click();
  await expect.poll(() => page2RequestCount).toBe(2);
  await expect(loadMore).toBeDisabled();
  unblockPage2?.();

  await expect(inbox.getByText('Next inbox item')).toBeVisible();
});
