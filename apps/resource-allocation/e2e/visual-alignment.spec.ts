import { expect, test } from '@playwright/test';

const apiRoot = '**/api/resource-allocation/v1';
const admin = {
  id: 'person-admin',
  localUserId: 'profile-admin',
  displayName: 'Casey Admin',
  role: 'ALLOCATION_ADMIN',
  groupId: 'group-a',
  coveredGroupIds: [],
};
const requestId = '30000000-0000-4000-8000-000000000084';
const allocationId = '30000000-0000-4000-8000-000000000085';
const initiative = { id: 'initiative-a', code: 'ITDM-84', name: 'Platform reliability' };
const group = { id: 'group-a', name: 'Platform Engineering' };
const resourceProfile = { id: 'profile-a', name: 'API Engineering', groupId: group.id };
const requestConditions = {
  initiativeId: initiative.id,
  initiativeCode: initiative.code,
  initiativeName: initiative.name,
  category: 'EXECUTION_PROJECT',
  groupId: group.id,
  groupName: group.name,
  resourceProfileId: resourceProfile.id,
  resourceProfileName: resourceProfile.name,
  startDate: '2027-01-11',
  endDate: '2027-01-29',
  weeklyHours: 20,
  comment: 'Support the reliability rollout.',
};
const requestRecord = {
  id: requestId,
  requesterSnapshot: { personId: admin.id, displayName: admin.displayName, role: admin.role },
  requestedConditions: requestConditions,
  decisionState: 'WAITING_FOR_PRESENTATION',
  receivedAt: '2026-11-20T15:00:00.000Z',
  stageEnteredAt: '2026-11-20T15:00:00.000Z',
  expirationDueAt: '2026-12-11T15:00:00.000Z',
  dueAt: null,
  availableActions: [],
  version: 1,
};
const queueRecord = {
  id: requestId,
  requester: { personId: admin.id, displayName: admin.displayName, role: admin.role },
  requestedConditions: requestConditions,
  decisionState: 'WAITING_FOR_PRESENTATION',
  receivedAt: '2026-11-20T15:00:00.000Z',
  stageEnteredAt: '2026-11-20T15:00:00.000Z',
  dueAt: '2026-12-11T15:00:00.000Z',
  nextResponsible: { role: 'ALLOCATION_ADMIN' },
  availableActions: ['REFER', 'REFERENCE_CORRECTION', 'ADMINISTRATIVE_REMOVE'],
  impediments: [],
  version: 1,
};
const allocationRecord = {
  id: allocationId,
  requestId,
  person: { personId: admin.id, displayName: admin.displayName },
  group,
  initiative,
  resourceProfile,
  startDate: '2026-11-18',
  endDate: '2026-12-12',
  approvedPeriod: { startDate: '2026-11-18', endDate: '2026-12-20' },
  weeklyHours: 20,
  state: 'IN_PROGRESS',
  approvedAt: '2026-11-17T14:30:00.000Z',
  version: 7,
  availableActions: ['SUSPEND'],
};

async function openAdminWorkspace(page: import('@playwright/test').Page, profile = admin) {
  await page.route(`${apiRoot}/access`, async (route) => route.fulfill({ json: { person: profile } }));
  await page.route(`${apiRoot}/groups**`, async (route) => route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 100 } } }));
  await page.route(`${apiRoot}/resource-profiles**`, async (route) => route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 100 } } }));
  await page.route(`${apiRoot}/initiatives**`, async (route) => route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 100 } } }));
  await page.route(`${apiRoot}/submissions**`, async (route) => route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 50 } } }));
  await page.route(`${apiRoot}/requests**`, async (route) => route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 50 } } }));
  await page.route(`${apiRoot}/request-queues/**`, async (route) => route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 50 } } }));
  await page.route(`${apiRoot}/notifications**`, async (route) => route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 50 } } }));
  await page.route(`${apiRoot}/allocations**`, async (route) => route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 50 } } }));
  await page.route(`${apiRoot}/allocation-load**`, async (route) => route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 50 } } }));
  await page.route(`${apiRoot}/admin/**`, async (route) => route.fulfill({
    json: { items: [], page: { nextCursor: null, limit: 50 } },
  }));
  await page.addInitScript((localUserId) => {
    window.localStorage.setItem('pmo-hub.local-user-id', localUserId);
  }, profile.localUserId);
}

async function addVisualDataRoutes(page: import('@playwright/test').Page) {
  const emptyPage = { nextCursor: null, limit: 50 };
  await page.route(`${apiRoot}/groups**`, async (route) => route.fulfill({ json: { items: [group], page: emptyPage } }));
  await page.route(`${apiRoot}/resource-profiles**`, async (route) => route.fulfill({ json: { items: [resourceProfile], page: emptyPage } }));
  await page.route(`${apiRoot}/initiatives**`, async (route) => route.fulfill({ json: { items: [initiative], page: emptyPage } }));
  await page.route(`${apiRoot}/requests**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path.endsWith('/requests')) {
      await route.fulfill({ json: { items: [requestRecord], page: emptyPage } });
      return;
    }
    if (request.method() === 'GET' && path.endsWith(`/requests/${requestId}`)) {
      await route.fulfill({ headers: { etag: '"1"' }, json: requestRecord });
      return;
    }
    await route.fallback();
  });
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: { items: path.endsWith('/presentation') ? [queueRecord] : [], page: emptyPage } });
  });
  await page.route(`${apiRoot}/allocations**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path.endsWith(`/allocations/${allocationId}/history`)) {
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    if (request.method() === 'GET' && path.endsWith(`/allocations/${allocationId}`)) {
      await route.fulfill({ headers: { etag: '"7"' }, json: allocationRecord });
      return;
    }
    if (request.method() === 'GET' && path.endsWith('/allocations')) {
      await route.fulfill({ json: { items: [allocationRecord], page: emptyPage } });
      return;
    }
    await route.fallback();
  });
  await page.route(`${apiRoot}/allocation-load**`, async (route) => route.fulfill({
    json: {
      date: '2026-11-21',
      items: [{
        person: { personId: admin.id, displayName: admin.displayName },
        weeklyHoursByState: { NOT_STARTED: 0, IN_PROGRESS: 20, SUSPENDED: 0, ALLOCATED_WITHOUT_ACTION: 5, DONE: 0, CANCELED: 0 },
        totalWeeklyHours: 25,
      }],
      page: emptyPage,
    },
  }));
  await page.route(`${apiRoot}/notifications**`, async (route) => route.fulfill({
    json: {
      items: [{
        id: '30000000-0000-4000-8000-000000000086',
        eventCode: 'ALLOCATION_STARTED',
        title: 'Capacity planning allocation started',
        message: 'The capacity planning allocation has started for Platform Engineering.',
        createdAt: '2026-11-20T12:00:00.000Z',
        readAt: null,
        etag: '"notice-1"',
        target: { type: 'REQUEST', requestId, allocationId, available: true, destination: 'ALLOCATION_DETAIL' },
      }],
      page: emptyPage,
    },
  }));
}

const visualEvidenceDirectory = process.env.VISUAL_EVIDENCE_DIR;

async function capture(page: import('@playwright/test').Page, name: string, { resetScroll = true } = {}) {
  if (!visualEvidenceDirectory) return;
  if (resetScroll) {
    const panel = page.locator('.workspace-panel');
    if (await panel.count()) {
      await panel.evaluate((element) => new Promise<void>((resolve) => {
        element.scrollTop = 0;
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.screenshot({ path: `${visualEvidenceDirectory}/${name}.png`, animations: 'disabled' });
}

function contrastRatio(foreground: string, background: string) {
  const luminance = (color: string) => {
    const [red, green, blue] = color.match(/\d+/g)!.slice(0, 3).map(Number);
    const linear = (value: number) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

test('uses the Hub action color and full-width workspace in Administration', async ({ page }) => {
  await openAdminWorkspace(page);

  await page.goto('/resource-allocation/?page=administration');
  const addPerson = page.getByRole('button', { name: 'Add person' });
  await expect(addPerson).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await addPerson.focus();

  const presentation = await addPerson.evaluate((button) => {
    const main = document.querySelector<HTMLElement>('.workspace-panel');
    if (!main) throw new Error('The module workspace panel is missing.');
    const buttonStyle = getComputedStyle(button);
    const mainBounds = main.getBoundingClientRect();
    return {
      actionBackground: buttonStyle.backgroundColor,
      fontFamily: getComputedStyle(document.documentElement).fontFamily,
      interFontLoaded: document.fonts.check('16px Inter'),
      focusOutlineStyle: buttonStyle.outlineStyle,
      focusOutlineWidth: buttonStyle.outlineWidth,
      mainWidth: mainBounds.width,
      viewportWidth: document.documentElement.clientWidth,
    };
  });

  expect(presentation.actionBackground).toBe('rgb(24, 104, 219)');
  expect(presentation.fontFamily).toContain('Inter');
  expect(presentation.interFontLoaded).toBe(true);
  expect(presentation.focusOutlineStyle).not.toBe('none');
  expect(Number.parseFloat(presentation.focusOutlineWidth)).toBeGreaterThanOrEqual(2);
  expect(presentation.mainWidth).toBeGreaterThan(presentation.viewportWidth / 2);
});

test('keeps all six areas readable in both themes and reflows for keyboard and narrow viewports', async ({ page }) => {
  await openAdminWorkspace(page);
  await addVisualDataRoutes(page);
  await page.goto('/resource-allocation/?page=requests');

  const navigation = page.getByRole('navigation', { name: 'Tech Resource Allocation' });
  const areas = [
    { page: 'requests', label: 'Requests', heading: 'My requests' },
    { page: 'new-request', label: 'New request', heading: 'New request batch' },
    { page: 'request-queues', label: 'Request queues', heading: 'Request queues' },
    { page: 'allocations', label: 'Allocations and capacity', heading: 'Allocations and capacity' },
    { page: 'notifications', label: 'Notifications', heading: 'Notifications' },
    { page: 'administration', label: 'Administration', heading: 'Administration' },
  ];

  for (const theme of ['light', 'dark'] as const) {
    if (theme === 'dark') {
      await page.getByRole('button', { name: 'Casey Admin' }).click();
      await page.getByRole('button', { name: 'Dark', exact: true }).click();
      await page.getByRole('button', { name: 'Casey Admin' }).click();
    }
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    for (const area of areas) {
      await navigation.getByRole('link', { name: area.label, exact: true }).click();
      await expect(page.getByRole('heading', { name: area.heading, exact: true })).toBeVisible();
      await expect(navigation.getByRole('link', { name: area.label, exact: true })).toHaveAttribute('aria-current', 'page');

      if (area.page === 'requests') {
        await expect(page.getByRole('button', { name: /ITDM-84 · Platform reliability/ })).toBeVisible();
      }
      if (area.page === 'request-queues') {
        await expect(page.locator(`#resource-request-${requestId}`)).toBeVisible();
      }
      if (area.page === 'allocations') {
        await expect(page.getByRole('button', { name: 'View allocation ITDM-84' })).toBeVisible();
        const optionalFilter = page.locator('.allocation-filters input[placeholder="Optional"]').first();
        const placeholderColors = await optionalFilter.evaluate((input) => ({
          foreground: getComputedStyle(input, '::placeholder').color,
          background: getComputedStyle(input).backgroundColor,
        }));
        expect(contrastRatio(placeholderColors.foreground, placeholderColors.background)).toBeGreaterThanOrEqual(4.5);
      }
      if (area.page === 'notifications') {
        await expect(page.getByRole('heading', { name: 'Capacity planning allocation started' })).toBeVisible();
      }

      const layout = await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('.workspace-panel');
        if (!panel) throw new Error('The module workspace panel is missing.');
        return {
          bodyWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth,
          panelWidth: panel.getBoundingClientRect().width,
          panelBackground: getComputedStyle(panel).backgroundColor,
        };
      });
      expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.panelWidth).toBeGreaterThan(layout.viewportWidth * 0.7);
      expect(layout.panelBackground).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(28, 43, 66)');
      await capture(page, `desktop-${theme}-${area.page}`);

      if (area.page === 'requests') {
        await page.getByRole('button', { name: /ITDM-84 · Platform reliability/ }).click();
        const requestDetail = page.getByRole('region', { name: 'ITDM-84' });
        await expect(requestDetail).toBeVisible();
        await requestDetail.scrollIntoViewIfNeeded();
        await capture(page, `desktop-${theme}-requests-detail`, { resetScroll: false });
      }
      if (area.page === 'new-request') {
        const weeklyHours = page.getByLabel('Weekly hours for line 1');
        const placeholderColors = await weeklyHours.evaluate((input) => ({
          foreground: getComputedStyle(input, '::placeholder').color,
          background: getComputedStyle(input).backgroundColor,
        }));
        expect(contrastRatio(placeholderColors.foreground, placeholderColors.background)).toBeGreaterThanOrEqual(4.5);
        await page.getByRole('combobox', { name: 'Initiative', exact: true }).selectOption(initiative.id);
        await page.getByLabel('Category').selectOption('EXECUTION_PROJECT');
        await page.getByLabel('Group for line 1').selectOption(group.id);
        await page.getByLabel('Resource profile for line 1').selectOption(resourceProfile.id);
        await page.getByLabel('Start date for line 1').fill('2027-01-11');
        await page.getByLabel('End date for line 1').fill('2027-01-19');
        await page.getByLabel('Weekly hours for line 1').fill('8');
        await page.getByLabel(/Comment for line 1/).fill('Support the platform reliability rollout.');
        await page.getByRole('button', { name: 'Add request line' }).click();
        await page.getByRole('button', { name: 'Review submission' }).click();
        await expect(page.getByRole('heading', { name: 'Review your requests' })).toBeVisible();
        await capture(page, `desktop-${theme}-new-request-review`);
        await page.getByRole('button', { name: 'Edit requests' }).click();
        const editor = page.getByRole('form', { name: 'Request line editor' });
        const cards = page.getByRole('region', { name: 'Request lines' });
        const desktopViewport = page.viewportSize()!;
        await page.setViewportSize({ ...desktopViewport, height: 1200 });
        await capture(page, `desktop-${theme}-new-request-filled`);
        const editLine = cards.getByRole('button', { name: 'Edit line 1' });
        await editLine.focus();
        await page.keyboard.press('Enter');
        await expect(editor.getByLabel('Group for line 1')).toBeFocused();
        await expect(editor.getByLabel('Resource profile for line 1')).toHaveValue(resourceProfile.id);
        const desktopEditor = (await editor.boundingBox())!;
        const desktopCards = (await cards.boundingBox())!;
        expect(desktopCards.x).toBeGreaterThan(desktopEditor.x + desktopEditor.width);
        await capture(page, `desktop-${theme}-new-request-editing`);

        for (const width of [640, 390]) {
          await page.setViewportSize({ width, height: 900 });
          const narrowEditor = (await editor.boundingBox())!;
          const narrowCards = (await cards.boundingBox())!;
          expect(narrowCards.y).toBeGreaterThan(narrowEditor.y + narrowEditor.height);
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
          await capture(page, `narrow-${width}-${theme}-new-request`);
        }
        await page.setViewportSize(desktopViewport);

        const discardPrompt = page.waitForEvent('dialog');
        const navigationClick = navigation.getByRole('link', { name: 'Request queues', exact: true }).click();
        const discardDialog = await discardPrompt;
        await discardDialog.accept();
        await navigationClick;
      }
      if (area.page === 'allocations') {
        await page.getByRole('button', { name: 'View allocation ITDM-84' }).click();
        const allocationDetails = page.getByRole('region', { name: 'Allocation details' });
        await expect(allocationDetails).toBeVisible();
        await allocationDetails.scrollIntoViewIfNeeded();
        await capture(page, `desktop-${theme}-allocations-detail`, { resetScroll: false });
      }

      if (area.page === 'administration') {
        const addPerson = page.getByRole('button', { name: 'Add person' });
        await addPerson.click();
        await expect(page.getByRole('textbox', { name: 'Display name' })).toBeVisible();
        await page.getByLabel('Local user ID').fill(`visual-review-${theme}`);
        await page.getByLabel('Display name').fill('Avery Engineer');
        await page.getByLabel('Email').fill('avery.engineer@example.com');
        await page.getByLabel('Role').selectOption('ALLOCATION_USER');
        await page.getByLabel('Display name').scrollIntoViewIfNeeded();
        await capture(page, `desktop-${theme}-administration-form-filled`, { resetScroll: false });
        const discardPrompt = page.waitForEvent('dialog');
        const closeForm = page.getByRole('button', { name: 'Close form' }).click();
        const discardDialog = await discardPrompt;
        await discardDialog.accept();
        await closeForm;
      }
    }

    await navigation.getByRole('link', { name: 'Administration', exact: true }).click();
    const addPerson = page.getByRole('button', { name: 'Add person' });
    const actionColors = await addPerson.evaluate((button) => {
      const style = getComputedStyle(button);
      return { foreground: style.color, background: style.backgroundColor };
    });
    expect(contrastRatio(actionColors.foreground, actionColors.background)).toBeGreaterThanOrEqual(4.5);

    await navigation.getByRole('link', { name: 'Requests', exact: true }).click();
    const focusLink = navigation.getByRole('link', { name: 'Requests', exact: true });
    await focusLink.focus();
    const focusOutlineWidth = await focusLink.evaluate((element) => getComputedStyle(element).outlineWidth);
    expect(Number.parseFloat(focusOutlineWidth)).toBeGreaterThanOrEqual(2);

    if (theme === 'dark') {
      const linkColors = await focusLink.evaluate((link) => {
        const style = getComputedStyle(link);
        return { foreground: style.color, background: style.backgroundColor };
      });
      expect(contrastRatio(linkColors.foreground, linkColors.background)).toBeGreaterThanOrEqual(4.5);
    }
  }

  await page.setViewportSize({ width: 640, height: 900 });
  const menu = page.getByRole('button', { name: 'Module menu' });
  await expect(menu).toBeVisible();
  await menu.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(navigation.getByRole('link', { name: 'Requests', exact: true })).toBeVisible();
  await capture(page, 'narrow-dark-menu-open');
  await navigation.getByRole('link', { name: 'Requests', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'My requests', exact: true })).toBeVisible();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');

  const narrowLayout = await page.evaluate(() => ({
    bodyWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    panelWidth: document.querySelector<HTMLElement>('.workspace-panel')?.getBoundingClientRect().width ?? 0,
  }));
  expect(narrowLayout.bodyWidth).toBeLessThanOrEqual(narrowLayout.viewportWidth);
  expect(narrowLayout.panelWidth).toBeGreaterThan(0);
  await capture(page, 'zoom-200-equivalent-dark-requests');

  await page.setViewportSize({ width: 390, height: 844 });
  await menu.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await capture(page, 'mobile-390-dark-menu-open');
  await navigation.getByRole('link', { name: 'Requests', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  const mobileLayout = await page.evaluate(() => ({
    bodyWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    panelWidth: document.querySelector<HTMLElement>('.workspace-panel')?.getBoundingClientRect().width ?? 0,
  }));
  expect(mobileLayout.bodyWidth).toBeLessThanOrEqual(mobileLayout.viewportWidth);
  expect(mobileLayout.panelWidth).toBeGreaterThan(0);
  await capture(page, 'mobile-390-dark-requests');
});

test('shows loading, empty, and retryable error states in the selected area', async ({ page }) => {
  await openAdminWorkspace(page);
  let releaseNotifications = () => {};
  const pendingNotifications = new Promise<void>((resolve) => { releaseNotifications = resolve; });
  await page.route(`${apiRoot}/notifications**`, async (route) => {
    await pendingNotifications;
    await route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 50 } } });
  });
  await page.goto('/resource-allocation/?page=notifications');
  await expect(page.getByRole('status')).toContainText('Loading notifications');
  await capture(page, 'state-loading-notifications-light');
  releaseNotifications();
  await expect(page.getByText('No notifications match this filter.')).toBeVisible();
  await capture(page, 'state-empty-notifications-light');

  await page.getByRole('button', { name: 'Casey Admin' }).click();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.getByRole('button', { name: 'Casey Admin' }).click();
  await page.route(`${apiRoot}/requests**`, async (route) => route.fulfill({
    status: 503,
    contentType: 'application/problem+json',
    json: { status: 503, code: 'SERVICE_UNAVAILABLE', detail: 'Requests are temporarily unavailable.' },
  }));
  await page.getByRole('navigation', { name: 'Tech Resource Allocation' }).getByRole('link', { name: 'Requests', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('request list could not be refreshed');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await capture(page, 'state-error-requests-dark');
});

test('keeps conflicts and denied destinations readable before protected content mounts', async ({ page }) => {
  await openAdminWorkspace(page);
  await page.route(`${apiRoot}/admin/**`, async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        json: { status: 409, code: 'RESOURCE_CONFLICT', detail: 'This local user ID already exists.' },
      });
      return;
    }
    await route.fulfill({ json: { items: [], page: { nextCursor: null, limit: 50 } } });
  });
  await page.goto('/resource-allocation/?page=administration');
  await page.getByRole('button', { name: 'Casey Admin' }).click();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.getByRole('button', { name: 'Casey Admin' }).click();
  await page.getByRole('button', { name: 'Add person' }).click();
  await page.getByLabel('Local user ID').fill('duplicate-local-user');
  await page.getByLabel('Display name').fill('Avery Engineer');
  await page.getByLabel('Email').fill('avery.engineer@example.com');
  await page.getByLabel('Role').selectOption('ALLOCATION_USER');
  await page.getByRole('button', { name: 'Save person' }).click();
  await expect(page.getByRole('alert')).toContainText('This local user ID already exists.');
  await capture(page, 'state-conflict-administration-dark');
});

test('denies direct Administration links before protected content mounts', async ({ page }) => {
  const user = {
    id: 'person-user',
    localUserId: 'profile-user',
    displayName: 'Taylor User',
    role: 'ALLOCATION_USER',
    coveredGroupIds: [],
  };
  await openAdminWorkspace(page, user);
  await page.goto('/resource-allocation/?page=administration');
  await expect(page.getByRole('alert')).toContainText('Resource profile administration is only available to Admins and in-scope resource leaders.');
  await expect(page.getByRole('heading', { name: 'Administration', exact: true })).toHaveCount(0);
  await capture(page, 'state-access-denied-administration-light');
});
