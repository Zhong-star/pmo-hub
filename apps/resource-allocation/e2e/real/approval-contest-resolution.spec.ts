import { expect, test, type Locator, type Page } from '@playwright/test';
import { ensureInitiative, prepareTeam } from './support/admin-preparation';
import { addDays, businessDateAfterHours, businessToday } from './support/business-calendar';
import { localAdminUserId, openPageAs } from './support/local-identity';

// A run suffix keeps the journey's group, people, and ITDM apart from other journeys and earlier runs.
// Nothing here touches the current week, so the capacity journey's numbers stay the same.
const run = Date.now().toString(36);
const groupName = `Journey Exceptions ${run}`;
const profileName = 'Integration Engineering';
const initiativeCode = `ITDM-JB-${run.toUpperCase()}`;
const initiativeName = 'Exception path journey';
const requester = { localUserId: `journey-requester-${run}`, displayName: 'Quinn Requester', classification: 'INTERNAL' as const };
const leader = { localUserId: `journey-leader-${run}`, displayName: 'Jordan Leader' };
const deprioritizedInitiative = 'ITDM-LOCAL-001';

function queueCard(page: Page) {
  return page.getByRole('article', { name: `${initiativeCode} — ${initiativeName}` });
}

function requestDetail(page: Page) {
  return page.getByRole('region', { name: initiativeCode, exact: true });
}

/** The detail shows the decision as the visible text "Decision" followed by the state label. */
function decisionState(detail: Locator, label: string) {
  return detail.getByText(new RegExp(`^Decision\\s*${label}$`));
}

test('approves with changes, takes the contest to Pre N3, and resolves it into the requester’s allocation', async ({ browser, baseURL, request }) => {
  test.setTimeout(240_000);

  // Requested period starts a week ahead in America/Sao_Paulo. The leadership proposal moves it one
  // more week, which keeps it on or after the business date when the 72-hour response deadline expires.
  const today = businessToday();
  const requestedStart = addDays(today, 7);
  const requestedEnd = addDays(today, 27);
  const proposedStart = addDays(requestedStart, 7);
  const proposedEnd = addDays(requestedEnd, 7);
  expect(proposedStart >= businessDateAfterHours(72)).toBe(true);

  // The minimal baseline has one group and its Manager; this journey adds its own group with a
  // Supervisor (leadership) and the requester as a member, plus its own ITDM, as the local Admin.
  const team = await prepareTeam(request, {
    groupName,
    profileName,
    supervisor: leader,
    manager: { localUserId: 'local-pmo' },
    members: [requester],
  });
  await ensureInitiative(request, initiativeCode, initiativeName);
  // Three different people act on the request, so nobody decides their own request.
  expect(new Set([requester.localUserId, leader.localUserId, localAdminUserId]).size).toBe(3);
  expect(team.members[0].role).toBe('ALLOCATION_USER');

  // Requester: submits one request for their group; the PostgreSQL worker creates it.
  const requesterPage = await openPageAs(browser, baseURL, requester.localUserId);
  await requesterPage.goto('/resource-allocation/?page=new-request');
  await expect(requesterPage.getByRole('heading', { name: 'New request batch' })).toBeVisible();
  await requesterPage.getByRole('combobox', { name: 'Initiative', exact: true }).selectOption({ label: `${initiativeCode} — ${initiativeName}` });
  await requesterPage.getByLabel('Category').selectOption('EXECUTION_PROJECT');
  await requesterPage.getByLabel('Group for line 1').selectOption({ label: groupName });
  await requesterPage.getByLabel('Resource profile for line 1').selectOption({ label: profileName });
  await requesterPage.getByLabel('Start date for line 1').fill(requestedStart);
  await requesterPage.getByLabel('End date for line 1').fill(requestedEnd);
  await requesterPage.getByLabel('Weekly hours for line 1').fill('12');
  await requesterPage.getByRole('button', { name: 'Add request line' }).click();
  await requesterPage.getByRole('button', { name: 'Review submission' }).click();
  await expect(requesterPage.getByRole('heading', { name: 'Review your requests' })).toBeVisible();
  await requesterPage.getByRole('button', { name: 'Send 1 request' }).click();
  await expect(requesterPage.getByRole('status').filter({ hasText: /Submission .* was received/ })).toBeVisible();
  const created = requesterPage.getByText(/Request created:/);
  await expect(created).toBeVisible({ timeout: 90_000 });
  const requestId = (await created.textContent())?.match(/[0-9a-f-]{36}/i)?.[0];
  expect(requestId).toBeTruthy();

  // Admin: refers the request from the presentation queue to the group's leadership.
  const adminPage = await openPageAs(browser, baseURL, localAdminUserId);
  await adminPage.goto(`/resource-allocation/?queue=presentation&requestId=${requestId}`);
  await expect(adminPage.getByRole('tab', { name: 'Presentation queue' })).toHaveAttribute('aria-selected', 'true');
  await expect(queueCard(adminPage)).toContainText(`Requested by ${requester.displayName}`);
  await queueCard(adminPage).getByRole('button', { name: 'Refer to group decision' }).click();
  await expect(queueCard(adminPage)).toHaveCount(0, { timeout: 30_000 });

  // Leadership: approves with changed dates and hours and an explanation, for the requester.
  const leaderPage = await openPageAs(browser, baseURL, leader.localUserId);
  await leaderPage.goto(`/resource-allocation/?queue=team-decision&requestId=${requestId}`);
  await expect(leaderPage.getByRole('tab', { name: 'Group decision queue' })).toHaveAttribute('aria-selected', 'true');
  const leaderCard = queueCard(leaderPage);
  await expect(leaderCard).toContainText(`${requestedStart} to ${requestedEnd}`);
  await leaderCard.getByRole('button', { name: 'Approve request' }).click();
  const approval = leaderCard.getByRole('form', { name: `Approve request ${requestId}` });
  await approval.getByLabel('Eligible person').selectOption({ label: requester.displayName });
  await approval.getByLabel('Approved start date').fill(proposedStart);
  await approval.getByLabel('Approved end date').fill(proposedEnd);
  await approval.getByLabel('Approved weekly hours').fill('16');
  await expect(approval.getByText('The date or hours differ from the request. An explanation is required, and no allocation is created until the requester accepts.')).toBeVisible();
  await approval.getByLabel('Explanation').fill('The team can start one week later with more weekly hours.');
  await approval.getByRole('button', { name: 'Approve request' }).click();
  await expect(leaderCard).toHaveCount(0, { timeout: 30_000 });
  await leaderPage.context().close();

  // Requester: sees the proposal and contests it with an explanation; the request moves to Pre N3.
  await requesterPage.goto(`/resource-allocation/?requestId=${requestId}`);
  const detail = requestDetail(requesterPage);
  await expect(decisionState(detail, 'Approved with changes')).toBeVisible();
  const proposal = detail.getByRole('region', { name: 'Proposed conditions', exact: true });
  await expect(proposal).toContainText(`${proposedStart} to ${proposedEnd}`);
  await expect(proposal).toContainText('16 hours per week');
  await expect(proposal).toContainText('Approval explanation: The team can start one week later with more weekly hours.');
  await detail.getByRole('button', { name: 'Contest proposed changes' }).click();
  await detail.getByLabel('Reason for contesting').fill('The initiative needs the original start date.');
  await detail.getByRole('button', { name: 'Submit contest' }).click();
  await expect(decisionState(detail, 'Pre N3')).toBeVisible();

  // Admin: resolves the Pre N3 request by a strategy with a reason, keeping the requested period.
  await adminPage.goto('/resource-allocation/?queue=exceptions&decisionState=PRE_N3');
  await expect(adminPage.getByRole('tab', { name: 'Pre N3' })).toHaveAttribute('aria-selected', 'true');
  const exceptionCard = queueCard(adminPage);
  await expect(exceptionCard).toContainText(`Requested by ${requester.displayName}`);
  await exceptionCard.getByRole('button', { name: 'Record strategy' }).click();
  const resolution = exceptionCard.getByRole('form', { name: `Resolve exception ${requestId}` });
  await resolution.getByLabel('Resolution strategy').selectOption({ label: 'Deprioritize other demands' });
  await resolution.getByLabel('Reason').fill('Keep the original start by moving the baseline work back.');
  await resolution.getByRole('checkbox', { name: new RegExp(deprioritizedInitiative) }).check();
  await resolution.getByLabel('Resolution action').selectOption('resolve');
  await resolution.getByLabel('Eligible person').selectOption({ label: requester.displayName });
  await resolution.getByLabel('Final resource profile').selectOption({ label: profileName });
  await resolution.getByLabel('Final start date').fill(requestedStart);
  await resolution.getByLabel('Final end date').fill(requestedEnd);
  await resolution.getByLabel('Final weekly hours').fill('12');
  await resolution.getByRole('button', { name: 'Resolve and approve' }).click();
  await expect(exceptionCard).toHaveCount(0, { timeout: 30_000 });
  await adminPage.context().close();

  // Requester: the request ends Approved, and the allocation appears in their own allocations.
  await requesterPage.goto(`/resource-allocation/?requestId=${requestId}`);
  await expect(decisionState(detail, 'Approved')).toBeVisible();
  await expect(decisionState(detail, 'Approved with changes')).toHaveCount(0);
  await expect(decisionState(detail, 'Pre N3')).toHaveCount(0);
  await expect(detail.getByRole('region', { name: 'Proposed conditions', exact: true })).toHaveCount(0);
  await expect(detail.getByRole('region', { name: 'Approved conditions', exact: true })).toBeVisible();
  const allocated = detail.getByRole('region', { name: 'Approved allocation', exact: true });
  await expect(allocated).toContainText(requester.displayName);
  await expect(allocated).toContainText(`${requestedStart} to ${requestedEnd}`);
  await expect(allocated).toContainText('12 hours per week');

  await requesterPage.goto('/resource-allocation/?page=allocations');
  await expect(requesterPage.getByRole('heading', { name: 'Allocations and capacity' })).toBeVisible();
  const allocation = requesterPage.getByRole('button', { name: `View allocation ${initiativeCode} · ${initiativeName} for ${requester.displayName}` });
  await expect(allocation).toBeVisible({ timeout: 30_000 });
  await allocation.click();
  const allocationDetail = requesterPage.getByRole('region', { name: 'Allocation details' });
  await expect(allocationDetail).toContainText('From request');
  await expect(allocationDetail).toContainText(profileName);
  await expect(allocationDetail).toContainText(groupName);
  await requesterPage.context().close();
});
