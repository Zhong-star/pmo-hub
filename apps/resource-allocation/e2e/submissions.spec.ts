import { expect, test, type Page } from '@playwright/test';

const apiRoot = '**/api/resource-allocation/v1';
const accessPath = `${apiRoot}/access`;
const profileStorageKey = 'pmo-hub.local-user-id';

const user = {
  id: 'person-user',
  localUserId: 'profile-user',
  displayName: 'Taylor User',
  role: 'ALLOCATION_USER',
  coveredGroupIds: [],
};

const initiative = { id: 'initiative-1', code: 'ITDM-9', name: 'Client platform rollout' };
const group = { id: 'group-1', name: 'Platform Engineering' };
const profile = { id: 'profile-1', name: 'API Engineering', groupId: group.id };

const emptyPage = { nextCursor: null, limit: 100 };

async function openAsUser(page: Page) {
  await page.addInitScript(({ key }) => window.localStorage.setItem(key, 'profile-user'), {
    key: profileStorageKey,
  });
  await page.goto('/resource-allocation/');
}

async function installSelectionFixtures(page: Page) {
  await page.route(accessPath, async (route) => route.fulfill({ json: { person: user } }));
  await page.route(`${apiRoot}/initiatives**`, async (route) => route.fulfill({
    json: { items: [initiative], page: emptyPage },
  }));
  await page.route(`${apiRoot}/groups**`, async (route) => route.fulfill({
    json: { items: [group], page: emptyPage },
  }));
  await page.route(`${apiRoot}/resource-profiles**`, async (route) => route.fulfill({
    json: { items: [profile], page: emptyPage },
  }));
  await page.route(`${apiRoot}/requests**`, async (route) => route.fulfill({
    json: { items: [], page: { nextCursor: null, limit: 50 } },
  }));
  await page.route(`${apiRoot}/notifications**`, async (route) => route.fulfill({
    json: { items: [], page: { nextCursor: null, limit: 50 } },
  }));
}

function dateAfter(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

test('reviews a batch, normalizes decimal commas, and rejects invalid hours before sending', async ({ page }) => {
  await installSelectionFixtures(page);
  let postedBody: Record<string, unknown> | undefined;
  let postedHeaders: Record<string, string> | undefined;
  await page.route(`${apiRoot}/submissions**`, async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      postedBody = request.postDataJSON() as Record<string, unknown>;
      postedHeaders = request.headers();
      await route.fulfill({
        status: 202,
        headers: { location: '/api/resource-allocation/v1/submissions/submission-1' },
        json: { id: 'submission-1', receivedAt: '2026-11-20T12:00:00Z', lineCount: 1, counts: { received: 1, processing: 0, succeeded: 0, failed: 0 } },
      });
      return;
    }
    if (new URL(request.url()).pathname.endsWith('/submissions')) {
      await route.fulfill({ json: { items: [], page: emptyPage } });
      return;
    }
    await route.fallback();
  });

  await openAsUser(page);

  await expect(page.getByRole('heading', { name: 'New request batch' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Initiative', exact: true }).selectOption(initiative.id);
  await page.getByLabel('Category').selectOption('EXECUTION_PROJECT');
  await page.getByLabel('Group for line 1').selectOption(group.id);
  await page.getByLabel('Resource profile for line 1').selectOption(profile.id);
  await page.getByLabel('Start date for line 1').fill(dateAfter(2));
  await page.getByLabel('End date for line 1').fill(dateAfter(9));
  await page.getByLabel('Weekly hours for line 1').fill('0,04');
  await page.getByRole('button', { name: 'Review submission' }).click();
  await expect(page.getByText(/round to at least 0\.1 hours/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Review your requests' })).toHaveCount(0);

  await page.getByLabel('Weekly hours for line 1').fill('40.04');
  await page.getByRole('button', { name: 'Review submission' }).click();
  await expect(page.getByText(/cannot exceed 40 hours/i)).toBeVisible();

  await page.getByLabel('Weekly hours for line 1').fill('1,25');
  await page.getByRole('button', { name: 'Review submission' }).click();
  await expect(page.getByRole('heading', { name: 'Review your requests' })).toBeVisible();
  await expect(page.getByText('1.3 hours per week')).toBeVisible();
  await page.getByRole('button', { name: 'Send 1 request' }).click();

  await expect(page.getByText(/Submission submission-1 was received/i)).toBeVisible();
  expect(postedHeaders?.['x-pmo-local-user-id']).toBe('profile-user');
  expect(postedHeaders?.['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
  expect(postedBody).toMatchObject({
    initiativeId: initiative.id,
    category: 'EXECUTION_PROJECT',
    lines: [{ groupId: group.id, resourceProfileId: profile.id, weeklyHours: 1.3 }],
  });
  expect((postedBody?.lines as Array<Record<string, unknown>>)[0]?.attemptKey).toMatch(/^[0-9a-f-]{36}$/i);
});

test('recovers a durable submission after reload and offers correction only for failed lines', async ({ page }) => {
  await installSelectionFixtures(page);
  const original = {
    id: 'submission-original',
    receivedAt: '2026-11-20T12:00:00Z',
    lineCount: 3,
    counts: { received: 0, processing: 1, succeeded: 1, failed: 1 },
  };
  let createdBody: Record<string, unknown> | undefined;
  let createdHeaders: Record<string, string> | undefined;
  await page.route(`${apiRoot}/submissions**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST') {
      createdBody = request.postDataJSON() as Record<string, unknown>;
      createdHeaders = request.headers();
      await route.fulfill({
        status: 202,
        headers: { location: '/api/resource-allocation/v1/submissions/submission-retry' },
        json: { id: 'submission-retry', receivedAt: '2026-11-20T13:00:00Z', lineCount: 1, counts: { received: 1, processing: 0, succeeded: 0, failed: 0 } },
      });
      return;
    }
    if (url.pathname.endsWith('/submissions')) {
      await route.fulfill({ json: { items: [original], page: emptyPage } });
      return;
    }
    if (url.pathname.endsWith('/submissions/submission-original/lines')) {
      await route.fulfill({
        json: {
          items: [
            { id: 'line-success', attemptKey: 'attempt-success', submittedConditions: { initiativeId: initiative.id, category: 'EXECUTION_PROJECT', attemptKey: 'attempt-success', groupId: group.id, resourceProfileId: profile.id, startDate: dateAfter(2), endDate: dateAfter(9), weeklyHours: 1.25 }, status: 'SUCCEEDED', requestId: 'request-1', requestOutcome: { decisionState: 'Waiting for Tech Allocation Meeting', requestedConditions: { weeklyHours: 1.3 } } },
            { id: 'line-pending', attemptKey: 'attempt-pending', submittedConditions: { initiativeId: initiative.id, category: 'EXECUTION_PROJECT', attemptKey: 'attempt-pending', groupId: group.id, resourceProfileId: profile.id, startDate: dateAfter(2), endDate: dateAfter(9), weeklyHours: 4 }, status: 'PROCESSING' },
            { id: 'line-failed', attemptKey: 'attempt-failed', submittedConditions: { initiativeId: initiative.id, category: 'EXECUTION_PROJECT', attemptKey: 'attempt-failed', groupId: group.id, resourceProfileId: profile.id, startDate: dateAfter(2), endDate: dateAfter(9), weeklyHours: 0.04, comment: 'Original comment' }, status: 'FAILED', problem: { code: 'INVALID_HOURS', message: 'Weekly hours are invalid.', detail: 'Weekly hours are invalid.' } },
          ],
          page: emptyPage,
        },
      });
      return;
    }
    if (url.pathname.endsWith('/submissions/submission-original')) {
      await route.fulfill({ json: original });
      return;
    }
    await route.fulfill({ json: { items: [], page: emptyPage } });
  });

  await openAsUser(page);
  await expect(page.getByRole('heading', { name: 'My submissions' })).toBeVisible();
  await expect(page.getByText('Succeeded', { exact: true })).toBeVisible();
  await expect(page.getByText(/1\.3 hours per week/)).toBeVisible();
  await expect(page.getByText('Pending', { exact: true })).toBeVisible();
  await expect(page.getByText('Failed', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Correct and retry failed line/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Correct and retry pending line/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Correct and retry succeeded line/ })).toHaveCount(0);

  await page.getByRole('button', { name: /Correct and retry failed line/ }).click();
  await expect(page.getByRole('heading', { name: 'New request batch' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Initiative', exact: true })).toHaveValue(initiative.id);
  await expect(page.getByLabel('Category')).toHaveValue('EXECUTION_PROJECT');
  await expect(page.getByLabel('Weekly hours for line 1')).toHaveValue('0.04');
  await page.getByLabel('Weekly hours for line 1').fill('4,5');
  await page.getByRole('button', { name: 'Review submission' }).click();
  await page.getByRole('button', { name: 'Send 1 request' }).click();
  await expect(page.getByText(/Submission submission-retry was received/i)).toBeVisible();

  expect(createdBody).toMatchObject({ initiativeId: initiative.id, category: 'EXECUTION_PROJECT' });
  expect((createdBody?.lines as Array<Record<string, unknown>>)).toHaveLength(1);
  expect((createdBody?.lines as Array<Record<string, unknown>>)[0]).toMatchObject({
    groupId: group.id,
    resourceProfileId: profile.id,
    weeklyHours: 4.5,
    comment: 'Original comment',
  });
  expect(createdHeaders?.['idempotency-key']).not.toBe('');
  expect((createdBody?.lines as Array<Record<string, unknown>>)[0]?.attemptKey).not.toBe('attempt-failed');
});

test('recovers a submitted request that later expired and opens its retained audit without retrying it', async ({ page }) => {
  await installSelectionFixtures(page);
  const submission = {
    id: 'submission-expired',
    initiativeId: initiative.id,
    category: 'EXECUTION_PROJECT',
    receivedAt: '2026-10-20T12:00:00Z',
    lineCount: 1,
    counts: { received: 0, processing: 0, succeeded: 1, failed: 0 },
  };
  const requestId = 'request-expired';
  let submissionAttempts = 0;
  await page.route(`${apiRoot}/submissions**`, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST') {
      submissionAttempts += 1;
      await route.fulfill({ status: 202, json: submission });
      return;
    }
    if (url.pathname.endsWith('/submissions')) {
      await route.fulfill({ json: { items: [submission], page: emptyPage } });
      return;
    }
    if (url.pathname.endsWith(`/submissions/${submission.id}/lines`)) {
      await route.fulfill({ json: {
        items: [{
          id: 'line-expired',
          attemptKey: 'attempt-expired',
          submittedConditions: {
            initiativeId: initiative.id,
            category: 'EXECUTION_PROJECT',
            groupId: group.id,
            resourceProfileId: profile.id,
            startDate: dateAfter(2),
            endDate: dateAfter(9),
            weeklyHours: 8,
          },
          status: 'SUCCEEDED',
          requestId,
          receivedAt: submission.receivedAt,
          requestOutcome: {
            status: 'REMOVED',
            action: 'EXPIRED',
            reason: 'Automatically expired after more than 21 days waiting for presentation.',
            removedAt: '2026-11-10T12:00:00Z',
          },
        }],
        page: emptyPage,
      } });
      return;
    }
    if (url.pathname.endsWith(`/submissions/${submission.id}`)) {
      await route.fulfill({ json: submission });
      return;
    }
    await route.fallback();
  });
  await page.route(`${apiRoot}/request-audits/${requestId}`, async (route) => route.fulfill({ json: {
    requestId,
    events: [{
      id: 'audit-expired',
      requestId,
      action: 'EXPIRED',
      requesterSnapshot: { displayName: user.displayName },
      actorSnapshot: { displayName: 'Resource Allocation deadline worker' },
      requestSnapshot: { requestedConditions: { initiativeCode: 'ITDM-9', groupName: group.name, resourceProfileName: profile.name } },
      reason: 'Automatically expired after more than 21 days waiting for presentation.',
      occurredAt: '2026-11-10T12:00:00Z',
      correlationId: '7b944011-f8d1-483a-8a7f-784f996b4b24',
    }],
  } }));

  await openAsUser(page);
  await expect(page.getByRole('heading', { name: 'My submissions' })).toBeVisible();
  await expect(page.getByText('Request created:', { exact: false })).toContainText(requestId);
  await expect(page.getByText('Current outcome: Removed from operation · expired')).toBeVisible();
  await expect(page.getByRole('button', { name: /Correct and retry/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open retained audit record' })).toHaveAttribute('href', `/resource-allocation/?auditId=${requestId}`);
  expect(submissionAttempts).toBe(0);

  await page.getByRole('link', { name: 'Open retained audit record' }).click();
  await expect(page.getByRole('heading', { name: 'Request audit' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'EXPIRED' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Request audit' }).getByText(/more than 21 days waiting for presentation/)).toBeVisible();
  expect(submissionAttempts).toBe(0);
});

test('retries an unconfirmed envelope after reload with the same durable keys and contents', async ({ page }) => {
  await installSelectionFixtures(page);
  let requestCount = 0;
  const requestBodies: Array<Record<string, unknown>> = [];
  const idempotencyKeys: string[] = [];
  await page.route(`${apiRoot}/submissions**`, async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      requestCount += 1;
      requestBodies.push(request.postDataJSON() as Record<string, unknown>);
      idempotencyKeys.push(request.headers()['idempotency-key'] ?? '');
      if (requestCount === 1) {
        await route.abort('failed');
        return;
      }
      await route.fulfill({
        status: 202,
        headers: { location: '/api/resource-allocation/v1/submissions/submission-recovered' },
        json: { id: 'submission-recovered', receivedAt: '2026-11-20T14:00:00Z', lineCount: 1, counts: { received: 1, processing: 0, succeeded: 0, failed: 0 } },
      });
      return;
    }
    await route.fulfill({ json: { items: [], page: emptyPage } });
  });

  await openAsUser(page);
  await page.getByRole('combobox', { name: 'Initiative', exact: true }).selectOption(initiative.id);
  await page.getByLabel('Category').selectOption('EXECUTION_PROJECT');
  await page.getByLabel('Group for line 1').selectOption(group.id);
  await page.getByLabel('Resource profile for line 1').selectOption(profile.id);
  await page.getByLabel('Start date for line 1').fill(dateAfter(2));
  await page.getByLabel('End date for line 1').fill(dateAfter(9));
  await page.getByLabel('Weekly hours for line 1').fill('8');
  await page.getByRole('button', { name: 'Review submission' }).click();
  await page.getByRole('button', { name: 'Send 1 request' }).click();
  await expect(page.getByText(/receipt could not be confirmed/i)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Recover unconfirmed submission' })).toBeVisible();
  await page.getByRole('button', { name: 'Recover unconfirmed submission' }).click();

  await expect(page.getByText('submission-recovered')).toBeVisible();
  expect(requestCount).toBe(2);
  expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
  expect(requestBodies[1]).toEqual(requestBodies[0]);
});

test('displays the real worker failure reason from problem.message, problem.detail, or problem.title on failed lines', async ({ page }) => {
  await installSelectionFixtures(page);
  const submission = {
    id: 'submission-problems',
    initiativeId: initiative.id,
    category: 'EXECUTION_PROJECT',
    receivedAt: '2026-11-20T12:00:00Z',
    lineCount: 3,
    counts: { received: 0, processing: 0, succeeded: 0, failed: 3 },
  };
  await page.route(`${apiRoot}/submissions**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/submissions')) {
      await route.fulfill({ json: { items: [submission], page: emptyPage } });
      return;
    }
    if (url.pathname.endsWith(`/submissions/${submission.id}/lines`)) {
      await route.fulfill({
        json: {
          items: [
            {
              id: 'line-message',
              attemptKey: 'attempt-message',
              submittedConditions: { groupId: group.id, resourceProfileId: profile.id, startDate: dateAfter(-1), endDate: dateAfter(5), weeklyHours: 12 },
              status: 'FAILED',
              problem: { code: 'INVALID_BUSINESS_DATE', message: 'The request dates must start today or later.' },
            },
            {
              id: 'line-detail',
              attemptKey: 'attempt-detail',
              submittedConditions: { groupId: group.id, resourceProfileId: profile.id, startDate: dateAfter(2), endDate: dateAfter(5), weeklyHours: 0.04 },
              status: 'FAILED',
              problem: { code: 'INVALID_WEEKLY_HOURS', detail: 'Weekly hours must round to at least 0.1.' },
            },
            {
              id: 'line-title',
              attemptKey: 'attempt-title',
              submittedConditions: { groupId: group.id, resourceProfileId: profile.id, startDate: dateAfter(2), endDate: dateAfter(5), weeklyHours: 10 },
              status: 'FAILED',
              problem: { code: 'INELIGIBLE_REFERENCE', title: 'Selected profile is inactive.' },
            },
          ],
          page: emptyPage,
        },
      });
      return;
    }
    if (url.pathname.endsWith(`/submissions/${submission.id}`)) {
      await route.fulfill({ json: submission });
      return;
    }
    await route.fallback();
  });

  await openAsUser(page);
  await expect(page.getByText('The request dates must start today or later.')).toBeVisible();
  await expect(page.getByText('Weekly hours must round to at least 0.1.')).toBeVisible();
  await expect(page.getByText('Selected profile is inactive.')).toBeVisible();
  await expect(page.getByText('This request line failed and can be corrected.')).toHaveCount(0);
});
