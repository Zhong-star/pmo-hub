import { expect, test, type Page } from '@playwright/test';

const apiRoot = '**/api/resource-allocation/v1';
const profileStorageKey = 'pmo-hub.local-user-id';
const emptyPage = { nextCursor: null, limit: 50 };

const admin = {
  id: 'admin-id',
  localUserId: 'profile-admin',
  displayName: 'Morgan Admin',
  role: 'ALLOCATION_ADMIN',
  groupId: 'group-a',
  coveredGroupIds: [],
};

const moderator = {
  id: 'moderator-id',
  localUserId: 'profile-moderator',
  displayName: 'Taylor Moderator',
  role: 'ALLOCATION_MODERATOR',
  groupId: 'group-a',
  coveredGroupIds: [],
};

const groups = [
  { id: 'group-a', name: 'Platform Engineering' },
  { id: 'group-b', name: 'Data Engineering' },
];
const profiles = [
  { id: 'profile-a', name: 'API Engineering', groupId: 'group-a' },
  { id: 'profile-c', name: 'Platform Integration', groupId: 'group-a' },
  { id: 'profile-b', name: 'Data Platform', groupId: 'group-b' },
];
const initiatives = [
  { id: 'initiative-a', code: 'ITDM-62', name: 'Resource allocation' },
  { id: 'initiative-b', code: 'ITDM-63', name: 'Data modernization' },
];

function requestItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'request-a',
    requester: { personId: 'requester-id', displayName: 'Jordan Requester', role: 'ALLOCATION_USER' },
    requestedConditions: {
      initiativeId: 'initiative-a',
      initiativeCode: 'ITDM-62',
      initiativeName: 'Resource allocation',
      groupId: 'group-a',
      groupName: 'Platform Engineering',
      resourceProfileId: 'profile-a',
      resourceProfileName: 'API Engineering',
      startDate: '2027-01-11',
      endDate: '2027-01-29',
      weeklyHours: 20,
      comment: 'Support the approved work.',
    },
    decisionState: 'WAITING_FOR_PRESENTATION',
    receivedAt: '2026-11-20T15:00:00.000Z',
    stageEnteredAt: '2026-11-20T15:00:00.000Z',
    dueAt: '2026-12-11T15:00:00.000Z',
    nextResponsible: { role: 'ALLOCATION_ADMIN' },
    availableActions: ['REFER', 'REFERENCE_CORRECTION', 'ADMINISTRATIVE_REMOVE'],
    impediments: [],
    version: 1,
    ...overrides,
  };
}

async function installCommonRoutes(page: Page, profileId: string, person: typeof admin | typeof moderator) {
  await page.route(`${apiRoot}/access`, async (route) => route.fulfill({ json: { person } }));
  for (const collection of ['groups', 'resource-profiles', 'initiatives']) {
    await page.route(`${apiRoot}/${collection}**`, async (route) => {
      const items = collection === 'groups' ? groups : collection === 'resource-profiles' ? profiles : initiatives;
      await route.fulfill({ json: { items, page: emptyPage } });
    });
  }
  await page.route(`${apiRoot}/submissions**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/notifications**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(/\/api\/resource-allocation\/v1\/requests(?:\?|$)/, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.route(`${apiRoot}/admin/**`, async (route) => route.fulfill({ json: { items: [], page: emptyPage } }));
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
    key: profileStorageKey,
    value: profileId,
  });
}

test('moves between request queues with the tablist arrow keys', async ({ page }) => {
  await installCommonRoutes(page, admin.localUserId, admin);
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    await route.fulfill({ json: { items: [], page: emptyPage } });
  });
  await page.goto('/resource-allocation/');

  const presentation = page.getByRole('tab', { name: 'Presentation queue' });
  const teamDecision = page.getByRole('tab', { name: 'Group decision queue' });
  await expect(presentation).toHaveAttribute('aria-selected', 'true');
  await presentation.focus();
  await page.keyboard.press('ArrowRight');

  await expect(teamDecision).toBeFocused();
  await expect(teamDecision).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/queue=team-decision/);
});

test('corrects eligible references, preserves the deadline, and refers the request with the current ETag', async ({ page }) => {
  await installCommonRoutes(page, admin.localUserId, admin);
  let queueItem = requestItem();
  const posted: Array<{ path: string; body: Record<string, string>; headers: Record<string, string> }> = [];
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET') {
      const items = path.endsWith('/presentation') && queueItem.decisionState === 'WAITING_FOR_PRESENTATION'
        ? [queueItem]
        : path.endsWith('/team-decision') && queueItem.decisionState === 'PENDING_TEAM_DECISION' ? [queueItem] : [];
      await route.fulfill({ json: { items, page: emptyPage } });
      return;
    }
  });
  await page.route(`${apiRoot}/requests/**`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON() as Record<string, string>;
    const headers = route.request().headers();
    posted.push({ path, body, headers });
    if (path.endsWith('/reference-corrections')) {
      queueItem = requestItem({
        version: 2,
        requestedConditions: {
          ...queueItem.requestedConditions,
          initiativeId: body.initiativeId ?? 'initiative-a',
          initiativeCode: body.initiativeId === 'initiative-b' ? 'ITDM-63' : 'ITDM-62',
          initiativeName: body.initiativeId === 'initiative-b' ? 'Data modernization' : 'Resource allocation',
          groupId: body.groupId ?? 'group-a',
          groupName: body.groupId === 'group-b' ? 'Data Engineering' : 'Platform Engineering',
          resourceProfileId: body.resourceProfileId ?? 'profile-a',
          resourceProfileName: body.resourceProfileId === 'profile-b' ? 'Data Platform' : 'API Engineering',
        },
      });
      await route.fulfill({ json: queueItem });
      return;
    }
    if (path.endsWith('/referrals')) {
      queueItem = requestItem({
        requestedConditions: queueItem.requestedConditions,
        decisionState: 'PENDING_TEAM_DECISION',
        dueAt: null,
        version: 3,
        availableActions: [],
      });
      await route.fulfill({ json: queueItem });
      return;
    }
    await route.fulfill({ status: 404, json: { status: 404, code: 'RESOURCE_NOT_FOUND' } });
  });

  await page.goto('/resource-allocation/');
  await expect(page.getByRole('heading', { name: 'Request queues' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ITDM-62 — Resource allocation' })).toBeVisible();
  await expect(page.getByText('Presentation deadline')).toBeVisible();
  await page.getByRole('button', { name: 'Correct references' }).click();
  const correctionForm = page.getByRole('form', { name: 'Correct references for request request-a' });
  await correctionForm.getByLabel('ITDM').selectOption('initiative-b');
  await correctionForm.getByLabel('Group').selectOption('group-b');
  await correctionForm.getByLabel('Resource profile').selectOption('profile-b');
  await correctionForm.getByLabel('Reason').fill('The active data group owns this work.');
  await correctionForm.getByRole('button', { name: 'Save reference correction' }).click();

  await expect(page.getByRole('heading', { name: 'ITDM-63 — Data modernization' })).toBeVisible();
  await expect(page.getByText('The active data group owns this work.')).toHaveCount(0);
  expect(posted[0].path).toContain('/requests/request-a/reference-corrections');
  expect(posted[0].headers['if-match']).toBe('"1"');
  expect(posted[0].headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
  expect(posted[0].body).toMatchObject({ initiativeId: 'initiative-b', groupId: 'group-b', resourceProfileId: 'profile-b' });

  await expect(page.getByRole('button', { name: 'Refer to group decision' })).toBeEnabled();
  await page.getByRole('button', { name: 'Refer to group decision' }).click();
  await expect.poll(() => posted.length).toBe(2);
  expect(posted[1].path).toContain('/requests/request-a/referrals');
  expect(posted[1].headers['if-match']).toBe('"2"');
  await page.getByRole('tab', { name: 'Group decision queue' }).click();
  await expect(page.getByRole('heading', { name: 'ITDM-63 — Data modernization' })).toBeVisible();
  await expect(page.getByText('Waiting for group decision')).toBeVisible();
});

test('shows revalidation origin, blocker, owner, and only server-authorized actions', async ({ page }) => {
  await installCommonRoutes(page, moderator.localUserId, moderator);
  const queueItem = requestItem({
    decisionState: 'REQUIRES_REVALIDATION',
    originState: 'APPROVED_WITH_CHANGES',
    dueAt: null,
    impediments: ['PERSON_INACTIVE'],
    nextResponsible: [{ personId: moderator.id, displayName: moderator.displayName, role: moderator.role }],
    availableActions: ['APPROVE'],
    approvedConditions: {
      personId: 'person-inactive',
      personName: 'Alex Resource',
      resourceProfileId: 'profile-a',
      resourceProfileName: 'API Engineering',
      groupId: 'group-a',
      groupName: 'Platform Engineering',
      initiativeId: 'initiative-a',
      initiativeCode: 'ITDM-62',
      initiativeName: 'Resource allocation',
      startDate: '2027-01-11',
      endDate: '2027-01-29',
      weeklyHours: 20,
      explanation: 'The original proposal can no longer be used.',
    },
  });
  let requestedPath = '';
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    requestedPath = new URL(route.request().url()).pathname;
    await route.fulfill({
      json: { items: requestedPath.endsWith('/revalidation') ? [queueItem] : [], page: emptyPage },
    });
  });

  await page.goto('/resource-allocation/?queue=revalidation');

  const card = page.getByRole('article', { name: /ITDM-62/ });
  await expect(page.getByRole('tab', { name: 'Revalidation queue' })).toHaveAttribute('aria-selected', 'true');
  await expect(card.getByText('Origin: Approved with changes')).toBeVisible();
  await expect(card.getByText('The proposed person is inactive.')).toBeVisible();
  await expect(card.getByText('Taylor Moderator (MODERATOR)')).toBeVisible();
  await expect(card.getByText('The original proposal can no longer be used.')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Approve request' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Deny request' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Refer to group decision' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Correct references' })).toHaveCount(0);
  expect(requestedPath).toContain('/request-queues/revalidation');
});

test('applies group filters to the revalidation queue and keeps them in the deep link', async ({ page }) => {
  await installCommonRoutes(page, admin.localUserId, admin);
  const groupFilters: Array<string | null> = [];
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/revalidation')) groupFilters.push(url.searchParams.get('groupId'));
    await route.fulfill({ json: { items: [], page: emptyPage } });
  });

  await page.goto('/resource-allocation/?queue=revalidation');
  const filters = page.getByRole('group', { name: 'Filter revalidation requests' });
  await filters.getByLabel('Group').selectOption('group-b');

  await expect.poll(() => groupFilters.at(-1)).toBe('group-b');
  await expect.poll(() => new URL(page.url()).searchParams.get('groupId')).toBe('group-b');
});

test('corrects references in revalidation with a reason, then offers the server-authorized referral', async ({ page }) => {
  await installCommonRoutes(page, admin.localUserId, admin);
  let queueItem = requestItem({
    decisionState: 'REQUIRES_REVALIDATION',
    originState: 'WAITING_FOR_PRESENTATION',
    dueAt: null,
    impediments: ['GROUP_INACTIVE'],
    availableActions: ['REFERENCE_CORRECTION', 'REFER'],
  });
  const posted: Array<{ path: string; body: Record<string, string>; headers: Record<string, string> }> = [];
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      json: { items: path.endsWith('/revalidation') ? [queueItem] : [], page: emptyPage },
    });
  });
  await page.route(`${apiRoot}/requests/**`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON() as Record<string, string>;
    const headers = route.request().headers();
    posted.push({ path, body, headers });
    if (path.endsWith('/reference-corrections')) {
      queueItem = requestItem({
        decisionState: 'REQUIRES_REVALIDATION',
        originState: 'WAITING_FOR_PRESENTATION',
        dueAt: null,
        version: 2,
        availableActions: ['REFER'],
        requestedConditions: {
          ...queueItem.requestedConditions,
          groupId: body.groupId,
          groupName: 'Data Engineering',
          resourceProfileId: body.resourceProfileId,
          resourceProfileName: 'Data Platform',
        },
      });
      await route.fulfill({ json: queueItem });
      return;
    }
    if (path.endsWith('/referrals')) {
      queueItem = requestItem({
        decisionState: 'PENDING_TEAM_DECISION',
        dueAt: null,
        version: 3,
        availableActions: [],
      });
      await route.fulfill({ json: queueItem });
      return;
    }
    await route.fulfill({ status: 404, json: { status: 404, code: 'RESOURCE_NOT_FOUND' } });
  });

  await page.goto('/resource-allocation/?queue=revalidation');
  const card = page.getByRole('article', { name: /ITDM-62/ });
  await expect(card.getByText('Origin: Waiting for presentation')).toBeVisible();
  await expect(card.getByText('The request group is inactive.')).toBeVisible();
  await card.getByRole('button', { name: 'Correct references' }).click();
  const form = card.getByRole('form', { name: 'Correct references for request request-a' });
  await form.locator('select[name="groupId"]').selectOption('group-b');
  await form.locator('select[name="resourceProfileId"]').selectOption('profile-b');
  await form.getByLabel('Reason').fill('The active data group now owns this request.');
  await form.getByRole('button', { name: 'Save reference correction' }).click();

  await expect(card.getByText('Requires revalidation')).toBeVisible();
  await expect(card.getByText('Data Engineering')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Correct references' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Refer to group decision' })).toBeEnabled();
  expect(posted[0].path).toContain('/requests/request-a/reference-corrections');
  expect(posted[0].body).toEqual({ groupId: 'group-b', resourceProfileId: 'profile-b', reason: 'The active data group now owns this request.' });
  expect(posted[0].headers['if-match']).toBe('"1"');
  expect(posted[0].headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);

  await card.getByRole('button', { name: 'Refer to group decision' }).click();
  await expect.poll(() => posted.length).toBe(2);
  expect(posted[1].path).toContain('/requests/request-a/referrals');
  expect(posted[1].headers['if-match']).toBe('"2"');
});

for (const state of ['PRE_N3', 'ESCALATION'] as const) {
  const stageLabel = state === 'PRE_N3' ? 'Pre N3' : 'Escalation';
  test(`keeps a ${stageLabel} request in its current stage when Admin corrects an ineligible reference`, async ({ page }) => {
  await installCommonRoutes(page, admin.localUserId, admin);
  let queueItem = requestItem({
    decisionState: state,
    dueAt: null,
    impediments: ['PROFILE_INACTIVE'],
    availableActions: ['REFERENCE_CORRECTION'],
  });
  let correction: { body: Record<string, string>; headers: Record<string, string> } | null = null;
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: { items: path.endsWith('/exceptions') ? [queueItem] : [], page: emptyPage } });
  });
  await page.route(`${apiRoot}/requests/**`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    correction = {
      body: route.request().postDataJSON() as Record<string, string>,
      headers: route.request().headers(),
    };
    queueItem = requestItem({ decisionState: state, dueAt: null, version: 2, availableActions: [] });
    await route.fulfill({ json: queueItem });
  });

  await page.goto(`/resource-allocation/?queue=exceptions&decisionState=${state}`);
  const card = page.getByRole('article', { name: /ITDM-62/ });
  await expect(card.getByText(state.replaceAll('_', ' '))).toBeVisible();
  await card.getByRole('button', { name: 'Correct references' }).click();
  const form = card.getByRole('form', { name: 'Correct references for request request-a' });
  await form.getByLabel('Reason').fill('The active profile should be used for review.');
  await form.getByRole('button', { name: 'Save reference correction' }).click();

  await expect(card.getByText(state.replaceAll('_', ' '))).toBeVisible();
  await expect(page.getByRole('tab', { name: stageLabel })).toHaveAttribute('aria-selected', 'true');
  await expect(card.getByRole('button', { name: 'Correct references' })).toHaveCount(0);
  expect(correction?.body).toEqual({ reason: 'The active profile should be used for review.' });
  expect(correction?.headers['if-match']).toBe('"1"');
  });
}

for (const { state, impediment, stageLabel } of [
  { state: 'PRE_N3', impediment: 'PERSON_INACTIVE', stageLabel: 'Pre N3' },
  { state: 'ESCALATION', impediment: 'PERSON_LEFT_GROUP', stageLabel: 'Escalation' },
] as const) {
  test(`replaces an ineligible proposed person during ${stageLabel} with a reasoned correction`, async ({ page }) => {
  await installCommonRoutes(page, admin.localUserId, admin);
  let queueItem = requestItem({
    decisionState: state,
    dueAt: null,
    impediments: [impediment],
    availableActions: ['REFERENCE_CORRECTION'],
  });
  let candidatePath = '';
  let correction: { path: string; body: Record<string, string>; headers: Record<string, string> } | null = null;
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: { items: path.endsWith('/exceptions') ? [queueItem] : [], page: emptyPage } });
  });
  await page.route(`${apiRoot}/requests/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path.endsWith('/approval-candidates')) {
      candidatePath = path;
      await route.fulfill({ json: {
        items: [
          { id: 'person-current-group', displayName: 'Alex Current Group', groupId: 'group-a' },
          { id: 'person-other-group', displayName: 'Jordan Other Group', groupId: 'group-b' },
        ],
        page: emptyPage,
      } });
      return;
    }
    if (request.method() === 'POST' && path.endsWith('/reference-corrections')) {
      correction = {
        path,
        body: request.postDataJSON() as Record<string, string>,
        headers: request.headers(),
      };
      queueItem = requestItem({ decisionState: state, dueAt: null, version: 2, impediments: [], availableActions: [] });
      await route.fulfill({ json: queueItem });
      return;
    }
    await route.fulfill({ json: { items: [], page: emptyPage } });
  });

  await page.goto(`/resource-allocation/?queue=exceptions&decisionState=${state}`);
  const card = page.getByRole('article', { name: /ITDM-62/ });
  await card.getByRole('button', { name: 'Correct references' }).click();
  const form = card.getByRole('form', { name: 'Correct references for request request-a' });
  await expect(form.getByLabel('Replacement person')).toBeVisible();
  await expect(form.getByLabel('Replacement person').locator('option', { hasText: 'Jordan Other Group' })).toHaveCount(0);
  await form.getByLabel('Replacement person').selectOption('person-current-group');
  await form.getByLabel('Reason').fill('Replace the inactive proposed resource.');
  await form.getByRole('button', { name: 'Save reference correction' }).click();

  await expect.poll(() => correction).not.toBeNull();
  await expect(card.getByText(state.replaceAll('_', ' '))).toBeVisible();
  expect(candidatePath).toContain('/requests/request-a/approval-candidates');
  expect(correction?.path).toContain('/requests/request-a/reference-corrections');
  expect(correction?.body).toEqual({ personId: 'person-current-group', reason: 'Replace the inactive proposed resource.' });
  expect(correction?.headers['if-match']).toBe('"1"');
  expect(correction?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
  });
}

test('allows an Admin to correct the target group first and select a replacement person afterward', async ({ page }) => {
  await installCommonRoutes(page, admin.localUserId, admin);
  let queueItem = requestItem({
    decisionState: 'ESCALATION',
    dueAt: null,
    impediments: ['GROUP_INACTIVE', 'PERSON_LEFT_GROUP'],
    availableActions: ['REFERENCE_CORRECTION'],
  });
  const candidateGroups: string[] = [];
  const corrections: Array<{ body: Record<string, string>; headers: Record<string, string> }> = [];
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: { items: path.endsWith('/exceptions') ? [queueItem] : [], page: emptyPage } });
  });
  await page.route(`${apiRoot}/requests/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path.endsWith('/approval-candidates')) {
      const currentGroupId = queueItem.requestedConditions.groupId;
      candidateGroups.push(currentGroupId);
      await route.fulfill({ json: {
        items: currentGroupId === 'group-b'
          ? [{ id: 'person-data-group', displayName: 'Alex Data Group', groupId: 'group-b' }]
          : [],
        page: emptyPage,
      } });
      return;
    }
    if (request.method() === 'POST' && path.endsWith('/reference-corrections')) {
      const body = request.postDataJSON() as Record<string, string>;
      corrections.push({ body, headers: request.headers() });
      queueItem = requestItem({
        decisionState: 'ESCALATION',
        dueAt: null,
        version: corrections.length + 1,
        impediments: corrections.length === 1 ? ['PERSON_LEFT_GROUP'] : [],
        availableActions: corrections.length === 1 ? ['REFERENCE_CORRECTION'] : [],
        requestedConditions: {
          ...queueItem.requestedConditions,
          groupId: 'group-b',
          groupName: 'Data Engineering',
          resourceProfileId: 'profile-b',
          resourceProfileName: 'Data Platform',
        },
      });
      await route.fulfill({ json: queueItem });
      return;
    }
    await route.fulfill({ json: { items: [], page: emptyPage } });
  });

  await page.goto('/resource-allocation/?queue=exceptions&decisionState=ESCALATION');
  const card = page.getByRole('article', { name: /ITDM-62/ });
  await card.getByRole('button', { name: 'Correct references' }).click();
  let form = card.getByRole('form', { name: 'Correct references for request request-a' });
  await expect(form.getByLabel('Replacement person')).toBeVisible();
  await expect(form.getByLabel('Replacement person')).toBeDisabled();
  await form.locator('select[name="groupId"]').selectOption('group-b');
  await form.locator('select[name="resourceProfileId"]').selectOption('profile-b');
  await form.getByLabel('Reason').fill('Move the request to its active group first.');
  await form.getByRole('button', { name: 'Save reference correction' }).click();
  await expect.poll(() => corrections.length).toBe(1);
  await expect(card.getByText('Data Engineering')).toBeVisible();

  await card.getByRole('button', { name: 'Correct references' }).click();
  form = card.getByRole('form', { name: 'Correct references for request request-a' });
  await expect(form.getByLabel('Replacement person')).toBeEnabled();
  await expect(form.getByLabel('Replacement person').locator('option', { hasText: 'Alex Data Group' })).toHaveCount(1);
  await form.getByLabel('Replacement person').selectOption('person-data-group');
  await form.getByLabel('Reason').fill('Replace the person who left the corrected group.');
  await form.getByRole('button', { name: 'Save reference correction' }).click();

  await expect.poll(() => corrections.length).toBe(2);
  await expect(card.getByText('ESCALATION')).toBeVisible();
  expect(candidateGroups[0]).toBe('group-a');
  expect(candidateGroups.slice(1).length).toBeGreaterThan(0);
  expect(candidateGroups.slice(1).every((groupId) => groupId === 'group-b')).toBe(true);
  expect(corrections[0].body).toEqual({ groupId: 'group-b', resourceProfileId: 'profile-b', reason: 'Move the request to its active group first.' });
  expect(corrections[0].headers['if-match']).toBe('"1"');
  expect(corrections[1].body).toEqual({ personId: 'person-data-group', reason: 'Replace the person who left the corrected group.' });
  expect(corrections[1].headers['if-match']).toBe('"2"');
});

test('confirms administrative removal and displays its required reason form', async ({ page }) => {
  await installCommonRoutes(page, admin.localUserId, admin);
  let queueItem: ReturnType<typeof requestItem> | null = requestItem();
  let removal: { body?: Record<string, string>; headers?: Record<string, string> } = {};
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    if (route.request().method() === 'GET') {
      const path = new URL(route.request().url()).pathname;
      await route.fulfill({ json: { items: path.endsWith('/presentation') && queueItem ? [queueItem] : [], page: emptyPage } });
      return;
    }
  });
  await page.route(`${apiRoot}/requests/**`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    removal = { body: route.request().postDataJSON() as Record<string, string>, headers: route.request().headers() };
    queueItem = null;
    await route.fulfill({ json: { requestId: 'request-a', action: 'ADMIN_REMOVED', removedAt: '2026-11-21T15:00:00.000Z' } });
  });

  await page.goto('/resource-allocation/');
  await page.getByRole('button', { name: 'Remove request' }).click();
  await page.getByLabel('Reason').fill('The requester asked Admin to remove the duplicate.');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Confirm removal' }).click();

  await expect(page.getByText('There are no requests in this queue.')).toBeVisible();
  expect(removal.body).toEqual({ reason: 'The requester asked Admin to remove the duplicate.' });
  expect(removal.headers?.['if-match']).toBe('"1"');
  expect(removal.headers?.['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
});

test('opens the Admin group queue and focuses the request from a notification deep link', async ({ page }) => {
  await installCommonRoutes(page, admin.localUserId, admin);
  const teamItem = requestItem({ decisionState: 'PENDING_TEAM_DECISION', dueAt: null, availableActions: [] });
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: { items: path.endsWith('/team-decision') ? [teamItem] : [], page: emptyPage } });
  });

  await page.goto('/resource-allocation/?queue=team-decision&requestId=request-a');
  await expect(page.getByRole('tab', { name: 'Group decision queue' })).toHaveAttribute('aria-selected', 'true');
  const card = page.locator('#resource-request-request-a');
  await expect(card).toBeVisible();
  await expect(card).toBeFocused();
});

test('shows only the scoped decision queue to a Moderator', async ({ page }) => {
  await installCommonRoutes(page, moderator.localUserId, moderator);
  const ownGroupRequest = requestItem({ id: 'request-own', requestedConditions: { ...requestItem().requestedConditions, groupId: 'group-a', groupName: 'Platform Engineering' }, availableActions: [] });
  await page.route(`${apiRoot}/request-queues/**`, async (route) => route.fulfill({ json: { items: [ownGroupRequest], page: emptyPage } }));

  await page.goto('/resource-allocation/');
  await expect(page.getByRole('tab', { name: 'Group decision queue' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Presentation queue' })).toHaveCount(0);
  await expect(page.getByRole('tabpanel').getByText('Platform Engineering')).toBeVisible();
});

test('reuses a pending action key after a lost result and page reload', async ({ page }) => {
  await installCommonRoutes(page, admin.localUserId, admin);
  const queueItem = requestItem();
  const actionHeaders: string[] = [];
  let attempts = 0;
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: { items: path.endsWith('/presentation') ? [queueItem] : [], page: emptyPage } });
  });
  await page.route(`${apiRoot}/requests/**`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    attempts += 1;
    actionHeaders.push(route.request().headers()['idempotency-key']);
    if (attempts === 1) {
      await route.fulfill({ status: 503, json: { title: 'Temporary service interruption.' } });
      return;
    }
    await route.fulfill({ json: requestItem({ decisionState: 'PENDING_TEAM_DECISION', dueAt: null, version: 2, availableActions: [] }) });
  });

  await page.goto('/resource-allocation/');
  await page.getByRole('button', { name: 'Refer to group decision' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Temporary service interruption.' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Refer to group decision' }).click();

  await expect.poll(() => attempts).toBe(2);
  expect(actionHeaders[0]).toMatch(/^[0-9a-f-]{36}$/i);
  expect(actionHeaders[1]).toBe(actionHeaders[0]);
});

test('keeps cached requests visible and pauses actions when a queue refresh fails', async ({ page }) => {
  await installCommonRoutes(page, admin.localUserId, admin);
  const queueItem = requestItem();
  let failNextRefresh = false;
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    if (failNextRefresh) {
      failNextRefresh = false;
      await route.fulfill({ status: 503, json: { title: 'Queue service is temporarily unavailable.' } });
      return;
    }
    await route.fulfill({ json: { items: [queueItem], page: emptyPage } });
  });

  await page.goto('/resource-allocation/');
  const queue = page.getByRole('region', { name: 'Request queues' });
  await expect(queue.getByRole('heading', { name: 'ITDM-62 — Resource allocation' })).toBeVisible();
  failNextRefresh = true;
  await queue.getByRole('button', { name: 'Refresh queue' }).click();

  await expect(queue.getByText('The queue could not be refreshed. Loaded requests remain visible, but actions are paused until you refresh.')).toBeVisible();
  await expect(queue.getByRole('heading', { name: 'ITDM-62 — Resource allocation' })).toBeVisible();
  await expect(queue.getByRole('button', { name: 'Refer to group decision' })).toBeDisabled();
  await queue.getByRole('button', { name: 'Try again' }).click();
  await expect(queue.getByText('The queue could not be refreshed. Loaded requests remain visible, but actions are paused until you refresh.')).toHaveCount(0);
  await expect(queue.getByRole('button', { name: 'Refer to group decision' })).toBeEnabled();
});

test('approves the requested period for an eligible person from the queue action', async ({ page }) => {
  await installCommonRoutes(page, moderator.localUserId, moderator);
  let queueItem: ReturnType<typeof requestItem> | null = requestItem({
    decisionState: 'PENDING_TEAM_DECISION',
    dueAt: null,
    availableActions: ['APPROVE'],
  });
  let approval: { path: string; body: Record<string, unknown>; headers: Record<string, string> } | null = null;
  let candidatePath = '';
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: { items: path.endsWith('/team-decision') && queueItem ? [queueItem] : [], page: emptyPage } });
  });
  await page.route(`${apiRoot}/requests/**`, async (route) => {
    if (route.request().method() !== 'POST') {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/approval-candidates')) {
        candidatePath = url.pathname;
        await route.fulfill({ json: { items: [{ id: 'person-a', displayName: 'Alex Resource', groupId: 'group-a' }], page: emptyPage } });
        return;
      }
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    approval = {
      path: new URL(route.request().url()).pathname,
      body: route.request().postDataJSON() as Record<string, unknown>,
      headers: route.request().headers(),
    };
    queueItem = null;
    await route.fulfill({ json: { ...requestItem(), decisionState: 'APPROVED', version: 2 } });
  });

  await page.goto('/resource-allocation/');
  const card = page.getByRole('article', { name: /ITDM-62/ });
  await expect(card.getByRole('button', { name: 'Approve request' })).toBeVisible();
  await card.getByRole('button', { name: 'Approve request' }).click();
  const form = card.getByRole('form', { name: 'Approve request request-a' });
  await expect(form.getByText('This approval keeps the requested period and weekly hours.')).toBeVisible();
  await expect(form.getByRole('region', { name: 'Requested conditions' })).toContainText('2027-01-11 to 2027-01-29');
  await expect(form.getByRole('region', { name: 'Requested conditions' })).toContainText('20 hours per week');
  await expect(form.getByRole('region', { name: 'Proposed conditions' })).toContainText('2027-01-11 to 2027-01-29');
  await expect(form.getByLabel('Approved start date')).toHaveValue('2027-01-11');
  await expect(form.getByLabel('Approved end date')).toHaveValue('2027-01-29');
  await expect(form.getByLabel('Approved weekly hours')).toHaveValue('20');
  await form.getByLabel('Eligible person').selectOption('person-a');
  await form.getByRole('button', { name: 'Approve request' }).click();

  await expect(page.getByText('There are no requests in this queue.')).toBeVisible();
  expect(candidatePath).toContain('/requests/request-a/approval-candidates');
  expect(approval?.path).toContain('/requests/request-a/approvals');
  expect(approval?.body).toEqual({ personId: 'person-a' });
  expect(approval?.headers['if-match']).toBe('"1"');
  expect(approval?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
  expect(approval?.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/i);
});

test('offers approval from the Admin presentation queue when the server allows it', async ({ page }) => {
  await installCommonRoutes(page, admin.localUserId, admin);
  let queueItem: ReturnType<typeof requestItem> | null = requestItem({ availableActions: ['APPROVE'] });
  let approvalPath = '';
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: { items: path.endsWith('/presentation') && queueItem ? [queueItem] : [], page: emptyPage } });
  });
  await page.route(`${apiRoot}/requests/**`, async (route) => {
    if (route.request().method() !== 'POST') {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/approval-candidates')) {
        await route.fulfill({ json: { items: [{ id: 'person-a', displayName: 'Alex Resource', groupId: 'group-a' }], page: emptyPage } });
        return;
      }
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    approvalPath = new URL(route.request().url()).pathname;
    queueItem = null;
    await route.fulfill({ json: { ...requestItem(), decisionState: 'APPROVED', version: 2 } });
  });

  await page.goto('/resource-allocation/');
  const card = page.getByRole('article', { name: /ITDM-62/ });
  await expect(card.getByRole('button', { name: 'Approve request' })).toBeVisible();
  await card.getByRole('button', { name: 'Approve request' }).click();
  const form = card.getByRole('form', { name: 'Approve request request-a' });
  await form.getByLabel('Eligible person').selectOption('person-a');
  await form.getByRole('button', { name: 'Approve request' }).click();

  await expect(page.getByText('There are no requests in this queue.')).toBeVisible();
  expect(approvalPath).toContain('/requests/request-a/approvals');
});

test('requires a reason when approval changes only the resource profile', async ({ page }) => {
  await installCommonRoutes(page, moderator.localUserId, moderator);
  let queueItem: ReturnType<typeof requestItem> | null = requestItem({
    decisionState: 'PENDING_TEAM_DECISION',
    dueAt: null,
    availableActions: ['APPROVE'],
  });
  let approvalBody: Record<string, unknown> | null = null;
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: { items: path.endsWith('/team-decision') && queueItem ? [queueItem] : [], page: emptyPage } });
  });
  await page.route(`${apiRoot}/requests/**`, async (route) => {
    if (route.request().method() !== 'POST') {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/approval-candidates')) {
        await route.fulfill({ json: { items: [{ id: 'person-a', displayName: 'Alex Resource', groupId: 'group-a' }], page: emptyPage } });
        return;
      }
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    approvalBody = route.request().postDataJSON() as Record<string, unknown>;
    queueItem = null;
    await route.fulfill({ json: { ...requestItem(), decisionState: 'APPROVED', version: 2 } });
  });

  await page.goto('/resource-allocation/');
  const card = page.getByRole('article', { name: /ITDM-62/ });
  await card.getByRole('button', { name: 'Approve request' }).click();
  const form = card.getByRole('form', { name: 'Approve request request-a' });
  await form.getByLabel('Eligible person').selectOption('person-a');
  await expect(form.getByLabel('Approved resource profile').locator('option', { hasText: 'Data Platform' })).toHaveCount(0);
  await form.getByLabel('Approved resource profile').selectOption('profile-c');
  await form.getByRole('button', { name: 'Approve request' }).click();
  await expect(form.getByText('Provide an explanation when correcting the resource profile.')).toBeVisible();
  await form.getByLabel('Explanation').fill('The requested profile was not the best fit.');
  await form.getByRole('button', { name: 'Approve request' }).click();

  await expect(page.getByText('There are no requests in this queue.')).toBeVisible();
  expect(approvalBody).toEqual({ personId: 'person-a', resourceProfileId: 'profile-c', explanation: 'The requested profile was not the best fit.' });
});

test('preserves approval input after a stale-version response', async ({ page }) => {
  await installCommonRoutes(page, moderator.localUserId, moderator);
  let queueItem = requestItem({ decisionState: 'PENDING_TEAM_DECISION', dueAt: null, availableActions: ['APPROVE'] });
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: { items: path.endsWith('/team-decision') ? [queueItem] : [], page: emptyPage } });
  });
  await page.route(`${apiRoot}/requests/**`, async (route) => {
    if (route.request().method() !== 'POST') {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/approval-candidates')) {
        await route.fulfill({ json: { items: [{ id: 'person-a', displayName: 'Alex Resource', groupId: 'group-a' }], page: emptyPage } });
        return;
      }
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    queueItem = { ...queueItem, version: 2 };
    await route.fulfill({ status: 412, json: { status: 412, code: 'PRECONDITION_FAILED', detail: 'The request changed.' } });
  });

  await page.goto('/resource-allocation/');
  const card = page.getByRole('article', { name: /ITDM-62/ });
  await card.getByRole('button', { name: 'Approve request' }).click();
  const form = card.getByRole('form', { name: 'Approve request request-a' });
  await form.getByLabel('Eligible person').selectOption('person-a');
  await form.getByLabel('Approved start date').fill('2027-01-15');
  await form.getByLabel('Approved end date').fill('2027-02-01');
  await form.getByLabel('Approved weekly hours').fill('24');
  await form.getByLabel('Approved resource profile').selectOption('profile-c');
  await form.getByLabel('Explanation').fill('Keep this explanation visible.');
  await form.getByRole('button', { name: 'Approve request' }).click();

  await expect(page.getByRole('alert').filter({ hasText: 'This request changed after you opened it.' })).toBeVisible();
  await expect(form.getByLabel('Eligible person')).toHaveValue('person-a');
  await expect(form.getByLabel('Approved start date')).toHaveValue('2027-01-15');
  await expect(form.getByLabel('Approved end date')).toHaveValue('2027-02-01');
  await expect(form.getByLabel('Approved weekly hours')).toHaveValue('24');
  await expect(form.getByLabel('Explanation')).toHaveValue('Keep this explanation visible.');
});

test('reuses the approval attempt key after a lost response and page reload', async ({ page }) => {
  await installCommonRoutes(page, moderator.localUserId, moderator);
  const queueItem = requestItem({ decisionState: 'PENDING_TEAM_DECISION', dueAt: null, availableActions: ['APPROVE'] });
  const keys: string[] = [];
  let attempts = 0;
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: { items: path.endsWith('/team-decision') ? [queueItem] : [], page: emptyPage } });
  });
  await page.route(`${apiRoot}/requests/**`, async (route) => {
    if (route.request().method() !== 'POST') {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/approval-candidates')) {
        await route.fulfill({ json: { items: [{ id: 'person-a', displayName: 'Alex Resource', groupId: 'group-a' }], page: emptyPage } });
        return;
      }
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    attempts += 1;
    keys.push(route.request().headers()['idempotency-key']);
    if (attempts === 1) {
      await route.fulfill({ status: 503, json: { title: 'Temporary service interruption.' } });
      return;
    }
    await route.fulfill({ json: { ...requestItem(), decisionState: 'APPROVED', version: 2 } });
  });

  await page.goto('/resource-allocation/');
  await page.getByRole('button', { name: 'Approve request' }).first().click();
  let form = page.getByRole('form', { name: 'Approve request request-a' });
  await form.getByLabel('Eligible person').selectOption('person-a');
  await form.getByRole('button', { name: 'Approve request' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Temporary service interruption.' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Approve request' }).first().click();
  form = page.getByRole('form', { name: 'Approve request request-a' });
  await form.getByLabel('Eligible person').selectOption('person-a');
  await form.getByRole('button', { name: 'Approve request' }).click();

  await expect.poll(() => attempts).toBe(2);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  expect(keys[1]).toBe(keys[0]);
});

test('requires an explanation and proposes changed dates and hours for requester acceptance', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-21T12:00:00.000Z') });
  await installCommonRoutes(page, moderator.localUserId, moderator);
  let queueItem: ReturnType<typeof requestItem> | null = requestItem({
    decisionState: 'PENDING_TEAM_DECISION',
    dueAt: null,
    availableActions: ['APPROVE'],
    requestedConditions: {
      ...requestItem().requestedConditions,
      startDate: '2026-11-18',
      endDate: '2026-11-29',
    },
  });
  let approval: { body: Record<string, unknown>; headers: Record<string, string> } | null = null;
  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: { items: path.endsWith('/team-decision') && queueItem ? [queueItem] : [], page: emptyPage } });
  });
  await page.route(`${apiRoot}/requests/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'POST') {
      if (path.endsWith('/approval-candidates')) {
        await route.fulfill({ json: { items: [{ id: 'person-a', displayName: 'Alex Resource', groupId: 'group-a' }], page: emptyPage } });
        return;
      }
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }

    approval = {
      body: route.request().postDataJSON() as Record<string, unknown>,
      headers: route.request().headers(),
    };
    queueItem = null;
    await route.fulfill({
      json: requestItem({
        decisionState: 'APPROVED_WITH_CHANGES',
        dueAt: '2026-11-24T15:00:00.000Z',
        approvedConditions: {
          personId: 'person-a',
          personName: 'Alex Resource',
          resourceProfileId: 'profile-a',
          resourceProfileName: 'API Engineering',
          groupId: 'group-a',
          groupName: 'Platform Engineering',
          initiativeId: 'initiative-a',
          initiativeCode: 'ITDM-62',
          initiativeName: 'Resource allocation',
          startDate: '2026-11-27',
          endDate: '2026-12-05',
          weeklyHours: 24,
          explanation: 'The team can start later and provide additional weekly capacity.',
        },
        allocation: null,
        availableActions: [],
        version: 2,
      }),
    });
  });

  await page.goto('/resource-allocation/');
  const card = page.getByRole('article', { name: /ITDM-62/ });
  await card.getByRole('button', { name: 'Approve request' }).click();
  const form = card.getByRole('form', { name: 'Approve request request-a' });
  await expect(form.getByRole('region', { name: 'Requested conditions' })).toContainText('2026-11-18 to 2026-11-29');
  await expect(form.getByRole('region', { name: 'Proposed conditions' })).toContainText('2026-11-18 to 2026-11-29');
  await form.getByLabel('Eligible person').selectOption('person-a');
  await form.getByLabel('Approved weekly hours').fill('24');
  await expect(form.getByLabel('Approved start date')).toHaveAttribute('min', '2026-11-24');
  await form.getByLabel('Approved start date').fill('2026-11-27');
  await form.getByLabel('Approved end date').fill('2026-12-05');
  await expect(form.getByRole('region', { name: 'Proposed conditions' })).toContainText('2026-11-27 to 2026-12-05');
  await expect(form.getByRole('region', { name: 'Proposed conditions' })).toContainText('24 hours per week');
  await expect(form.getByText('The date or hours differ from the request. An explanation is required, and no allocation is created until the requester accepts.')).toBeVisible();
  await form.getByRole('button', { name: 'Approve request' }).click();
  await expect(form.getByText('Explain the proposed date or hours changes.')).toBeVisible();
  expect(approval).toBeNull();

  await form.getByLabel('Explanation').fill('The team can start later and provide additional weekly capacity.');
  await form.getByRole('button', { name: 'Approve request' }).click();

  await expect(page.getByText('There are no requests in this queue.')).toBeVisible();
  expect(approval?.body).toEqual({
    personId: 'person-a',
    startDate: '2026-11-27',
    endDate: '2026-12-05',
    weeklyHours: 24,
    explanation: 'The team can start later and provide additional weekly capacity.',
  });
  expect(approval?.headers['if-match']).toBe('"1"');
  expect(approval?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
});
