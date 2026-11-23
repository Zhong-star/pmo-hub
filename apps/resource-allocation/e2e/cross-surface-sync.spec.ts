import { expect, test, type Page } from '@playwright/test';

const apiRoot = '**/api/resource-allocation/v1';
const profileStorageKey = 'pmo-hub.local-user-id';
const emptyPage = { nextCursor: null, limit: 50 };
const areaLabels = {
  requests: 'Requests',
  'new-request': 'New request',
  'request-queues': 'Request queues',
  allocations: 'Allocations and capacity',
  notifications: 'Notifications',
  administration: 'Administration',
} as const;

async function navigateToArea(page: Page, area: keyof typeof areaLabels) {
  const navigation = page.getByRole('navigation', { name: 'Tech Resource Allocation' });
  await navigation.getByRole('link', { name: areaLabels[area], exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]page=${area}(?:&|$)`));
}

const adminPerson = {
  id: 'person-admin',
  localUserId: 'profile-admin',
  displayName: 'Morgan Admin',
  email: 'morgan.admin@example.test',
  active: true,
  role: 'ALLOCATION_ADMIN',
  groupId: 'group-a',
  coveredGroupIds: [],
  version: 1,
};

const workerPerson = {
  id: 'person-worker',
  localUserId: 'profile-worker',
  displayName: 'Alex Engineer',
  email: 'alex.engineer@example.test',
  active: true,
  role: 'ALLOCATION_USER',
  groupId: 'group-a',
  coveredGroupIds: [],
  version: 1,
};

const groups = [{ id: 'group-a', name: 'Platform Engineering', active: true, supervisorId: null, managerId: null, version: 1 }];
const profiles = [{ id: 'profile-a', name: 'API Engineering', groupId: 'group-a', active: true, version: 1 }];
const initiatives = [{ id: 'initiative-a', code: 'ITDM-10', name: 'Cloud Modernization', active: true, version: 1 }];

function futureDate(daysAhead: number): string {
  const date = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

interface MockServerState {
  currentUser: typeof adminPerson | typeof workerPerson;
  accessCount: number;
  groupsList: Array<typeof groups[number]>;
  profilesList: Array<typeof profiles[number]>;
  initiativesList: Array<typeof initiatives[number]>;
  peopleList: Array<typeof adminPerson | typeof workerPerson>;
  queueItems: Record<string, Array<Record<string, unknown>>>;
  requestsList: Array<Record<string, unknown>>;
  allocationsList: Array<Record<string, unknown>>;
  allocationLoadItems: Array<Record<string, unknown>>;
  notificationsList: Array<Record<string, unknown>>;
  submissionsList: Array<Record<string, unknown>>;
  submissionLinesById: Record<string, Array<Record<string, unknown>>>;
  historyByRequestId: Record<string, Array<Record<string, unknown>>>;
  auditsByRequestId: Record<string, Array<Record<string, unknown>>>;
}

async function installStatefulBackend(page: Page, state: MockServerState) {
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
    key: profileStorageKey,
    value: state.currentUser.localUserId,
  });

  await page.route(`${apiRoot}/access`, async (route) => {
    state.accessCount += 1;
    await route.fulfill({ json: { person: state.currentUser } });
  });

  await page.route(`${apiRoot}/groups**`, async (route) => {
    await route.fulfill({
      json: {
        items: state.groupsList.filter((item) => item.active).map(({ id, name }) => ({ id, name })),
        page: { nextCursor: null, limit: 100 },
      },
    });
  });

  await page.route(`${apiRoot}/resource-profiles**`, async (route) => {
    await route.fulfill({
      json: {
        items: state.profilesList.filter((item) => item.active).map(({ id, name, groupId }) => ({ id, name, groupId })),
        page: { nextCursor: null, limit: 100 },
      },
    });
  });

  await page.route(`${apiRoot}/initiatives**`, async (route) => {
    await route.fulfill({
      json: {
        items: state.initiativesList.filter((item) => item.active).map(({ id, code, name }) => ({ id, code, name })),
        page: { nextCursor: null, limit: 100 },
      },
    });
  });

  await page.route(`${apiRoot}/notifications**`, async (route) => {
    await route.fulfill({ json: { items: state.notificationsList, page: emptyPage } });
  });

  await page.route(`${apiRoot}/submissions**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const linesMatch = url.pathname.match(/\/submissions\/([^/]+)\/lines$/);
    const detailMatch = url.pathname.match(/\/submissions\/([^/]+)$/);
    if (request.method() === 'GET' && linesMatch) {
      await route.fulfill({ json: { items: state.submissionLinesById[linesMatch[1]] ?? [], page: { nextCursor: null, limit: 100 } } });
      return;
    }
    if (request.method() === 'GET' && detailMatch) {
      const found = state.submissionsList.find((item) => item.id === detailMatch[1]);
      if (!found) {
        await route.fulfill({ status: 404, json: { status: 404, code: 'RESOURCE_NOT_FOUND' } });
        return;
      }
      await route.fulfill({ json: found });
      return;
    }
    if (request.method() === 'GET') {
      await route.fulfill({ json: { items: state.submissionsList, page: emptyPage } });
      return;
    }
    await route.fallback();
  });

  await page.route(`${apiRoot}/request-queues/**`, async (route) => {
    const url = new URL(route.request().url());
    const queue = url.pathname.split('/').at(-1) ?? '';
    await route.fulfill({ json: { items: state.queueItems[queue] ?? [], page: emptyPage } });
  });

  await page.route(`${apiRoot}/allocation-load**`, async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      json: {
        date: url.searchParams.get('date') ?? futureDate(0),
        items: state.allocationLoadItems,
        page: emptyPage,
      },
    });
  });

  await page.route(`${apiRoot}/allocations**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      await route.fallback();
      return;
    }
    const historyMatch = url.pathname.match(/\/allocations\/([^/]+)\/history$/);
    const detailMatch = url.pathname.match(/\/allocations\/([^/]+)$/);
    if (historyMatch) {
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    if (detailMatch) {
      const found = state.allocationsList.find((item) => item.id === detailMatch[1]);
      if (!found) {
        await route.fulfill({ status: 404, json: { status: 404, code: 'RESOURCE_NOT_FOUND' } });
        return;
      }
      await route.fulfill({ headers: { etag: `"${String(found.version)}"` }, json: found });
      return;
    }
    await route.fulfill({ json: { items: state.allocationsList, page: emptyPage } });
  });

  await page.route(`${apiRoot}/requests**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      await route.fallback();
      return;
    }
    const candidatesMatch = url.pathname.match(/\/requests\/([^/]+)\/approval-candidates$/);
    const historyMatch = url.pathname.match(/\/requests\/([^/]+)\/history$/);
    const detailMatch = url.pathname.match(/\/requests\/([^/]+)$/);
    if (candidatesMatch) {
      await route.fulfill({
        json: {
          items: state.peopleList
            .filter((person) => person.active && person.groupId === 'group-a')
            .map(({ id, displayName, groupId }) => ({ id, displayName, groupId })),
          page: emptyPage,
        },
      });
      return;
    }
    if (historyMatch) {
      await route.fulfill({ json: { items: state.historyByRequestId[historyMatch[1]] ?? [], page: emptyPage } });
      return;
    }
    if (detailMatch) {
      const found = state.requestsList.find((item) => item.id === detailMatch[1]);
      if (!found) {
        await route.fulfill({ status: 404, json: { status: 404, code: 'RESOURCE_NOT_FOUND' } });
        return;
      }
      await route.fulfill({ headers: { etag: `"${String(found.version)}"` }, json: found });
      return;
    }
    await route.fulfill({ json: { items: state.requestsList, page: emptyPage } });
  });

  await page.route(`${apiRoot}/admin/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      await route.fallback();
      return;
    }
    if (url.pathname.endsWith('/admin/people')) {
      await route.fulfill({ json: { items: state.peopleList, page: emptyPage } });
      return;
    }
    if (url.pathname.endsWith('/admin/groups')) {
      await route.fulfill({ json: { items: state.groupsList, page: emptyPage } });
      return;
    }
    if (url.pathname.endsWith('/admin/resource-profiles')) {
      await route.fulfill({ json: { items: state.profilesList, page: emptyPage } });
      return;
    }
    if (url.pathname.endsWith('/admin/initiatives')) {
      await route.fulfill({ json: { items: state.initiativesList, page: emptyPage } });
      return;
    }
    await route.fallback();
  });
}

test('updates Allocations, capacity load, Requests, and Notifications immediately without reload after queue approval and exception resolution', async ({ page }) => {
  const startDate = futureDate(5);
  const endDate = futureDate(25);
  const presentationRequestId = 'req-queue-approve';
  const exceptionRequestId = 'req-queue-exception';

  const makeRequestRecord = (id: string, decisionState: string, version: number, allocation?: Record<string, unknown>) => ({
    id,
    requesterSnapshot: { personId: workerPerson.id, displayName: workerPerson.displayName, role: 'ALLOCATION_USER' },
    requestedConditions: {
      initiativeId: initiatives[0].id,
      initiativeCode: initiatives[0].code,
      initiativeName: initiatives[0].name,
      category: 'EXECUTION_PROJECT',
      groupId: groups[0].id,
      groupName: groups[0].name,
      resourceProfileId: profiles[0].id,
      resourceProfileName: profiles[0].name,
      startDate,
      endDate,
      weeklyHours: 20,
      comment: 'Queue sync test',
    },
    decisionState,
    receivedAt: '2026-11-20T12:00:00.000Z',
    stageEnteredAt: '2026-11-20T12:00:00.000Z',
    expirationDueAt: '2026-12-11T12:00:00.000Z',
    dueAt: '2026-12-11T12:00:00.000Z',
    availableActions: [],
    ...(allocation ? { allocation } : {}),
    version,
  });

  const makeQueueRecord = (id: string, decisionState: string, availableActions: string[], version: number) => ({
    id,
    requester: { personId: workerPerson.id, displayName: workerPerson.displayName, role: 'ALLOCATION_USER' },
    requestedConditions: {
      initiativeId: initiatives[0].id,
      initiativeCode: initiatives[0].code,
      initiativeName: initiatives[0].name,
      groupId: groups[0].id,
      groupName: groups[0].name,
      resourceProfileId: profiles[0].id,
      resourceProfileName: profiles[0].name,
      startDate,
      endDate,
      weeklyHours: 20,
      comment: 'Queue sync test',
    },
    decisionState,
    receivedAt: '2026-11-20T12:00:00.000Z',
    stageEnteredAt: '2026-11-20T12:00:00.000Z',
    dueAt: decisionState === 'WAITING_FOR_PRESENTATION' ? '2026-12-11T12:00:00.000Z' : null,
    nextResponsible: { role: 'ALLOCATION_ADMIN' },
    availableActions,
    impediments: [],
    version,
  });

  const state: MockServerState = {
    currentUser: adminPerson,
    accessCount: 0,
    groupsList: [...groups],
    profilesList: [...profiles],
    initiativesList: [...initiatives],
    peopleList: [adminPerson, workerPerson],
    queueItems: {
      presentation: [makeQueueRecord(presentationRequestId, 'WAITING_FOR_PRESENTATION', ['APPROVE'], 1)],
      exceptions: [makeQueueRecord(exceptionRequestId, 'PRE_N3', ['RECORD_STRATEGY', 'RESOLVE'], 3)],
    },
    requestsList: [
      makeRequestRecord(presentationRequestId, 'WAITING_FOR_PRESENTATION', 1),
      makeRequestRecord(exceptionRequestId, 'PRE_N3', 3),
    ],
    allocationsList: [],
    allocationLoadItems: [],
    notificationsList: [],
    submissionsList: [],
    submissionLinesById: {},
    historyByRequestId: {},
    auditsByRequestId: {},
  };

  await installStatefulBackend(page, state);

  await page.route(`${apiRoot}/requests/${presentationRequestId}/approvals`, async (route) => {
    const newAllocation = {
      id: 'alloc-from-approval',
      requestId: presentationRequestId,
      person: { personId: workerPerson.id, displayName: workerPerson.displayName },
      group: { id: groups[0].id, name: groups[0].name },
      initiative: { id: initiatives[0].id, code: initiatives[0].code, name: initiatives[0].name },
      resourceProfile: { id: profiles[0].id, name: profiles[0].name },
      startDate,
      endDate,
      approvedPeriod: { startDate, endDate },
      weeklyHours: 20,
      state: 'NOT_STARTED',
      approvedAt: '2026-11-21T15:00:00.000Z',
      version: 1,
      availableActions: ['ACTIVATE'],
    };
    state.queueItems.presentation = [];
    state.allocationsList = [newAllocation];
    state.allocationLoadItems = [{
      person: { personId: workerPerson.id, displayName: workerPerson.displayName },
      weeklyHoursByState: { NOT_STARTED: 20, IN_PROGRESS: 0, SUSPENDED: 0, ALLOCATED_WITHOUT_ACTION: 0, DONE: 0, CANCELED: 0 },
      totalWeeklyHours: 20,
    }];
    state.requestsList = state.requestsList.map((item) =>
      item.id === presentationRequestId ? makeRequestRecord(presentationRequestId, 'APPROVED', 2, newAllocation) : item,
    );
    state.notificationsList = [{
      id: 'notif-approved',
      eventCode: 'REQUEST_APPROVED',
      title: 'Request approved from presentation',
      message: 'Allocation created for Alex Engineer.',
      createdAt: '2026-11-21T15:00:00.000Z',
      readAt: null,
      etag: '"n1"',
      target: { type: 'REQUEST', requestId: presentationRequestId, allocationId: newAllocation.id, available: true, destination: 'ALLOCATION_DETAIL' },
    }];
    await route.fulfill({ json: { ...makeRequestRecord(presentationRequestId, 'APPROVED', 2), allocation: newAllocation } });
  });

  await page.route(`${apiRoot}/requests/${exceptionRequestId}/resolutions`, async (route) => {
    const resolvedAllocation = {
      id: 'alloc-from-exception',
      requestId: exceptionRequestId,
      person: { personId: adminPerson.id, displayName: adminPerson.displayName },
      group: { id: groups[0].id, name: groups[0].name },
      initiative: { id: initiatives[0].id, code: initiatives[0].code, name: initiatives[0].name },
      resourceProfile: { id: profiles[0].id, name: profiles[0].name },
      startDate,
      endDate,
      approvedPeriod: { startDate, endDate },
      weeklyHours: 16,
      state: 'NOT_STARTED',
      approvedAt: '2026-11-21T15:05:00.000Z',
      version: 1,
      availableActions: ['ACTIVATE'],
    };
    state.queueItems.exceptions = [];
    state.allocationsList = [...state.allocationsList, resolvedAllocation];
    state.allocationLoadItems = [
      ...state.allocationLoadItems,
      {
        person: { personId: adminPerson.id, displayName: adminPerson.displayName },
        weeklyHoursByState: { NOT_STARTED: 16, IN_PROGRESS: 0, SUSPENDED: 0, ALLOCATED_WITHOUT_ACTION: 0, DONE: 0, CANCELED: 0 },
        totalWeeklyHours: 16,
      },
    ];
    state.requestsList = state.requestsList.map((item) =>
      item.id === exceptionRequestId ? makeRequestRecord(exceptionRequestId, 'APPROVED', 4, resolvedAllocation) : item,
    );
    state.notificationsList = [
      ...state.notificationsList,
      {
        id: 'notif-resolved',
        eventCode: 'EXCEPTION_RESOLVED',
        title: 'Exception resolved with allocation',
        message: 'Allocation created for Morgan Admin.',
        createdAt: '2026-11-21T15:05:00.000Z',
        readAt: null,
        etag: '"n2"',
        target: { type: 'REQUEST', requestId: exceptionRequestId, allocationId: resolvedAllocation.id, available: true, destination: 'ALLOCATION_DETAIL' },
      },
    ];
    await route.fulfill({ json: { ...makeRequestRecord(exceptionRequestId, 'APPROVED', 4), allocation: resolvedAllocation } });
  });

  await page.goto('/resource-allocation/?page=allocations');
  const allocationsRegion = page.getByRole('region', { name: 'Allocations and capacity' });
  const notificationsRegion = page.getByRole('region', { name: 'Notifications' });

  await expect(allocationsRegion.getByText('No allocations match these filters in your authorized scope.')).toBeVisible();
  await navigateToArea(page, 'notifications');
  await expect(notificationsRegion.getByText('No notifications match this filter.')).toBeVisible();
  expect(state.accessCount).toBe(1);

  // 1) Approve from Presentation queue -> updates Allocations, Capacity load, Requests, and Notifications without reload
  await navigateToArea(page, 'request-queues');
  const queuesRegion = page.getByRole('region', { name: 'Request queues' });
  await queuesRegion.getByRole('button', { name: 'Approve request' }).click();
  const approvalForm = queuesRegion.getByRole('form', { name: `Approve request ${presentationRequestId}` });
  await approvalForm.getByLabel('Eligible person').selectOption(workerPerson.id);
  await approvalForm.getByRole('button', { name: 'Approve request' }).click();

  await navigateToArea(page, 'allocations');
  await expect(allocationsRegion.getByRole('button', { name: /View allocation ITDM-10/ })).toBeVisible();
  await expect(allocationsRegion.getByRole('row', { name: /Alex Engineer/ })).toContainText('20 hours/week');
  await navigateToArea(page, 'notifications');
  await expect(notificationsRegion.getByRole('heading', { name: 'Request approved from presentation' })).toBeVisible();
  expect(state.accessCount).toBe(1);

  // 2) Resolve exception in Admin exceptions queue -> updates Allocations, Capacity load, Requests, and Notifications without reload
  await navigateToArea(page, 'request-queues');
  await queuesRegion.getByRole('tab', { name: 'Admin exceptions' }).click();
  await queuesRegion.getByRole('button', { name: 'Record strategy' }).click();
  const resolutionForm = queuesRegion.getByRole('form', { name: `Resolve exception ${exceptionRequestId}` });
  await resolutionForm.getByLabel('Reason').fill('Approved after reallocation.');
  await resolutionForm.getByLabel('Resolution action').selectOption('resolve');
  await resolutionForm.getByLabel('Eligible person').selectOption(adminPerson.id);
  await resolutionForm.getByLabel('Final weekly hours').fill('16');
  await resolutionForm.getByRole('button', { name: 'Resolve and approve' }).click();

  await navigateToArea(page, 'allocations');
  await expect(allocationsRegion.getByRole('button', { name: /View allocation ITDM-10/ })).toHaveCount(2);
  await expect(allocationsRegion.getByRole('row', { name: /Morgan Admin/ })).toContainText('16 hours/week');
  await navigateToArea(page, 'notifications');
  await expect(notificationsRegion.getByRole('heading', { name: 'Exception resolved with allocation' })).toBeVisible();
  await navigateToArea(page, 'requests');
  await expect(page.getByRole('region', { name: 'My requests' }).getByRole('button', { name: /ITDM-10.*Approved/ })).toHaveCount(2);
  expect(state.accessCount).toBe(1);
});

test('updates Allocations, capacity load, Request queues, and Notifications immediately without reload when accepting proposed conditions', async ({ page }) => {
  const startDate = futureDate(7);
  const endDate = futureDate(28);
  const requestId = 'req-accept-proposal';
  const moderator = {
    ...adminPerson,
    id: 'person-moderator',
    localUserId: 'profile-moderator',
    displayName: 'Casey Moderator',
    role: 'ALLOCATION_MODERATOR' as const,
  };
  let proposalRequest: Record<string, unknown> = {
    id: requestId,
    requesterSnapshot: { personId: moderator.id, displayName: moderator.displayName, role: moderator.role },
    requestedConditions: {
      initiativeId: initiatives[0].id,
      initiativeCode: initiatives[0].code,
      initiativeName: initiatives[0].name,
      category: 'EXECUTION_PROJECT',
      groupId: groups[0].id,
      groupName: groups[0].name,
      resourceProfileId: profiles[0].id,
      resourceProfileName: profiles[0].name,
      startDate,
      endDate,
      weeklyHours: 10,
      comment: 'Proposal sync test',
    },
    decisionState: 'APPROVED_WITH_CHANGES',
    receivedAt: '2026-11-20T12:00:00.000Z',
    stageEnteredAt: '2026-11-20T13:00:00.000Z',
    expirationDueAt: '2026-12-11T12:00:00.000Z',
    dueAt: '2026-11-24T13:00:00.000Z',
    availableActions: ['ACCEPT', 'CONTEST'],
    approvedConditions: {
      personId: workerPerson.id,
      personName: workerPerson.displayName,
      resourceProfileId: profiles[0].id,
      resourceProfileName: profiles[0].name,
      groupId: groups[0].id,
      groupName: groups[0].name,
      initiativeId: initiatives[0].id,
      initiativeCode: initiatives[0].code,
      initiativeName: initiatives[0].name,
      startDate,
      endDate,
      weeklyHours: 15,
      explanation: 'Expanded to 15 hours.',
    },
    version: 2,
  };

  let teamDecisionFetches = 0;
  const state: MockServerState = {
    currentUser: moderator,
    accessCount: 0,
    groupsList: [...groups],
    profilesList: [...profiles],
    initiativesList: [...initiatives],
    peopleList: [moderator, workerPerson],
    queueItems: { 'team-decision': [] },
    requestsList: [proposalRequest],
    allocationsList: [],
    allocationLoadItems: [],
    notificationsList: [],
    submissionsList: [],
    submissionLinesById: {},
    historyByRequestId: {},
    auditsByRequestId: {},
  };

  await installStatefulBackend(page, state);
  await page.route(`${apiRoot}/request-queues/team-decision**`, async (route) => {
    teamDecisionFetches += 1;
    await route.fulfill({ json: { items: state.queueItems['team-decision'] ?? [], page: emptyPage } });
  });
  await page.route(`${apiRoot}/requests/${requestId}/acceptances`, async (route) => {
    const newAllocation = {
      id: 'alloc-from-accept',
      requestId,
      person: { personId: workerPerson.id, displayName: workerPerson.displayName },
      group: { id: groups[0].id, name: groups[0].name },
      initiative: { id: initiatives[0].id, code: initiatives[0].code, name: initiatives[0].name },
      resourceProfile: { id: profiles[0].id, name: profiles[0].name },
      startDate,
      endDate,
      approvedPeriod: { startDate, endDate },
      weeklyHours: 15,
      state: 'NOT_STARTED',
      approvedAt: '2026-11-21T15:10:00.000Z',
      version: 1,
      availableActions: ['ACTIVATE'],
    };
    proposalRequest = {
      ...proposalRequest,
      decisionState: 'APPROVED',
      availableActions: [],
      confirmationSource: 'REQUESTER_ACCEPTANCE',
      allocation: newAllocation,
      version: 3,
    };
    state.requestsList = [proposalRequest];
    state.allocationsList = [newAllocation];
    state.allocationLoadItems = [{
      person: { personId: workerPerson.id, displayName: workerPerson.displayName },
      weeklyHoursByState: { NOT_STARTED: 15, IN_PROGRESS: 0, SUSPENDED: 0, ALLOCATED_WITHOUT_ACTION: 0, DONE: 0, CANCELED: 0 },
      totalWeeklyHours: 15,
    }];
    state.notificationsList = [{
      id: 'notif-accepted',
      eventCode: 'PROPOSAL_ACCEPTED',
      title: 'Changed proposal accepted',
      message: 'Allocation confirmed for Alex Engineer.',
      createdAt: '2026-11-21T15:10:00.000Z',
      readAt: null,
      etag: '"n-acc"',
      target: { type: 'REQUEST', requestId, allocationId: newAllocation.id, available: true, destination: 'ALLOCATION_DETAIL' },
    }];
    await route.fulfill({ json: { id: requestId, decisionState: 'APPROVED', version: 3, confirmationSource: 'REQUESTER_ACCEPTANCE' } });
  });

  await page.goto(`/resource-allocation/?page=request-queues&queue=team-decision`);
  await expect(page.getByRole('region', { name: 'Request queues' })).toBeVisible();
  await expect.poll(() => teamDecisionFetches).toBeGreaterThan(0);
  const initialQueueFetches = teamDecisionFetches;

  await navigateToArea(page, 'requests');
  await page.getByRole('button', { name: new RegExp(requestId) }).click();
  const detail = page.getByRole('region', { name: 'ITDM-10' });
  const allocationsRegion = page.getByRole('region', { name: 'Allocations and capacity' });
  const notificationsRegion = page.getByRole('region', { name: 'Notifications' });

  await expect(detail.getByRole('button', { name: 'Accept proposed conditions' })).toBeVisible();
  await detail.getByRole('button', { name: 'Accept proposed conditions' }).click();

  await navigateToArea(page, 'request-queues');
  await expect(page.getByText('There are no requests in this queue.')).toBeVisible();
  await expect.poll(() => teamDecisionFetches).toBeGreaterThan(initialQueueFetches);
  await navigateToArea(page, 'allocations');
  await expect(allocationsRegion.getByRole('button', { name: /View allocation ITDM-10/ })).toBeVisible();
  await expect(allocationsRegion.getByRole('row', { name: /Alex Engineer/ })).toContainText('15 hours/week');
  await navigateToArea(page, 'notifications');
  await expect(notificationsRegion.getByRole('heading', { name: 'Changed proposal accepted' })).toBeVisible();
  expect(state.accessCount).toBe(1);
});

test('updates Presentation queue and Submission results immediately without reload on request edit and withdrawal', async ({ page }) => {
  const startDate = futureDate(10);
  const endDate = futureDate(30);
  const requestId = 'req-edit-withdraw';
  const submissionId = 'sub-edit-withdraw';

  let currentRequest: Record<string, unknown> = {
    id: requestId,
    requesterSnapshot: { personId: adminPerson.id, displayName: adminPerson.displayName, role: adminPerson.role },
    requestedConditions: {
      initiativeId: initiatives[0].id,
      initiativeCode: initiatives[0].code,
      initiativeName: initiatives[0].name,
      category: 'EXECUTION_PROJECT',
      groupId: groups[0].id,
      groupName: groups[0].name,
      resourceProfileId: profiles[0].id,
      resourceProfileName: profiles[0].name,
      startDate,
      endDate,
      weeklyHours: 12,
      comment: 'Initial comment',
    },
    decisionState: 'WAITING_FOR_PRESENTATION',
    receivedAt: '2026-11-20T12:00:00.000Z',
    stageEnteredAt: '2026-11-20T12:00:00.000Z',
    expirationDueAt: '2026-12-11T12:00:00.000Z',
    dueAt: '2026-12-11T12:00:00.000Z',
    availableActions: [],
    version: 1,
  };

  let currentQueueItem: Record<string, unknown> | null = {
    id: requestId,
    requester: { personId: adminPerson.id, displayName: adminPerson.displayName, role: adminPerson.role },
    requestedConditions: currentRequest.requestedConditions,
    decisionState: 'WAITING_FOR_PRESENTATION',
    receivedAt: '2026-11-20T12:00:00.000Z',
    stageEnteredAt: '2026-11-20T12:00:00.000Z',
    dueAt: '2026-12-11T12:00:00.000Z',
    nextResponsible: { role: 'ALLOCATION_ADMIN' },
    availableActions: ['REFER'],
    impediments: [],
    version: 1,
  };

  let withdrawn = false;

  const state: MockServerState = {
    currentUser: adminPerson,
    accessCount: 0,
    groupsList: [...groups],
    profilesList: [...profiles],
    initiativesList: [...initiatives],
    peopleList: [adminPerson],
    queueItems: { presentation: [currentQueueItem] },
    requestsList: [currentRequest],
    allocationsList: [],
    allocationLoadItems: [],
    notificationsList: [],
    submissionsList: [{
      id: submissionId,
      initiativeId: initiatives[0].id,
      initiative: { id: initiatives[0].id, code: initiatives[0].code, name: initiatives[0].name },
      category: 'EXECUTION_PROJECT',
      receivedAt: '2026-11-20T12:00:00.000Z',
      lineCount: 1,
      counts: { received: 0, processing: 0, succeeded: 1, failed: 0 },
    }],
    submissionLinesById: {
      [submissionId]: [{
        id: 'line-1',
        attemptKey: 'attempt-1',
        submittedConditions: { groupId: groups[0].id, resourceProfileId: profiles[0].id, startDate, endDate, weeklyHours: 12 },
        status: 'SUCCEEDED',
        requestId,
        receivedAt: '2026-11-20T12:00:00.000Z',
        requestOutcome: { decisionState: 'WAITING_FOR_PRESENTATION', requestedConditions: { weeklyHours: 12 } },
      }],
    },
    historyByRequestId: {},
    auditsByRequestId: {},
  };

  await installStatefulBackend(page, state);

  await page.route(`${apiRoot}/requests/${requestId}`, async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      if (withdrawn) {
        await route.fulfill({ status: 404, json: { status: 404, code: 'RESOURCE_NOT_FOUND' } });
        return;
      }
      await route.fulfill({ headers: { etag: `"${String(currentRequest.version)}"` }, json: currentRequest });
      return;
    }
    if (request.method() === 'PATCH') {
      const patch = request.postDataJSON() as Record<string, unknown>;
      const nextConditions = { ...(currentRequest.requestedConditions as Record<string, unknown>), ...patch };
      currentRequest = { ...currentRequest, requestedConditions: nextConditions, version: 2 };
      currentQueueItem = { ...currentQueueItem!, requestedConditions: nextConditions, version: 2 };
      state.requestsList = [currentRequest];
      state.queueItems.presentation = [currentQueueItem];
      state.submissionLinesById[submissionId] = [{
        ...state.submissionLinesById[submissionId][0],
        requestOutcome: { decisionState: 'WAITING_FOR_PRESENTATION', requestedConditions: { weeklyHours: nextConditions.weeklyHours } },
      }];
      await route.fulfill({ headers: { etag: '"2"' }, json: currentRequest });
      return;
    }
    await route.fallback();
  });

  await page.route(`${apiRoot}/requests/${requestId}/withdrawals`, async (route) => {
    withdrawn = true;
    const body = route.request().postDataJSON() as { reason: string };
    const auditEvent = {
      id: 'audit-withdraw-1',
      requestId,
      action: 'WITHDRAWN',
      requesterSnapshot: { personId: adminPerson.id, displayName: adminPerson.displayName, role: adminPerson.role },
      actorSnapshot: { personId: adminPerson.id, displayName: adminPerson.displayName, role: adminPerson.role },
      requestSnapshot: { requestedConditions: currentRequest.requestedConditions },
      reason: body.reason,
      occurredAt: '2026-11-21T15:15:00.000Z',
      correlationId: 'corr-withdraw',
    };
    state.requestsList = [];
    state.queueItems.presentation = [];
    state.auditsByRequestId[requestId] = [auditEvent];
    state.submissionLinesById[submissionId] = [{
      ...state.submissionLinesById[submissionId][0],
      requestOutcome: { status: 'REMOVED', action: 'WITHDRAWN', reason: body.reason },
    }];
    await route.fulfill({ json: auditEvent });
  });

  await page.route(`${apiRoot}/request-audits/${requestId}`, async (route) => {
    await route.fulfill({ json: { requestId, events: state.auditsByRequestId[requestId] ?? [] } });
  });

  await page.goto(`/resource-allocation/?page=requests&requestId=${requestId}`);
  const detail = page.getByRole('region', { name: 'ITDM-10' });
  await expect(detail.getByLabel('Weekly hours')).toHaveValue('12');

  const queuesRegion = page.getByRole('region', { name: 'Request queues' });
  const submissionsPanel = page.getByRole('region', { name: 'My submissions' });
  await navigateToArea(page, 'request-queues');
  await expect(queuesRegion.getByRole('article', { name: /ITDM-10/ })).toContainText('12');
  await navigateToArea(page, 'new-request');
  await expect(submissionsPanel).toContainText('12 hours per week');

  await navigateToArea(page, 'requests');
  await page.getByRole('button', { name: new RegExp(requestId) }).click();
  await detail.getByLabel('Weekly hours').fill('18');
  await detail.getByRole('button', { name: 'Save request changes' }).click();

  await navigateToArea(page, 'request-queues');
  await expect(queuesRegion.getByRole('article', { name: /ITDM-10/ })).toContainText('18');
  await navigateToArea(page, 'new-request');
  await expect(submissionsPanel).toContainText('18 hours per week');
  expect(state.accessCount).toBe(1);

  await navigateToArea(page, 'requests');
  await page.getByRole('button', { name: new RegExp(requestId) }).click();
  await detail.getByRole('button', { name: 'Withdraw request' }).click();
  const dialog = page.getByRole('dialog', { name: 'Withdraw this request?' });
  await dialog.getByLabel('Reason for withdrawal').fill('No longer needed.');
  await dialog.getByRole('button', { name: 'Confirm withdrawal' }).click();

  await navigateToArea(page, 'request-queues');
  await expect(queuesRegion.getByText('There are no requests in this queue.')).toBeVisible();
  await navigateToArea(page, 'new-request');
  await expect(submissionsPanel).toContainText('Removed from operation');
  expect(state.accessCount).toBe(1);
});

test('updates Exceptions, Revalidation queues, Submissions, and Notifications immediately without reload on contest and cancel responses', async ({ page }) => {
  const startDate = futureDate(10);
  const endDate = futureDate(30);
  const deniedId = 'req-denied-contest';
  const revalidationId = 'req-revalidation-cancel';

  const makeItem = (id: string, decisionState: string, availableActions: string[], version: number) => ({
    id,
    requesterSnapshot: { personId: adminPerson.id, displayName: adminPerson.displayName, role: adminPerson.role },
    requestedConditions: {
      initiativeId: initiatives[0].id,
      initiativeCode: initiatives[0].code,
      initiativeName: initiatives[0].name,
      category: 'EXECUTION_PROJECT',
      groupId: groups[0].id,
      groupName: groups[0].name,
      resourceProfileId: profiles[0].id,
      resourceProfileName: profiles[0].name,
      startDate,
      endDate,
      weeklyHours: 14,
      comment: 'Response sync test',
    },
    decisionState,
    receivedAt: '2026-11-20T12:00:00.000Z',
    stageEnteredAt: '2026-11-20T12:00:00.000Z',
    expirationDueAt: '2026-12-11T12:00:00.000Z',
    availableActions,
    version,
  });

  const makeQueueItem = (id: string, decisionState: string, version: number) => ({
    id,
    requester: { personId: adminPerson.id, displayName: adminPerson.displayName, role: adminPerson.role },
    requestedConditions: {
      initiativeId: initiatives[0].id,
      initiativeCode: initiatives[0].code,
      initiativeName: initiatives[0].name,
      groupId: groups[0].id,
      groupName: groups[0].name,
      resourceProfileId: profiles[0].id,
      resourceProfileName: profiles[0].name,
      startDate,
      endDate,
      weeklyHours: 14,
    },
    decisionState,
    receivedAt: '2026-11-20T12:00:00.000Z',
    stageEnteredAt: '2026-11-20T12:00:00.000Z',
    dueAt: null,
    nextResponsible: { role: 'ALLOCATION_ADMIN' },
    availableActions: [],
    impediments: [],
    version,
  });

  const state: MockServerState = {
    currentUser: adminPerson,
    accessCount: 0,
    groupsList: [...groups],
    profilesList: [...profiles],
    initiativesList: [...initiatives],
    peopleList: [adminPerson],
    queueItems: {
      exceptions: [],
      revalidation: [makeQueueItem(revalidationId, 'REQUIRES_REVALIDATION', 3)],
    },
    requestsList: [
      makeItem(deniedId, 'DENIED', ['CONTEST', 'CANCEL'], 2),
      makeItem(revalidationId, 'REQUIRES_REVALIDATION', ['CANCEL'], 3),
    ],
    allocationsList: [],
    allocationLoadItems: [],
    notificationsList: [],
    submissionsList: [{
      id: 'sub-resp',
      initiativeId: initiatives[0].id,
      initiative: { id: initiatives[0].id, code: initiatives[0].code, name: initiatives[0].name },
      category: 'EXECUTION_PROJECT',
      receivedAt: '2026-11-20T12:00:00.000Z',
      lineCount: 1,
      counts: { received: 0, processing: 0, succeeded: 1, failed: 0 },
    }],
    submissionLinesById: {
      'sub-resp': [{
        id: 'line-resp',
        attemptKey: 'attempt-resp',
        submittedConditions: { groupId: groups[0].id, resourceProfileId: profiles[0].id, startDate, endDate, weeklyHours: 14 },
        status: 'SUCCEEDED',
        requestId: deniedId,
        receivedAt: '2026-11-20T12:00:00.000Z',
        requestOutcome: { decisionState: 'DENIED' },
      }],
    },
    historyByRequestId: {
      [deniedId]: [{ id: 'ev-1', action: 'DENIED', actorSnapshot: { displayName: 'Lead' }, before: {}, after: {}, reason: 'No capacity', occurredAt: '2026-11-20T13:00:00.000Z', correlationId: 'c1' }],
      [revalidationId]: [],
    },
    auditsByRequestId: {},
  };

  await installStatefulBackend(page, state);

  await page.route(`${apiRoot}/requests/${deniedId}/contests`, async (route) => {
    const contested = makeItem(deniedId, 'PRE_N3', [], 3);
    state.requestsList = state.requestsList.map((item) => (item.id === deniedId ? contested : item));
    state.queueItems.exceptions = [makeQueueItem(deniedId, 'PRE_N3', 3)];
    state.submissionLinesById['sub-resp'] = [{ ...state.submissionLinesById['sub-resp'][0], requestOutcome: { decisionState: 'PRE_N3' } }];
    state.notificationsList = [{
      id: 'notif-contested',
      eventCode: 'REQUEST_CONTESTED',
      title: 'Denial contested into Pre N3',
      message: 'Review required in exceptions queue.',
      createdAt: '2026-11-21T15:20:00.000Z',
      readAt: null,
      etag: '"n-contest"',
      target: { type: 'REQUEST', requestId: deniedId, available: true, destination: 'REQUEST_DETAIL' },
    }];
    await route.fulfill({ headers: { etag: '"3"' }, json: contested });
  });

  await page.route(`${apiRoot}/requests/${revalidationId}/cancellations`, async (route) => {
    const cancelled = makeItem(revalidationId, 'CANCELLED', [], 4);
    state.requestsList = state.requestsList.map((item) => (item.id === revalidationId ? cancelled : item));
    state.queueItems.revalidation = [];
    state.notificationsList = [
      ...state.notificationsList,
      {
        id: 'notif-cancelled',
        eventCode: 'REQUEST_CANCELLED',
        title: 'Revalidation request cancelled',
        message: 'Requester cancelled revalidation.',
        createdAt: '2026-11-21T15:25:00.000Z',
        readAt: null,
        etag: '"n-cancel"',
        target: { type: 'REQUEST', requestId: revalidationId, available: true, destination: 'REQUEST_DETAIL' },
      },
    ];
    await route.fulfill({ headers: { etag: '"4"' }, json: cancelled });
  });

  await page.goto('/resource-allocation/?page=requests');
  const queuesRegion = page.getByRole('region', { name: 'Request queues' });
  const requestsRegion = page.getByRole('region', { name: 'My requests' });
  const notificationsRegion = page.getByRole('region', { name: 'Notifications' });
  const submissionsPanel = page.getByRole('region', { name: 'My submissions' });

  // 1) Contest denial -> appears immediately in Admin exceptions queue + Notifications + Submissions
  await requestsRegion.getByRole('button', { name: new RegExp(deniedId) }).click();
  await requestsRegion.getByRole('button', { name: 'Contest denial' }).click();
  await requestsRegion.getByLabel('Reason for contesting').fill('Priority project requires review.');
  await requestsRegion.getByRole('button', { name: 'Submit contest' }).click();

  await navigateToArea(page, 'request-queues');
  await queuesRegion.getByRole('tab', { name: 'Admin exceptions' }).click();
  await expect(queuesRegion.getByRole('article', { name: /ITDM-10/ })).toContainText('PRE N3');
  await navigateToArea(page, 'notifications');
  await expect(notificationsRegion.getByRole('heading', { name: 'Denial contested into Pre N3' })).toBeVisible();
  await navigateToArea(page, 'new-request');
  await expect(submissionsPanel).toContainText('Current outcome: PRE_N3');
  expect(state.accessCount).toBe(1);

  // 2) Cancel revalidation -> disappears immediately from Revalidation queue + updates Notifications
  await navigateToArea(page, 'requests');
  await requestsRegion.getByRole('button', { name: new RegExp(revalidationId) }).click();
  await requestsRegion.getByRole('button', { name: 'Cancel request' }).click();
  await requestsRegion.getByLabel('Reason for cancellation').fill('Scope dropped.');
  await requestsRegion.getByRole('button', { name: 'Confirm cancellation' }).click();

  await navigateToArea(page, 'request-queues');
  await queuesRegion.getByRole('tab', { name: 'Revalidation queue' }).click();
  await expect(queuesRegion.getByText('There are no requests in this queue.')).toBeVisible();
  await navigateToArea(page, 'notifications');
  await expect(notificationsRegion.getByRole('heading', { name: 'Revalidation request cancelled' })).toBeVisible();
  expect(state.accessCount).toBe(1);
});

test('updates Requests and Notifications immediately without reload when an allocation operational state changes', async ({ page }) => {
  const startDate = futureDate(5);
  const endDate = futureDate(25);
  const requestId = 'req-alloc-sync';
  const allocationId = 'alloc-sync';

  let currentAllocation: Record<string, unknown> = {
    id: allocationId,
    requestId,
    person: { personId: workerPerson.id, displayName: workerPerson.displayName },
    group: { id: groups[0].id, name: groups[0].name },
    initiative: { id: initiatives[0].id, code: initiatives[0].code, name: initiatives[0].name },
    resourceProfile: { id: profiles[0].id, name: profiles[0].name },
    startDate,
    endDate,
    approvedPeriod: { startDate, endDate },
    weeklyHours: 20,
    state: 'IN_PROGRESS',
    approvedAt: '2026-11-20T14:00:00.000Z',
    version: 3,
    availableActions: ['SUSPEND'],
  };

  let currentRequest: Record<string, unknown> = {
    id: requestId,
    requesterSnapshot: { personId: workerPerson.id, displayName: workerPerson.displayName, role: workerPerson.role },
    requestedConditions: {
      initiativeId: initiatives[0].id,
      initiativeCode: initiatives[0].code,
      initiativeName: initiatives[0].name,
      category: 'EXECUTION_PROJECT',
      groupId: groups[0].id,
      groupName: groups[0].name,
      resourceProfileId: profiles[0].id,
      resourceProfileName: profiles[0].name,
      startDate,
      endDate,
      weeklyHours: 20,
    },
    decisionState: 'APPROVED',
    receivedAt: '2026-11-20T12:00:00.000Z',
    stageEnteredAt: '2026-11-20T14:00:00.000Z',
    expirationDueAt: '2026-12-11T12:00:00.000Z',
    allocation: {
      id: allocationId,
      person: { personId: workerPerson.id, displayName: workerPerson.displayName },
      group: { id: groups[0].id, name: groups[0].name },
      initiative: { id: initiatives[0].id, code: initiatives[0].code, name: initiatives[0].name },
      resourceProfile: { id: profiles[0].id, name: profiles[0].name },
      startDate,
      endDate,
      weeklyHours: 20,
      state: 'IN_PROGRESS',
      approvedAt: '2026-11-20T14:00:00.000Z',
      version: 3,
    },
    version: 2,
  };

  const state: MockServerState = {
    currentUser: workerPerson,
    accessCount: 0,
    groupsList: [...groups],
    profilesList: [...profiles],
    initiativesList: [...initiatives],
    peopleList: [workerPerson],
    queueItems: {},
    requestsList: [currentRequest],
    allocationsList: [currentAllocation],
    allocationLoadItems: [{
      person: { personId: workerPerson.id, displayName: workerPerson.displayName },
      weeklyHoursByState: { NOT_STARTED: 0, IN_PROGRESS: 20, SUSPENDED: 0, ALLOCATED_WITHOUT_ACTION: 0, DONE: 0, CANCELED: 0 },
      totalWeeklyHours: 20,
    }],
    notificationsList: [],
    submissionsList: [],
    submissionLinesById: {},
    historyByRequestId: {},
    auditsByRequestId: {},
  };

  await installStatefulBackend(page, state);

  await page.route(`${apiRoot}/allocations/${allocationId}/suspensions`, async (route) => {
    currentAllocation = { ...currentAllocation, state: 'SUSPENDED', version: 4, availableActions: ['RESUME', 'CANCEL', 'COMPLETE'] };
    currentRequest = {
      ...currentRequest,
      allocation: { ...(currentRequest.allocation as Record<string, unknown>), state: 'SUSPENDED', version: 4 },
    };
    state.allocationsList = [currentAllocation];
    state.requestsList = [currentRequest];
    state.allocationLoadItems = [{
      person: { personId: workerPerson.id, displayName: workerPerson.displayName },
      weeklyHoursByState: { NOT_STARTED: 0, IN_PROGRESS: 0, SUSPENDED: 20, ALLOCATED_WITHOUT_ACTION: 0, DONE: 0, CANCELED: 0 },
      totalWeeklyHours: 20,
    }];
    state.notificationsList = [{
      id: 'notif-alloc-suspended',
      eventCode: 'ALLOCATION_SUSPENDED',
      title: 'Allocation suspended',
      message: 'Allocation state changed to Suspended.',
      createdAt: '2026-11-21T15:30:00.000Z',
      readAt: null,
      etag: '"n-susp"',
      target: { type: 'REQUEST', requestId, allocationId, available: true, destination: 'ALLOCATION_DETAIL' },
    }];
    await route.fulfill({ headers: { etag: '"4"' }, json: currentAllocation });
  });

  await page.goto(`/resource-allocation/?page=requests&requestId=${requestId}`);
  const requestDetail = page.getByRole('region', { name: 'ITDM-10' });
  const allocationsRegion = page.getByRole('region', { name: 'Allocations and capacity' });
  const notificationsRegion = page.getByRole('region', { name: 'Notifications' });

  await expect(requestDetail.getByRole('region', { name: 'Approved allocation' })).toContainText('IN PROGRESS');
  await navigateToArea(page, 'allocations');
  await expect(allocationsRegion.getByRole('row', { name: /Alex Engineer/ })).toContainText('20 hours/week');

  await allocationsRegion.getByRole('button', { name: 'View allocation ITDM-10' }).click();
  const allocDetail = allocationsRegion.getByRole('region', { name: 'Allocation details' });
  await allocDetail.getByRole('button', { name: 'Suspend' }).click();
  await allocDetail.getByRole('textbox', { name: 'Reason' }).fill('Paused for dependency.');
  await allocDetail.getByRole('button', { name: 'Save change' }).click();

  await expect(allocDetail).toContainText('Suspended');
  await navigateToArea(page, 'requests');
  await page.getByRole('button', { name: new RegExp(requestId) }).click();
  await expect(requestDetail.getByRole('region', { name: 'Approved allocation' })).toContainText('SUSPENDED');
  await navigateToArea(page, 'notifications');
  await expect(notificationsRegion.getByRole('heading', { name: 'Allocation suspended' })).toBeVisible();
  expect(state.accessCount).toBe(1);
});

test('updates selections, Requests, Request queues, Allocations, capacity load, and Notifications immediately without reload after Administration changes', async ({ page }) => {
  const startDate = futureDate(8);
  const endDate = futureDate(28);
  const requestId = 'req-admin-sync';
  const allocationId = 'alloc-admin-sync';

  const makeRequest = (decisionState: string, profileName: string, version: number) => ({
    id: requestId,
    requesterSnapshot: { personId: workerPerson.id, displayName: workerPerson.displayName, role: workerPerson.role },
    requestedConditions: {
      initiativeId: initiatives[0].id,
      initiativeCode: initiatives[0].code,
      initiativeName: initiatives[0].name,
      category: 'EXECUTION_PROJECT',
      groupId: groups[0].id,
      groupName: groups[0].name,
      resourceProfileId: profiles[0].id,
      resourceProfileName: profileName,
      startDate,
      endDate,
      weeklyHours: 16,
    },
    decisionState,
    receivedAt: '2026-11-20T12:00:00.000Z',
    stageEnteredAt: '2026-11-20T12:00:00.000Z',
    expirationDueAt: '2026-12-11T12:00:00.000Z',
    version,
  });

  const makeAllocation = (profileName: string, personName: string, weeklyHours: number, version: number) => ({
    id: allocationId,
    requestId,
    person: { personId: workerPerson.id, displayName: personName },
    group: { id: groups[0].id, name: groups[0].name },
    initiative: { id: initiatives[0].id, code: initiatives[0].code, name: initiatives[0].name },
    resourceProfile: { id: profiles[0].id, name: profileName },
    startDate,
    endDate,
    approvedPeriod: { startDate, endDate },
    weeklyHours,
    state: 'IN_PROGRESS',
    approvedAt: '2026-11-20T14:00:00.000Z',
    version,
    availableActions: ['SUSPEND'],
  });

  const state: MockServerState = {
    currentUser: adminPerson,
    accessCount: 0,
    groupsList: [...groups],
    profilesList: [...profiles],
    initiativesList: [...initiatives],
    peopleList: [adminPerson, workerPerson],
    queueItems: { revalidation: [] },
    requestsList: [makeRequest('WAITING_FOR_PRESENTATION', 'API Engineering', 1)],
    allocationsList: [makeAllocation('API Engineering', workerPerson.displayName, 16, 1)],
    allocationLoadItems: [{
      person: { personId: workerPerson.id, displayName: workerPerson.displayName },
      weeklyHoursByState: { NOT_STARTED: 0, IN_PROGRESS: 16, SUSPENDED: 0, ALLOCATED_WITHOUT_ACTION: 0, DONE: 0, CANCELED: 0 },
      totalWeeklyHours: 16,
    }],
    notificationsList: [],
    submissionsList: [],
    submissionLinesById: {},
    historyByRequestId: {},
    auditsByRequestId: {},
  };

  await installStatefulBackend(page, state);

  await page.route(`${apiRoot}/admin/initiatives`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as { code: string; name: string; active: boolean };
    const created = { id: 'initiative-99', code: body.code, name: body.name, active: body.active, version: 1 };
    state.initiativesList = [...state.initiativesList, created];
    await route.fulfill({ status: 201, headers: { etag: '"1"' }, json: created });
  });

  await page.route(`${apiRoot}/admin/resource-profiles/profile-a`, async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({ headers: { etag: `"${String(state.profilesList[0].version)}"` }, json: state.profilesList[0] });
      return;
    }
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as { name: string; groupId: string; active: boolean };
      const updated = { ...state.profilesList[0], ...body, version: 2 };
      state.profilesList = [updated];
      state.requestsList = [makeRequest('REQUIRES_REVALIDATION', updated.name, 2)];
      state.queueItems.revalidation = [{
        id: requestId,
        requester: { personId: workerPerson.id, displayName: workerPerson.displayName, role: workerPerson.role },
        requestedConditions: {
          initiativeId: initiatives[0].id,
          initiativeCode: initiatives[0].code,
          initiativeName: initiatives[0].name,
          groupId: groups[0].id,
          groupName: groups[0].name,
          resourceProfileId: updated.id,
          resourceProfileName: updated.name,
          startDate,
          endDate,
          weeklyHours: 16,
        },
        decisionState: 'REQUIRES_REVALIDATION',
        originState: 'WAITING_FOR_PRESENTATION',
        receivedAt: '2026-11-20T12:00:00.000Z',
        stageEnteredAt: '2026-11-21T15:35:00.000Z',
        dueAt: null,
        impediments: ['PROFILE_INACTIVE'],
        nextResponsible: { role: 'ALLOCATION_ADMIN' },
        availableActions: [],
        version: 2,
      }];
      state.allocationsList = [makeAllocation(updated.name, workerPerson.displayName, 16, 2)];
      state.allocationLoadItems = [{
        person: { personId: workerPerson.id, displayName: workerPerson.displayName },
        weeklyHoursByState: { NOT_STARTED: 0, IN_PROGRESS: 24, SUSPENDED: 0, ALLOCATED_WITHOUT_ACTION: 0, DONE: 0, CANCELED: 0 },
        totalWeeklyHours: 24,
      }];
      state.notificationsList = [{
        id: 'notif-admin-profile',
        eventCode: 'REVALIDATION_REQUIRED',
        title: 'Profile update triggered revalidation',
        message: 'Review affected requests and allocations.',
        createdAt: '2026-11-21T15:35:00.000Z',
        readAt: null,
        etag: '"n-prof"',
        target: { type: 'REQUEST', requestId, available: true, destination: 'REQUEST_DETAIL' },
      }];
      await route.fulfill({ headers: { etag: '"2"' }, json: updated });
      return;
    }
    await route.fallback();
  });

  await page.goto('/resource-allocation/?page=request-queues');
  const adminRegion = page.getByRole('region', { name: 'Administration' });
  const queuesRegion = page.getByRole('region', { name: 'Request queues' });
  const requestsRegion = page.getByRole('region', { name: 'My requests' });
  const allocationsRegion = page.getByRole('region', { name: 'Allocations and capacity' });
  const notificationsRegion = page.getByRole('region', { name: 'Notifications' });

  await queuesRegion.getByRole('tab', { name: 'Revalidation queue' }).click();
  await expect(queuesRegion.getByText('There are no requests in this queue.')).toBeVisible();
  expect(state.accessCount).toBe(1);

  // 1) Create a new ITDM -> immediately selectable in Submissions, Requests filters, and Queue filters without /access refetch
  await navigateToArea(page, 'administration');
  await adminRegion.getByRole('tab', { name: 'Initiatives' }).click();
  await adminRegion.getByRole('button', { name: 'Add initiative' }).click();
  await adminRegion.getByLabel('Code').fill('ITDM-99');
  await adminRegion.getByLabel('Name').fill('Horizon Refresh');
  await adminRegion.getByRole('button', { name: 'Save initiative' }).click();

  await navigateToArea(page, 'new-request');
  await expect(page.getByRole('combobox', { name: 'Initiative', exact: true })).toContainText('ITDM-99 — Horizon Refresh');
  await navigateToArea(page, 'requests');
  await expect(requestsRegion.getByLabel('ITDM')).toContainText('ITDM-99 · Horizon Refresh');
  await navigateToArea(page, 'request-queues');
  await queuesRegion.getByRole('tab', { name: 'Revalidation queue' }).click();
  await expect(queuesRegion.getByLabel('ITDM')).toContainText('ITDM-99 — Horizon Refresh');
  expect(state.accessCount).toBe(1);

  // 2) Edit/deactivate a resource profile -> updates Requests, Revalidation queue, Allocations, capacity load, and Notifications without /access refetch
  await navigateToArea(page, 'administration');
  await adminRegion.getByRole('tab', { name: 'Resource profiles' }).click();
  await adminRegion.getByRole('button', { name: 'Edit resource profile API Engineering' }).click();
  await adminRegion.getByLabel('Name').fill('Core API Engineering');
  await adminRegion.getByLabel('Active').uncheck();
  await adminRegion.getByRole('button', { name: 'Save resource profile' }).click();

  await navigateToArea(page, 'request-queues');
  await queuesRegion.getByRole('tab', { name: 'Revalidation queue' }).click();
  await expect(queuesRegion.getByRole('article', { name: /ITDM-10/ })).toContainText('Core API Engineering');
  await navigateToArea(page, 'requests');
  await expect(requestsRegion.getByRole('button', { name: /ITDM-10.*Requires revalidation/ })).toBeVisible();
  await navigateToArea(page, 'allocations');
  await expect(allocationsRegion.getByRole('button', { name: /View allocation ITDM-10/ })).toContainText('Core API Engineering');
  await expect(allocationsRegion.getByRole('row', { name: /Alex Engineer/ })).toContainText('24 hours/week');
  await navigateToArea(page, 'notifications');
  await expect(notificationsRegion.getByRole('heading', { name: 'Profile update triggered revalidation' })).toBeVisible();
  expect(state.accessCount).toBe(1);
});

test('updates Requests, Request queues, and Notifications immediately without reload when submitting a new request batch', async ({ page }) => {
  const startDate = futureDate(5);
  const endDate = futureDate(20);
  const state: MockServerState = {
    currentUser: adminPerson,
    accessCount: 0,
    groupsList: [...groups],
    profilesList: [...profiles],
    initiativesList: [...initiatives],
    peopleList: [adminPerson],
    queueItems: { presentation: [] },
    requestsList: [],
    allocationsList: [],
    allocationLoadItems: [],
    notificationsList: [],
    submissionsList: [],
    submissionLinesById: {},
    historyByRequestId: {},
    auditsByRequestId: {},
  };

  await installStatefulBackend(page, state);

  await page.route(`${apiRoot}/submissions`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    const newSubmissionId = 'sub-new-batch';
    const newRequestId = 'req-from-batch';
    state.submissionsList = [{
      id: newSubmissionId,
      initiativeId: initiatives[0].id,
      initiative: { id: initiatives[0].id, code: initiatives[0].code, name: initiatives[0].name },
      category: 'EXECUTION_PROJECT',
      receivedAt: '2026-11-21T15:40:00.000Z',
      lineCount: 1,
      counts: { received: 0, processing: 0, succeeded: 1, failed: 0 },
    }];
    state.submissionLinesById[newSubmissionId] = [{
      id: 'line-new',
      attemptKey: 'attempt-new',
      submittedConditions: { groupId: groups[0].id, resourceProfileId: profiles[0].id, startDate, endDate, weeklyHours: 10 },
      status: 'SUCCEEDED',
      requestId: newRequestId,
      receivedAt: '2026-11-21T15:40:00.000Z',
      requestOutcome: { decisionState: 'WAITING_FOR_PRESENTATION' },
    }];
    state.requestsList = [{
      id: newRequestId,
      requesterSnapshot: { personId: adminPerson.id, displayName: adminPerson.displayName, role: adminPerson.role },
      requestedConditions: {
        initiativeId: initiatives[0].id,
        initiativeCode: initiatives[0].code,
        initiativeName: initiatives[0].name,
        category: 'EXECUTION_PROJECT',
        groupId: groups[0].id,
        groupName: groups[0].name,
        resourceProfileId: profiles[0].id,
        resourceProfileName: profiles[0].name,
        startDate,
        endDate,
        weeklyHours: 10,
      },
      decisionState: 'WAITING_FOR_PRESENTATION',
      receivedAt: '2026-11-21T15:40:00.000Z',
      stageEnteredAt: '2026-11-21T15:40:00.000Z',
      expirationDueAt: '2026-12-12T15:40:00.000Z',
      version: 1,
    }];
    state.queueItems.presentation = [{
      id: newRequestId,
      requester: { personId: adminPerson.id, displayName: adminPerson.displayName, role: adminPerson.role },
      requestedConditions: {
        initiativeId: initiatives[0].id,
        initiativeCode: initiatives[0].code,
        initiativeName: initiatives[0].name,
        groupId: groups[0].id,
        groupName: groups[0].name,
        resourceProfileId: profiles[0].id,
        resourceProfileName: profiles[0].name,
        startDate,
        endDate,
        weeklyHours: 10,
      },
      decisionState: 'WAITING_FOR_PRESENTATION',
      receivedAt: '2026-11-21T15:40:00.000Z',
      stageEnteredAt: '2026-11-21T15:40:00.000Z',
      dueAt: '2026-12-12T15:40:00.000Z',
      nextResponsible: { role: 'ALLOCATION_ADMIN' },
      availableActions: ['REFER'],
      impediments: [],
      version: 1,
    }];
    state.notificationsList = [{
      id: 'notif-batch-created',
      eventCode: 'REQUEST_CREATED',
      title: 'New presentation request arrived',
      message: 'Submitted batch created req-from-batch.',
      createdAt: '2026-11-21T15:40:00.000Z',
      readAt: null,
      etag: '"n-batch"',
      target: { type: 'REQUEST', requestId: newRequestId, available: true, destination: 'PRESENTATION_QUEUE' },
    }];
    await route.fulfill({
      status: 202,
      json: { id: newSubmissionId, receivedAt: '2026-11-21T15:40:00.000Z', lineCount: 1, counts: { received: 1, processing: 0, succeeded: 0, failed: 0 } },
    });
  });

  await page.goto('/resource-allocation/?page=request-queues');
  const queuesRegion = page.getByRole('region', { name: 'Request queues' });
  const requestsRegion = page.getByRole('region', { name: 'My requests' });
  const notificationsRegion = page.getByRole('region', { name: 'Notifications' });

  await expect(queuesRegion.getByText('There are no requests in this queue.')).toBeVisible();
  await navigateToArea(page, 'requests');
  await expect(requestsRegion.getByText('No operational requests match these filters.')).toBeVisible();

  await navigateToArea(page, 'new-request');
  await page.getByRole('combobox', { name: 'Initiative', exact: true }).selectOption(initiatives[0].id);
  await page.getByLabel('Category').selectOption('EXECUTION_PROJECT');
  await page.getByLabel('Group for line 1').selectOption(groups[0].id);
  await page.getByLabel('Resource profile for line 1').selectOption(profiles[0].id);
  await page.getByLabel('Start date for line 1').fill(startDate);
  await page.getByLabel('End date for line 1').fill(endDate);
  await page.getByLabel('Weekly hours for line 1').fill('10');
  await page.getByRole('button', { name: 'Add request line' }).click();
  await page.getByRole('button', { name: 'Review submission' }).click();
  await page.getByRole('button', { name: 'Send 1 request' }).click();

  await navigateToArea(page, 'request-queues');
  await expect(queuesRegion.getByRole('article', { name: /ITDM-10/ })).toBeVisible();
  await navigateToArea(page, 'requests');
  await expect(requestsRegion.getByRole('button', { name: /ITDM-10/ })).toBeVisible();
  await navigateToArea(page, 'notifications');
  await expect(notificationsRegion.getByRole('heading', { name: 'New presentation request arrived' })).toBeVisible();
  expect(state.accessCount).toBe(1);
});
