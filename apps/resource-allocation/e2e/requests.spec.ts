import { expect, test, type Page, type Route } from '@playwright/test';

const apiRoot = '**/api/resource-allocation/v1';
const profileStorageKey = 'pmo-hub.local-user-id';
const requestId = 'd1500c9d-76a2-4668-882a-0d32c4de1c61';
const userId = 'profile-requester';
const initiativeId = 'ff5d471a-a57f-4bfd-924e-fb1eeaa8d4f1';
const groupId = '361988f3-fbbf-48ac-9d70-86070f69fc9d';
const profileId = '229ed3e8-cc69-4982-9b2b-e786270bd9f4';
const emptyPage = { nextCursor: null, limit: 100 };

const user = {
  id: 'd9831c13-9062-4244-95ef-5ff76e261fe4',
  localUserId: userId,
  displayName: 'Taylor Requester',
  role: 'ALLOCATION_USER',
  groupId: null,
  coveredGroupIds: [],
};

function record(version = 1, comment = 'Original scope.'): Record<string, unknown> {
  return {
    id: requestId,
    requesterSnapshot: { personId: user.id, displayName: user.displayName, role: user.role },
    requestedConditions: {
      initiativeId,
      initiativeCode: 'ITDM-61',
      initiativeName: 'Resource planning',
      category: 'EXECUTION_PROJECT',
      groupId,
      groupName: 'Platform Engineering',
      resourceProfileId: profileId,
      resourceProfileName: 'API Engineering',
      startDate: '2027-01-05',
      endDate: '2027-01-28',
      weeklyHours: 12,
      comment,
    },
    decisionState: 'WAITING_FOR_PRESENTATION',
    receivedAt: '2026-11-20T12:00:00.000Z',
    stageEnteredAt: '2026-11-20T12:00:00.000Z',
    expirationDueAt: '2026-12-11T12:00:00.000Z',
    version,
  };
}

async function installAccessAndSelections(page: Page) {
  await page.route(`${apiRoot}/access`, async (route) => route.fulfill({ json: { person: user } }));
  await page.route(`${apiRoot}/initiatives**`, async (route) => route.fulfill({
    json: { items: [{ id: initiativeId, code: 'ITDM-61', name: 'Resource planning' }], page: emptyPage },
  }));
  await page.route(`${apiRoot}/groups**`, async (route) => route.fulfill({
    json: { items: [{ id: groupId, name: 'Platform Engineering' }], page: emptyPage },
  }));
  await page.route(`${apiRoot}/resource-profiles**`, async (route) => route.fulfill({
    json: { items: [{ id: profileId, name: 'API Engineering', groupId }], page: emptyPage },
  }));
  await page.route(`${apiRoot}/submissions**`, async (route) => route.fulfill({
    json: { items: [], page: { nextCursor: null, limit: 50 } },
  }));
  await page.route(`${apiRoot}/notifications**`, async (route) => route.fulfill({
    json: { items: [], page: { nextCursor: null, limit: 50 } },
  }));
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
    key: profileStorageKey,
    value: userId,
  });
}

test('opens a linked request, edits it, confirms withdrawal, and shows its retained audit', async ({ page }) => {
  await installAccessAndSelections(page);
  let currentRequest = record();
  let withdrawn = false;
  let patchHeaders: Record<string, string> | undefined;
  let patchBody: Record<string, unknown> | undefined;
  let withdrawalHeaders: Record<string, string> | undefined;
  let withdrawalBody: Record<string, unknown> | undefined;
  const withdrawalKeys: string[] = [];
  let withdrawalCount = 0;
  const audit = {
    id: '4c519a83-ed1b-4b16-84c3-121643613baf',
    requestId,
    action: 'WITHDRAWN',
    requesterSnapshot: { personId: user.id, displayName: user.displayName, role: user.role },
    actorSnapshot: { personId: user.id, displayName: user.displayName, role: user.role },
    requestSnapshot: { requestedConditions: currentRequest.requestedConditions },
    reason: 'The plan was changed.',
    occurredAt: '2026-11-20T13:00:00.000Z',
    correlationId: '71963598-2fc6-467a-89f5-6c14633e2d9f',
  };
  await page.route(`${apiRoot}/requests**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.endsWith('/requests')) {
      await route.fulfill({ json: { items: withdrawn ? [] : [currentRequest], page: { nextCursor: null, limit: 50 } } });
      return;
    }
    if (request.method() === 'GET' && url.pathname.endsWith(`/requests/${requestId}`)) {
      if (withdrawn) {
        await route.fulfill({ status: 404, contentType: 'application/problem+json', json: { status: 404, code: 'RESOURCE_NOT_FOUND', detail: 'Request was not found.' } });
        return;
      }
      await route.fulfill({ headers: { etag: `"${currentRequest.version}"` }, json: currentRequest });
      return;
    }
    if (request.method() === 'PATCH' && url.pathname.endsWith(`/requests/${requestId}`)) {
      patchHeaders = request.headers();
      patchBody = request.postDataJSON() as Record<string, unknown>;
      currentRequest = {
        ...currentRequest,
        requestedConditions: { ...(currentRequest.requestedConditions as Record<string, unknown>), ...patchBody },
        version: Number(currentRequest.version) + 1,
      };
      await route.fulfill({ headers: { etag: `"${currentRequest.version}"` }, json: currentRequest });
      return;
    }
    if (request.method() === 'POST' && url.pathname.endsWith(`/requests/${requestId}/withdrawals`)) {
      withdrawalCount += 1;
      withdrawalHeaders = request.headers();
      withdrawalKeys.push(withdrawalHeaders['idempotency-key']);
      withdrawalBody = request.postDataJSON() as Record<string, unknown>;
      if (withdrawalCount === 1) {
        // The server committed the first request, but its response was lost.
        withdrawn = true;
        await route.abort('connectionreset');
        return;
      }
      withdrawn = true;
      await route.fulfill({ json: audit });
      return;
    }
    await route.fallback();
  });
  await page.route(`${apiRoot}/request-audits/${requestId}`, async (route) => route.fulfill({ json: { requestId, events: [audit] } }));

  await page.goto(`/resource-allocation/?requestId=${requestId}`);
  await expect(page.getByRole('heading', { name: 'My requests' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'ITDM-61' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`requestId=${requestId}`));
  await page.getByRole('button', { name: 'Close detail' }).click();
  await expect(page).not.toHaveURL(/requestId=/);
  await page.getByRole('button', { name: /ITDM-61 · Resource planning/ }).click();
  await expect(page).toHaveURL(new RegExp(`requestId=${requestId}`));
  const detail = page.getByRole('region', { name: 'ITDM-61' });
  await expect(detail.getByLabel(/Resource profile/)).toHaveValue(profileId);

  const comment = page.getByRole('textbox', { name: /Comment \(optional\)/ });
  await expect(comment).toBeEnabled();
  await expect(comment).toHaveValue('Original scope.');
  await comment.fill('Updated scope before withdrawal.');
  await page.getByRole('button', { name: 'Save request changes' }).click();
  await expect(page.getByText(/original submission and expiry dates were preserved/i)).toBeVisible();
  expect(patchHeaders?.['if-match']).toBe('"1"');
  expect(patchHeaders?.['content-type']).toContain('application/merge-patch+json');
  expect(patchBody).toEqual({ comment: 'Updated scope before withdrawal.' });

  await page.getByRole('button', { name: 'Withdraw request' }).click();
  const dialog = page.getByRole('dialog', { name: 'Withdraw this request?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('operational lists');
  await dialog.getByLabel('Reason for withdrawal').fill('The plan was changed.');
  await dialog.getByRole('button', { name: 'Confirm withdrawal' }).click();
  await expect(dialog.getByRole('alert')).toContainText('could not be reached');
  await expect(dialog.getByLabel('Reason for withdrawal')).toHaveValue('The plan was changed.');
  await dialog.getByRole('button', { name: 'Confirm withdrawal' }).click();

  await expect(page.getByRole('heading', { name: 'Request audit' })).toBeVisible();
  await expect(page.locator('.request-audit-event')).toContainText('The plan was changed.');
  await expect(page.getByRole('heading', { name: 'My requests' })).toBeVisible();
  await expect(page.getByText('No operational requests match these filters.')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`auditId=${requestId}`));
  expect(withdrawalHeaders?.['if-match']).toBe('"2"');
  expect(withdrawalHeaders?.['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
  expect(withdrawalKeys).toHaveLength(2);
  expect(withdrawalKeys[1]).toBe(withdrawalKeys[0]);
  expect(withdrawalBody).toEqual({ reason: 'The plan was changed.' });
});

test('preserves edited text after temporary and version-conflict failures until the user reloads', async ({ page }) => {
  await installAccessAndSelections(page);
  let currentRequest = record();
  let patchCount = 0;
  await page.route(`${apiRoot}/requests**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.endsWith('/requests')) {
      await route.fulfill({ json: { items: [currentRequest], page: { nextCursor: null, limit: 50 } } });
      return;
    }
    if (request.method() === 'GET' && url.pathname.endsWith(`/requests/${requestId}`)) {
      await route.fulfill({ headers: { etag: `"${currentRequest.version}"` }, json: currentRequest });
      return;
    }
    if (request.method() === 'PATCH' && url.pathname.endsWith(`/requests/${requestId}`)) {
      patchCount += 1;
      if (patchCount === 1) {
        await route.fulfill({ status: 503, contentType: 'application/problem+json', json: { status: 503, code: 'DEPENDENCY_UNAVAILABLE', detail: 'The database is temporarily unavailable.' } });
        return;
      }
      currentRequest = record(2, 'A newer saved scope.');
      await route.fulfill({ status: 412, contentType: 'application/problem+json', json: { status: 412, code: 'PRECONDITION_FAILED', detail: 'The request changed.' } });
      return;
    }
    await route.fallback();
  });

  await page.goto(`/resource-allocation/?requestId=${requestId}`);
  const detail = page.getByRole('region', { name: 'ITDM-61' });
  await expect(detail).toBeVisible();
  await expect(detail.getByLabel(/Resource profile/)).toHaveValue(profileId);
  const comment = page.getByRole('textbox', { name: /Comment \(optional\)/ });
  await expect(comment).toBeEnabled();
  await comment.fill('Unsaved text must stay visible.');
  await page.getByRole('button', { name: 'Save request changes' }).click();
  await expect(page.getByRole('alert')).toContainText('The database is temporarily unavailable.');
  await expect(comment).toHaveValue('Unsaved text must stay visible.');

  await page.getByRole('button', { name: 'Save request changes' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'This request changed while' })).toContainText('Your text is preserved');
  await expect(page.getByText('A newer version is available.')).toBeVisible();
  await expect(comment).toHaveValue('Unsaved text must stay visible.');
  await page.getByRole('button', { name: 'Load current request' }).click();
  await expect(comment).toHaveValue('A newer saved scope.');
  expect(patchCount).toBe(2);
});
