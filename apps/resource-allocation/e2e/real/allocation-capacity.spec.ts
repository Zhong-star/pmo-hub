import { expect, test, type Page } from '@playwright/test';
import { ensureCapacity, prepareTeam } from './support/admin-preparation';
import { addDays, currentWeekMonday, displayedDate } from './support/business-calendar';
import { openPageAs } from './support/local-identity';

// A run suffix keeps the journey's group and people apart from other journeys and earlier runs.
const run = Date.now().toString(36);
const groupName = `Journey Operations ${run}`;
const profileName = 'Platform Support';
const member = { localUserId: `journey-member-${run}`, displayName: 'Riley Member', classification: 'INTERNAL' as const };
const colleague = { localUserId: `journey-colleague-${run}`, displayName: 'Casey Colleague', classification: 'INTERNAL' as const };
const supervisor = { localUserId: `journey-supervisor-${run}`, displayName: 'Avery Supervisor' };

function creation(page: Page) {
  return page.getByRole('region', { name: 'Record an allocation' });
}

function rowFor(page: Page, header: string) {
  return page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: header, exact: true }) });
}

async function startRecording(page: Page) {
  await page.getByRole('button', { name: 'Record allocation', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Record an allocation' })).toBeVisible();
}

async function confirmRecording(page: Page, expectedStatus: string) {
  await page.getByRole('button', { name: 'Review allocation' }).click();
  await expect(page.getByRole('heading', { name: 'Review before recording' })).toBeVisible();
  await page.getByRole('button', { name: 'Record allocation', exact: true }).last().click();
  await expect(page.getByRole('status').filter({ hasText: expectedStatus })).toBeVisible({ timeout: 30_000 });
}

test('records operational work, Vacation, and a direct allocation, then compares the week against capacity', async ({ browser, baseURL, request }) => {
  test.setTimeout(180_000);

  // Monday to Friday of the current week in America/Sao_Paulo; past days are allowed for allocations.
  const monday = currentWeekMonday();
  const wednesday = addDays(monday, 2);
  const thursday = addDays(monday, 3);
  const friday = addDays(monday, 4);
  const nextFriday = addDays(monday, 11);

  // The minimal baseline has one group and its Manager; this journey adds its own group, leadership,
  // a second person, and FTE capacity in force for the whole week, through the API as the local Admin.
  const team = await prepareTeam(request, {
    groupName,
    profileName,
    supervisor,
    manager: { localUserId: 'local-pmo' },
    members: [member, colleague],
  });
  await ensureCapacity(request, {
    groupId: team.group.id,
    resourceProfileId: team.profile.id,
    classification: 'INTERNAL',
    effectiveDate: addDays(monday, -7),
    fte: 2,
  });

  // User: own Routine / Support for two weeks at 10 h/week, then Vacation on Thursday and Friday.
  const memberPage = await openPageAs(browser, baseURL, member.localUserId);
  await memberPage.goto('/resource-allocation/?page=allocations');
  await startRecording(memberPage);
  await expect(memberPage.getByRole('radio', { name: 'A person in my scope' })).toHaveCount(0);
  await creation(memberPage).getByLabel('Category').selectOption({ label: 'Routine / Support' });
  await creation(memberPage).getByLabel('Resource profile').selectOption({ label: profileName });
  await creation(memberPage).getByLabel('Start date').fill(monday);
  await creation(memberPage).getByLabel('End date (inclusive)').fill(nextFriday);
  await creation(memberPage).getByLabel('Weekly hours').fill('10');
  await creation(memberPage).getByLabel('Activity description').fill('Platform on-call rotation');
  await confirmRecording(memberPage, `Routine / Support was recorded for ${member.displayName}.`);
  const ownDetail = memberPage.getByRole('region', { name: 'Allocation details' });
  await expect(ownDetail).toContainText('Own allocation');
  await expect(ownDetail).toContainText(profileName);
  await expect(ownDetail).toContainText('Platform on-call rotation');

  await startRecording(memberPage);
  await creation(memberPage).getByLabel('Category').selectOption({ label: 'Vacation' });
  await expect(creation(memberPage).getByLabel('Resource profile')).toHaveCount(0);
  await creation(memberPage).getByLabel('Start date').fill(thursday);
  await creation(memberPage).getByLabel('End date (inclusive)').fill(friday);
  await confirmRecording(memberPage, `Vacation was recorded for ${member.displayName}.`);
  await expect(memberPage.getByRole('region', { name: 'Allocation details' })).toContainText('Vacation');
  await memberPage.context().close();

  // Leadership: direct Training for the colleague, Monday to Wednesday at 20 h/week.
  const leaderPage = await openPageAs(browser, baseURL, supervisor.localUserId);
  await leaderPage.goto('/resource-allocation/?page=allocations');
  await startRecording(leaderPage);
  await leaderPage.getByRole('radio', { name: 'A person in my scope' }).check();
  await creation(leaderPage).getByLabel(/^Group/).selectOption({ label: groupName });
  await creation(leaderPage).getByLabel(/^Person/).selectOption({ label: colleague.displayName });
  await creation(leaderPage).getByLabel('Category').selectOption({ label: 'Training' });
  await creation(leaderPage).getByLabel('Resource profile').selectOption({ label: profileName });
  await creation(leaderPage).getByLabel('Start date').fill(monday);
  await creation(leaderPage).getByLabel('End date (inclusive)').fill(wednesday);
  await creation(leaderPage).getByLabel('Weekly hours').fill('20');
  await creation(leaderPage).getByLabel('Activity description').fill('Incident response course');
  await confirmRecording(leaderPage, `Training was recorded for ${colleague.displayName}.`);
  const directDetail = leaderPage.getByRole('region', { name: 'Allocation details' });
  await expect(directDetail).toContainText('Direct allocation');
  await expect(directDetail).toContainText(colleague.displayName);

  // Weekly comparison for the current week. Load counts weeklyHours / 5 per weekday of overlap:
  // Routine / Support 10 / 5 × 5 = 10 h, Training 20 / 5 × 3 = 12 h, so 22 h planned; Vacation
  // 40 / 5 × 2 = 16 h kept apart; capacity 2 FTE × 8 h × 5 days = 80 h; utilization 22 / 80 = 27.5%.
  await leaderPage.getByRole('link', { name: 'Capacity', exact: true }).first().click();
  await expect(leaderPage.getByRole('heading', { name: 'Weekly comparison' })).toBeVisible();
  await expect(leaderPage.getByRole('button', { name: 'Current week' })).toBeDisabled();
  const week = leaderPage.getByRole('region', { name: `Week of ${displayedDate(monday)} – ${displayedDate(addDays(monday, 6))}` });
  await expect(week).toBeVisible();

  const groupRow = rowFor(leaderPage, groupName);
  await expect(groupRow).toContainText('22.0 h');
  await expect(groupRow).toContainText('80.0 h · 2.0 FTE known');

  const internalRow = rowFor(leaderPage, `${profileName} · Internal`);
  await expect(internalRow).toContainText('22.0 h');
  await expect(internalRow).toContainText('80.0 h · 2.0 FTE');
  await expect(internalRow).toContainText('27.5%');

  await expect(rowFor(leaderPage, `Vacation · ${groupName}`)).toContainText('16.0 h (not deducted from capacity)');
  await leaderPage.context().close();
});
