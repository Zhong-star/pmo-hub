import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { submitLessonForReview } from './fixtures/lessons-library';

const localProfilesFile = process.env.LESSONS_LEARNED_E2E_LOCAL_USERS_FILE;
if (!localProfilesFile) throw new Error('The Lessons Learned E2E profile fixture was not initialized.');

async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  for (let remaining = 80; remaining > 0; remaining -= 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

async function activateWithKeyboard(page: Page, target: Locator, key = 'Enter') {
  await expect(target).toBeEnabled();
  await tabTo(page, target);
  await page.keyboard.press(key);
}

async function fillWithKeyboard(page: Page, target: Locator, value: string) {
  await tabTo(page, target);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(value);
  await expect(target).toHaveValue(value);
}

async function selectWithKeyboard(page: Page, target: Locator, value: string) {
  await tabTo(page, target);
  const { from, to } = await target.evaluate((element, expectedValue) => {
    const select = element as HTMLSelectElement;
    const enabledOptions = [...select.options].filter((option) => !option.disabled);
    return {
      from: enabledOptions.findIndex((option) => option.selected),
      to: enabledOptions.findIndex((option) => option.value === expectedValue),
    };
  }, value);
  expect(to).toBeGreaterThanOrEqual(0);
  const key = from <= to ? 'ArrowDown' : 'ArrowUp';
  for (let remaining = Math.abs(from - to); remaining > 0; remaining -= 1) {
    await page.keyboard.press(key);
  }
  await expect(target).toHaveValue(value);
}

async function getThemeContrastRatios(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    function luminance(color: string) {
      const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
      const linear = channels.map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return .2126 * linear[0]! + .7152 * linear[1]! + .0722 * linear[2]!;
    }

    function contrast(foreground: string, background: string) {
      const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (values[0]! + .05) / (values[1]! + .05);
    }

    function backgroundOf(element: HTMLElement): string {
      const current = getComputedStyle(element).backgroundColor;
      return current === 'rgba(0, 0, 0, 0)' && element.parentElement
        ? backgroundOf(element.parentElement)
        : current;
    }

    const card = document.querySelector<HTMLElement>('.module-card, .welcome-card') ?? document.querySelector<HTMLElement>('main')!;
    const themeToggle = document.querySelector<HTMLButtonElement>('.hub-header__theme-toggle')!;
    const primaryAction = document.querySelector<HTMLElement>('.home-primary-button, .module-action')!;
    const header = document.querySelector<HTMLElement>('.hub-header')!;
    const focusedThemeToggle = document.querySelector<HTMLButtonElement>('.hub-header__theme-toggle:focus-visible');

    return {
      heading: contrast(getComputedStyle(document.querySelector('#page-title')!).color, backgroundOf(card)),
      intro: contrast(getComputedStyle(document.querySelector('.intro, .profile-bar h2')!).color, backgroundOf(card)),
      primaryAction: contrast(getComputedStyle(primaryAction).color, getComputedStyle(primaryAction).backgroundColor),
      themeToggleIcon: contrast(getComputedStyle(themeToggle).color, backgroundOf(themeToggle)),
      headerBrand: contrast(getComputedStyle(document.querySelector('.hub-header__brand')!).color, getComputedStyle(header).backgroundColor),
      focus: focusedThemeToggle ? contrast(getComputedStyle(focusedThemeToggle).outlineColor, getComputedStyle(header).backgroundColor) : null,
    };
  });
}

test('direct Lessons Learned URL works before profile selection and can return to profile entry', async ({ page }) => {
  const sharedHeaderResponses: { url: string; status: number }[] = [];
  page.on('response', (response) => {
    if (response.url().includes('HubHeader')) {
      sharedHeaderResponses.push({ url: response.url(), status: response.status() });
    }
  });
  const response = await page.goto('/lessons-learned');

  expect(response?.status()).toBe(200);
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('link', { name: 'PMO Hub' })).toHaveAttribute('href', '/');
  await expect(page.getByRole('heading', { name: 'Access check' })).toBeVisible();
  await expect(page.getByText(/No local profile is selected/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Select a local profile' })).toHaveAttribute('href', '/');
  await expect(page.getByRole('link', { name: 'PMO Hub' })).toHaveAttribute('href', '/');

  const moduleResources = await page.evaluate(() => performance.getEntriesByType('resource').map(({ name }) => name));
  expect(moduleResources.some((resource) => resource.includes('/lessons-learned/src/main.tsx'))).toBe(true);
  expect(moduleResources.every((resource) => !resource.includes(':5174'))).toBe(true);
  expect(sharedHeaderResponses.some(({ url, status }) => url.includes('HubHeader.tsx') && status === 200)).toBe(true);
  expect(sharedHeaderResponses.some(({ url, status }) => url.includes('HubHeader.css') && status === 200)).toBe(true);

  await page.getByRole('link', { name: 'Select a local profile', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Local profile' })).toBeVisible();
});

test('Contributor creates a title-only lesson and completes it from the edit modal after reload', async ({ page }) => {
  expect(process.env.LESSONS_LEARNED_DATABASE_URL, 'Run through test:e2e:lessons-learned to start isolated PostgreSQL.').toBeTruthy();
  const title = `Issue 20 draft ${Date.now()}`;

  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-developer');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();

  await page.getByRole('link', { name: 'My Submissions' }).click();
  await expect(page.getByRole('heading', { name: 'My Submissions' })).toBeVisible();
  const createLessonButton = page.getByRole('button', { name: 'Create lesson' });
  await createLessonButton.click();
  await expect(page.getByRole('dialog', { name: 'Create lesson' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Title' }).fill(title);
  await page.getByRole('button', { name: 'Save Draft' }).click();
  await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Edit lesson' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Close$/ })).toBeVisible();
  await page.getByRole('button', { name: /^Close$/ }).click();
  await expect(createLessonButton).toBeFocused();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'My Submissions' })).toBeVisible();
  await page.getByRole('button', { name: `Reopen ${title}` }).click();
  await expect(page.getByRole('dialog', { name: 'Edit lesson' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue(title);
  await page.getByRole('button', { name: 'Submit for PMO Review' }).click();
  await expect(page.getByRole('alert', { name: 'Submission errors' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Title' })).toBeEditable();
  await page.getByRole('combobox', { name: 'Project category' }).selectOption('Technology');
  await page.getByRole('combobox', { name: 'Project phase' }).selectOption('Execution');
  await page.getByRole('textbox', { name: 'Situation observed' }).fill('The release handover did not include the latest runbook.');
  await page.getByRole('dialog', { name: 'Edit lesson' }).getByRole('combobox', { name: 'Lesson type' }).selectOption('Future Prevention');
  await page.getByRole('textbox', { name: 'Impact' }).fill('Operators spent extra time locating the current procedure.');
  await page.getByRole('textbox', { name: 'Recommendation' }).fill('Review the runbook before each release.');
  await page.getByRole('textbox', { name: 'Applicability' }).fill('Apply to software releases with an on-call handover.');
  await page.getByRole('button', { name: 'Submit for PMO Review' }).click();
  const rootCause = page.getByRole('textbox', { name: 'Root cause' });
  await expect(rootCause).toHaveAttribute('aria-invalid', 'true');
  await expect(rootCause).toHaveAccessibleDescription(/Root cause is required for Future Prevention/);
  await rootCause.fill('The team had no shared release checklist.');
  await page.getByRole('button', { name: 'Save Draft' }).click();
  await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Root cause' })).toHaveValue('The team had no shared release checklist.');

  await page.getByRole('button', { name: 'Submit for PMO Review' }).click();
  await expect(page.getByRole('status')).toContainText('Lesson submitted for PMO review.');
  await expect(page.getByRole('textbox', { name: 'Title' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save Draft' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Submit for PMO Review' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close editor' }).click();
  const viewButton = page.getByRole('button', { name: `View ${title}` });
  await expect(viewButton).toBeFocused();
  await viewButton.click();
  const details = page.getByRole('dialog', { name: 'Lesson details' });
  await expect(details.getByText('PMOEvaluation', { exact: true })).toBeVisible();
  await expect(details.getByText('Submitted', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
  await expect(viewButton).toBeFocused();
});

test('browser Back and Forward confirm dirty editor navigation and do not restore closed overlays', async ({ page }) => {
  expect(process.env.LESSONS_LEARNED_DATABASE_URL, 'Run through test:e2e:lessons-learned to start isolated PostgreSQL.').toBeTruthy();
  const title = `Issue 25 history guard ${Date.now()}`;

  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-pmo');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  await page.getByRole('link', { name: 'My Submissions' }).click();
  await page.getByRole('button', { name: 'Create lesson' }).click();
  await page.getByRole('textbox', { name: 'Title' }).fill(title);
  await page.getByRole('button', { name: 'Save Draft' }).click();
  await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Close$/ }).click();
  await page.getByRole('link', { name: 'PMO Drafts' }).click();
  await page.evaluate(() => window.history.back());
  await expect(page.getByRole('heading', { name: 'My Submissions' })).toBeVisible();
  await page.getByRole('button', { name: `Reopen ${title}` }).click();
  const editor = page.getByRole('dialog', { name: 'Edit lesson' });
  const situation = editor.getByRole('textbox', { name: 'Situation observed' });
  await situation.fill('Unsaved history text stays in the editor.');

  for (const direction of ['forward', 'back'] as const) {
    const dialogPromise = page.waitForEvent('dialog');
    await page.evaluate((historyDirection) => window.history[historyDirection](), direction);
    const dialog = await dialogPromise;
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toBe('Discard your unsaved changes?');
    await dialog.dismiss();
    await expect(editor).toBeVisible();
    await expect(situation).toHaveValue('Unsaved history text stays in the editor.');
    await expect(page.getByRole('heading', { name: 'My Submissions' })).toBeVisible();
  }

  const acceptedBack = page.waitForEvent('dialog');
  await page.evaluate(() => window.history.back());
  await (await acceptedBack).accept();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(editor).toHaveCount(0);

  await page.evaluate(() => window.history.forward());
  await expect(page.getByRole('heading', { name: 'My Submissions' })).toBeVisible();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('FT-015, FT-028: Contributor cancels an Open lesson by keyboard and can reopen its Archived details after reload', async ({ page }) => {
  expect(process.env.LESSONS_LEARNED_DATABASE_URL, 'Run through test:e2e:lessons-learned to start isolated PostgreSQL.').toBeTruthy();
  const title = `Issue 23 cancelled lesson ${Date.now()}`;
  await page.setViewportSize({ width: 1280, height: 480 });

  await page.goto('/');
  await selectWithKeyboard(page, page.getByRole('combobox', { name: 'Local profile' }), 'local-developer');
  await activateWithKeyboard(page, page.getByRole('button', { name: 'Continue' }));
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await activateWithKeyboard(page, page.getByRole('link', { name: 'Open Lessons Learned' }));
  await activateWithKeyboard(page, page.getByRole('link', { name: 'My Submissions' }));

  await activateWithKeyboard(page, page.getByRole('button', { name: 'Create lesson' }));
  await fillWithKeyboard(page, page.getByRole('textbox', { name: 'Title' }), title);
  await activateWithKeyboard(page, page.getByRole('button', { name: 'Save Draft' }));
  await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
  const draftRow = page.getByRole('listitem').filter({ hasText: title });
  const draftIdText = await draftRow.locator('.draft-meta').textContent();
  const lessonId = Number(draftIdText?.match(/#(\d+)/)?.[1]);
  expect(lessonId).toBeGreaterThan(0);
  await activateWithKeyboard(page, page.getByRole('button', { name: /^Close editor$/ }));
  const cancel = page.getByRole('button', { name: `Cancel ${title}` });
  await activateWithKeyboard(page, cancel);
  const cancelDialog = page.getByRole('dialog', { name: 'Cancel lesson' });
  await expect(cancelDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(cancelDialog).toBeHidden();
  await expect(cancel).toBeFocused();
  await activateWithKeyboard(page, cancel);
  await fillWithKeyboard(page, cancelDialog.getByRole('textbox', { name: 'Reason for cancellation' }), 'The project scope changed.');
  await activateWithKeyboard(page, cancelDialog.getByRole('button', { name: 'Confirm cancellation' }));

  await expect(page.getByText(`Lesson #${lessonId} · Archived`)).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Search title or ID' });
  await search.fill(title.slice(0, 18));
  await page.getByRole('combobox', { name: 'Project' }).selectOption('without-project');
  await page.getByRole('combobox', { name: 'Status' }).selectOption('Archived');
  await expect(page.getByRole('button', { name: `View ${title}` })).toBeVisible();
  const viewButton = page.getByRole('button', { name: `View ${title}` });
  await viewButton.scrollIntoViewIfNeeded();
  const panel = page.getByRole('main');
  const scrollBeforeOpen = await panel.evaluate((element) => element.scrollTop);
  const buttonTopBeforeOpen = await viewButton.evaluate((button) => button.getBoundingClientRect().top);
  await viewButton.focus();
  await page.keyboard.press('Enter');
  const details = page.getByRole('dialog', { name: 'Lesson details' });
  await expect(details.getByText('Archived', { exact: true })).toBeVisible();
  await expect(details.getByText(title, { exact: true })).toBeVisible();
  const history = details.locator('.submission-history');
  await expect(history.getByRole('heading', { name: 'History' })).toBeVisible();
  await expect(history.getByText('Created', { exact: true })).toBeVisible();
  await expect(history.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(history.getByText('Cancellation reason: The project scope changed.')).toBeVisible();
  await expect(details.getByRole('button', { name: /^Reopen / })).toHaveCount(0);
  const closeIcon = details.getByRole('button', { name: 'Close lesson details' });
  const closeDetails = details.getByRole('button', { name: 'Close details' });
  await expect(closeIcon).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(closeDetails).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(closeIcon).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
  await expect(viewButton).toBeFocused();
  await expect(page.getByRole('listitem').filter({ hasText: title })).toBeVisible();
  await expect(viewButton).toHaveText('View');
  await expect(search).toHaveValue(title.slice(0, 18));
  await expect(page.getByRole('combobox', { name: 'Project' })).toHaveValue('without-project');
  await expect(page.getByRole('combobox', { name: 'Status' })).toHaveValue('Archived');
  await expect(page.getByRole('combobox', { name: 'Lesson type' })).toHaveValue('');
  expect(await panel.evaluate((element) => element.scrollTop)).toBe(scrollBeforeOpen);
  expect(await viewButton.evaluate((button) => button.getBoundingClientRect().top)).toBe(buttonTopBeforeOpen);
  await search.fill(String(lessonId));
  await expect(page.getByRole('button', { name: `View ${title}` })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'My Submissions' })).toBeVisible();
  await expect(page.getByText(`Lesson #${lessonId} · Archived`)).toBeVisible();
  await page.getByRole('button', { name: `View ${title}` }).click();
  await expect(page.getByRole('dialog', { name: 'Lesson details' }).getByText('Archived', { exact: true })).toBeVisible();
});

test('catalog link opens in the same tab and reload, back, and module return preserve the profile', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-developer');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();

  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  expect(page.context().pages()).toHaveLength(1);
  await expect(page).toHaveURL(/\/lessons-learned\/?$/);
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.getByText('Welcome, Local Developer')).toBeVisible();
  await expect(page.getByText('Contributor', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');

  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome, Local Developer' })).toBeVisible();

  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to PMO Hub', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome, Local Developer' })).toBeVisible();

  await expect(page.getByRole('link', { name: 'Open Tech Resource Allocation' })).toHaveAttribute('href', '/resource-allocation');
});

test('PMO can enter the module catalog and open Lessons Learned with the PMO role', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('banner')).toBeVisible();
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-pmo');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome, Local PMO' })).toBeVisible();

  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Local PMO' })).toBeVisible();
  await expect(page.getByText('Welcome, Local PMO')).toBeVisible();
  await expect(page.getByText('PMO', { exact: true })).toBeVisible();
});

test('PMO Drafts lists, edits, and cancels Contributor lessons with their history', async ({ page }) => {
  expect(process.env.LESSONS_LEARNED_DATABASE_URL, 'Run through test:e2e:lessons-learned to start isolated PostgreSQL.').toBeTruthy();
  const editedTitle = `Issue 25 PMO edit ${Date.now()}`;
  const cancelledTitle = `Issue 25 PMO cancel ${Date.now()}`;
  const assistedTitle = `${editedTitle} assisted`;

  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-developer');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  await page.getByRole('link', { name: 'My Submissions' }).click();

  for (const title of [editedTitle, cancelledTitle]) {
    await page.getByRole('button', { name: 'Create lesson' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(title);
    await page.getByRole('button', { name: 'Save Draft' }).click();
    await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^Close$/ }).click();
  }

  await page.getByRole('button', { name: 'Local Developer' }).click();
  await page.getByRole('button', { name: 'Change profile' }).click();
  await expect(page.getByRole('combobox', { name: 'Local profile' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-pmo');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  await page.getByRole('link', { name: 'PMO Drafts' }).click();
  await expect(page.getByRole('heading', { name: 'PMO Drafts' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Status' })).toHaveValue('Open');

  const editedRow = page.getByRole('row', { name: new RegExp(editedTitle) });
  await expect(editedRow.getByText('local-developer')).toBeVisible();
  await expect(editedRow.getByText('No project')).toBeVisible();
  await expect(editedRow.getByText('Not specified')).toBeVisible();
  await editedRow.getByRole('button', { name: `View ${editedTitle}` }).click();
  const firstDetails = page.getByRole('dialog', { name: 'Lesson details' });
  await expect(firstDetails.getByText(editedTitle, { exact: true })).toBeVisible();
  await expect(firstDetails.getByText('Author', { exact: true }).locator('..')).toContainText('local-developer');
  await expect(firstDetails.getByRole('region', { name: 'History' }).getByText('Created', { exact: true })).toBeVisible();
  await firstDetails.getByRole('button', { name: 'Close details' }).click();

  await page.getByRole('button', { name: `Edit ${editedTitle}` }).click();
  const editor = page.getByRole('dialog', { name: 'Edit lesson' });
  await expect(editor.getByRole('button', { name: 'Submit for PMO Review' })).toHaveCount(0);
  await editor.getByRole('textbox', { name: 'Title' }).fill(assistedTitle);
  await editor.getByRole('button', { name: 'Save Draft' }).click();
  await expect(editor.getByText('Draft saved.', { exact: true })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(assistedTitle) })).toBeVisible();
  await editor.getByRole('button', { name: /^Close$/ }).click();
  await page.getByRole('button', { name: `View ${assistedTitle}` }).click();
  const assistedDetails = page.getByRole('dialog', { name: 'Lesson details' });
  await expect(assistedDetails.getByText('Author', { exact: true }).locator('..')).toContainText('local-developer');
  await expect(assistedDetails.getByText('Updated by', { exact: true }).locator('..')).toContainText('local-pmo');
  await assistedDetails.getByRole('button', { name: 'Close details' }).click();

  await page.getByRole('button', { name: `Cancel ${cancelledTitle}` }).click();
  const cancellation = page.getByRole('dialog', { name: 'Cancel lesson' });
  await cancellation.getByRole('textbox', { name: 'Reason for cancellation' }).fill('The author approved closing this draft.');
  await cancellation.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(page.getByRole('button', { name: `Cancel ${cancelledTitle}` })).toHaveCount(0);

  await page.getByRole('combobox', { name: 'Status' }).selectOption('');
  const archivedRow = page.getByRole('row', { name: new RegExp(cancelledTitle) });
  await expect(archivedRow.getByText('Archived')).toBeVisible();
  await expect(archivedRow.getByRole('button', { name: `Edit ${cancelledTitle}` })).toHaveCount(0);
  await expect(archivedRow.getByRole('button', { name: `Cancel ${cancelledTitle}` })).toHaveCount(0);
  await archivedRow.getByRole('button', { name: `View ${cancelledTitle}` }).click();
  const archivedDetails = page.getByRole('dialog', { name: 'Lesson details' });
  await expect(archivedDetails.getByText('Archived', { exact: true })).toBeVisible();
  await expect(archivedDetails.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(archivedDetails.getByText('Cancellation reason: The author approved closing this draft.')).toBeVisible();
});

test('a stale draft ETag preserves unsaved text until the author explicitly reloads', async ({ page }) => {
  const profile = 'local-developer';
  const headers = { 'X-PMO-Local-User-ID': profile };
  const title = `Conditional draft ${Date.now()}`;
  const drafts = '/api/lessons-learned/v1/lessons';
  const created = await page.request.post(drafts, { headers, data: { title } });
  expect(created.status()).toBe(201);
  const lesson = await created.json();
  await page.addInitScript((id) => localStorage.setItem('pmo-hub.local-user-id', id), profile);
  await page.goto('/lessons-learned/?page=my-submissions');
  await page.getByRole('button', { name: `Reopen ${title}` }).click();
  const editor = page.getByRole('dialog', { name: 'Edit lesson' });
  const input = editor.getByRole('textbox', { name: 'Title' });
  await input.fill('Unsaved work');

  const path = `${drafts}/${lesson.id}`;
  const otherEdit = await page.request.patch(path, { headers, data: { title: 'Saved in another tab', version: lesson.version } });
  expect(otherEdit.status()).toBe(200);
  const stale = page.waitForResponse((response) => response.url().endsWith(path) && response.request().method() === 'PATCH');
  await editor.getByRole('button', { name: 'Save Draft' }).click();
  const response = await stale;
  expect(response.status()).toBe(412);
  expect(response.request().headers()['if-match']).toBeTruthy();
  const reload = editor.getByRole('button', { name: 'Reload latest version' });
  await expect(reload).toBeVisible();
  await expect(input).toHaveValue('Unsaved work');
  page.once('dialog', (dialog) => dialog.accept());
  await reload.click();
  await expect(input).toHaveValue('Saved in another tab');
});

test('FT-009, FT-011–013, FT-016, FT-020–025, FT-028, FT-030: submits, returns, publishes, collaborates and closes across roles by keyboard', async ({ page }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(8_000);
  expect(process.env.LESSONS_LEARNED_DATABASE_URL, 'Run through test:e2e:lessons-learned to start isolated PostgreSQL.').toBeTruthy();
  const title = `Stage 3 review ${Date.now()}`;
  const guidance = 'Describe how the next team can verify the handover.';
  const comment = 'The checklist also helped the operations team.';
  const reply = 'We will add the checklist to the handover kit.';
  const enterModule = async (profile: string, currentProfile?: string) => {
    if (currentProfile) {
      await activateWithKeyboard(page, page.getByRole('button', { name: currentProfile }));
      await activateWithKeyboard(page, page.getByRole('button', { name: 'Change profile' }));
    } else {
      await page.goto('/');
    }
    await selectWithKeyboard(page, page.getByRole('combobox', { name: 'Local profile' }), profile);
    await activateWithKeyboard(page, page.getByRole('button', { name: 'Continue' }));
    await activateWithKeyboard(page, page.getByRole('link', { name: 'Open Lessons Learned' }));
    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  };
  const openEvaluation = async () => {
    await activateWithKeyboard(page, page.getByRole('link', { name: 'Evaluation Queue' }));
    await activateWithKeyboard(page, page.getByRole('button', { name: `View ${title}` }));
  };
  const details = page.getByRole('dialog', { name: 'Lesson details' });

  await enterModule('local-developer');
  await activateWithKeyboard(page, page.getByRole('link', { name: 'My Submissions' }));
  await activateWithKeyboard(page, page.getByRole('button', { name: 'Create lesson' }));
  await fillWithKeyboard(page, page.getByRole('textbox', { name: 'Title' }), title);
  await activateWithKeyboard(page, page.getByRole('button', { name: 'Save Draft' }));
  const editor = page.getByRole('dialog', { name: 'Edit lesson' });
  await selectWithKeyboard(page, editor.getByRole('combobox', { name: 'Project category' }), 'Technology');
  await selectWithKeyboard(page, editor.getByRole('combobox', { name: 'Project phase' }), 'Execution');
  await selectWithKeyboard(page, editor.getByRole('combobox', { name: 'Lesson type' }), 'Success to Repeat');
  await fillWithKeyboard(page, editor.getByRole('textbox', { name: 'Situation observed' }), 'The team used a release checklist.');
  await fillWithKeyboard(page, editor.getByRole('textbox', { name: 'Impact' }), 'The handover had fewer omissions.');
  await fillWithKeyboard(page, editor.getByRole('textbox', { name: 'Recommendation' }), 'Repeat the release checklist.');
  await fillWithKeyboard(page, editor.getByRole('textbox', { name: 'Applicability' }), 'Use for software releases.');
  await activateWithKeyboard(page, editor.getByRole('button', { name: 'Submit for PMO Review' }));
  await expect(page.getByRole('status')).toContainText('Lesson submitted for PMO review.');
  await activateWithKeyboard(page, page.getByRole('button', { name: 'Close editor' }));

  await enterModule('local-pmo', 'Local Developer');
  await openEvaluation();
  await activateWithKeyboard(page, details.getByRole('button', { name: 'Return for changes' }));
  await fillWithKeyboard(page, page.getByRole('textbox', { name: 'Guidance for author' }), guidance);
  await page.route('**/lessons/*/return', (route) => route.abort(), { times: 1 });
  await activateWithKeyboard(page, page.getByRole('button', { name: 'Confirm return' }));
  await expect(page.getByRole('alert')).toContainText('The lesson could not be returned.');
  await expect(page.getByRole('textbox', { name: 'Guidance for author' })).toHaveValue(guidance);
  await activateWithKeyboard(page, page.getByRole('button', { name: 'Confirm return' }));
  await expect(page.getByRole('button', { name: `View ${title}` })).toHaveCount(0);

  await enterModule('local-developer', 'Local PMO');
  await expect(page.getByRole('region', { name: 'Returned lessons' })).toContainText(title);
  await expect(page.getByRole('button', { name: /^Notifications/ })).toBeVisible();
  await activateWithKeyboard(page, page.getByRole('link', { name: 'My Submissions' }));
  await expect(page.getByText(guidance, { exact: true })).toBeVisible();
  await activateWithKeyboard(page, page.getByRole('button', { name: `Reopen ${title}` }));
  await fillWithKeyboard(page, editor.getByRole('textbox', { name: 'Recommendation' }), 'Ask the next team to sign off on the checklist.');
  await page.route('**/lessons/*/submit', (route) => route.abort(), { times: 1 });
  await activateWithKeyboard(page, editor.getByRole('button', { name: 'Submit for PMO Review' }));
  await expect(editor.getByRole('alert')).toContainText('The lesson could not be submitted.');
  await expect(editor.getByRole('textbox', { name: 'Recommendation' })).toHaveValue('Ask the next team to sign off on the checklist.');
  await activateWithKeyboard(page, editor.getByRole('button', { name: 'Submit for PMO Review' }));
  await expect(page.getByRole('status')).toContainText('Lesson submitted for PMO review.');
  await activateWithKeyboard(page, page.getByRole('button', { name: 'Close editor' }));

  await enterModule('local-pmo', 'Local Developer');
  await openEvaluation();
  await activateWithKeyboard(page, details.getByRole('button', { name: 'Edit lesson', exact: true }));
  await fillWithKeyboard(page, editor.getByRole('textbox', { name: 'Impact' }), 'The checklist made handover steps explicit.');
  await activateWithKeyboard(page, editor.getByRole('button', { name: 'Save Draft' }));
  await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
  await activateWithKeyboard(page, editor.getByRole('button', { name: 'Close editor' }));
  await activateWithKeyboard(page, page.getByRole('button', { name: `View ${title}` }));
  await activateWithKeyboard(page, details.getByRole('button', { name: 'Approve and publish' }));
  await activateWithKeyboard(page, page.getByRole('button', { name: 'Confirm approval' }));
  await expect(page.getByRole('button', { name: `View ${title}` })).toHaveCount(0);

  await enterModule('local-contributor', 'Local PMO');
  await activateWithKeyboard(page, page.getByRole('link', { name: 'Lessons Library' }));
  await activateWithKeyboard(page, page.getByRole('link', { name: `View ${title}` }));
  const status = details.getByText('Status', { exact: true }).locator('..').getByRole('definition');
  await expect(status).toHaveText('Approved');
  await expect(details.getByText('Ask the next team to sign off on the checklist.')).toBeVisible();
  await expect(details.getByText('The checklist made handover steps explicit.')).toBeVisible();
  await expect(details.getByRole('heading', { name: 'History' })).toHaveCount(0);
  await expect(details.getByRole('button', { name: 'Hide comment' })).toHaveCount(0);

  const vote = details.getByRole('button', { name: `Vote for ${title} (0)` });
  await page.route('**/lessons/*/vote', (route) => route.abort(), { times: 1 });
  await activateWithKeyboard(page, vote);
  await expect(details.getByRole('alert')).toContainText(/vote/i);
  await expect(vote).toHaveAttribute('aria-pressed', 'false');
  await activateWithKeyboard(page, vote);
  const removeVote = details.getByRole('button', { name: `Remove vote for ${title} (1)` });
  await expect(removeVote).toHaveAttribute('aria-pressed', 'true');
  await activateWithKeyboard(page, removeVote);
  await expect(vote).toHaveAttribute('aria-pressed', 'false');
  await activateWithKeyboard(page, vote);
  await expect(removeVote).toBeEnabled();

  await expect(details.getByText('No comments yet.')).toBeVisible();
  await fillWithKeyboard(page, details.getByRole('textbox', { name: 'Add a comment' }), comment);
  await page.route('**/lessons/*/comments', (route) => route.abort(), { times: 1 });
  await activateWithKeyboard(page, details.getByRole('button', { name: 'Post comment' }));
  await expect(details.getByRole('alert')).toContainText('Your comment could not be posted.');
  await expect(details.getByRole('textbox', { name: 'Add a comment' })).toHaveValue(comment);
  await expect(details.getByText('No comments yet.')).toBeVisible();
  await activateWithKeyboard(page, details.getByRole('button', { name: 'Post comment' }));
  await expect(details.getByText(comment, { exact: true })).toBeVisible();
  await expect(details.getByRole('button', { name: 'Post comment' })).toBeEnabled();
  await activateWithKeyboard(page, details.getByRole('button', { name: 'Close published lesson details' }));
  await expect(details).toBeHidden();
  await expect(page.getByRole('list', { name: 'Most Voted Lessons podium' })).toContainText(title);
  await activateWithKeyboard(page, page.getByRole('button', { name: 'Top Contributors' }));
  await activateWithKeyboard(page, page.getByRole('list', { name: 'Top Contributors podium' }).getByRole('button', { name: 'Local Developer' }));
  await expect(page.getByRole('heading', { name: 'Local Developer', exact: true })).toBeVisible();
  await expect(page.getByText(title, { exact: true })).toBeVisible();

  await enterModule('local-developer', 'Local Contributor');
  const summary = page.getByRole('region', { name: 'Unread notifications summary' });
  await expect(summary).toContainText(title);
  await activateWithKeyboard(page, page.getByRole('button', { name: /^Notifications/ }));
  const alerts = page.getByRole('region', { name: 'Notifications', exact: true });
  const commentNotification = alerts.getByRole('listitem').filter({ hasText: 'New comment' }).filter({ hasText: title });
  const markRead = commentNotification.getByRole('button', { name: /Mark notification/ });
  await page.route('**/notifications/*/read', (route) => route.abort(), { times: 1 });
  await activateWithKeyboard(page, markRead);
  await expect(alerts.getByRole('alert')).toContainText('Could not mark the notification as read.');
  await expect(commentNotification.getByText('Unread', { exact: true })).toBeVisible();
  await activateWithKeyboard(page, markRead);
  await expect(commentNotification.getByText('Read', { exact: true })).toBeVisible();
  const openCommentNotification = commentNotification.getByRole('button', { name: /Open lesson/ });
  await activateWithKeyboard(page, openCommentNotification);
  await expect(details.getByText(comment, { exact: true })).toBeVisible();
  await activateWithKeyboard(page, details.getByRole('button', { name: 'Reply', exact: true }));
  await fillWithKeyboard(page, details.getByRole('textbox', { name: 'Write a reply' }), reply);
  await page.route('**/comments/*/replies', (route) => route.abort(), { times: 1 });
  await activateWithKeyboard(page, details.getByRole('button', { name: 'Post reply' }));
  await expect(details.getByRole('alert')).toContainText('Your reply could not be posted.');
  await expect(details.getByRole('textbox', { name: 'Write a reply' })).toHaveValue(reply);
  await activateWithKeyboard(page, details.getByRole('button', { name: 'Post reply' }));
  await expect(details.getByText(reply, { exact: true })).toBeVisible();
  await expect(details.getByRole('button', { name: 'Post comment' })).toBeEnabled();
  await activateWithKeyboard(page, details.getByRole('button', { name: 'Close lesson details' }));
  await expect(details).toBeHidden();

  await enterModule('local-pmo', 'Local Developer');
  await activateWithKeyboard(page, page.getByRole('link', { name: 'PMO Dashboard' }));
  await expect(page.getByRole('heading', { name: 'PMO Dashboard' })).toBeVisible();
  await activateWithKeyboard(page, page.getByRole('button', { name: /Recently Approved/ }));
  await expect(page.getByRole('button', { name: `View ${title}` })).toBeVisible();
  await activateWithKeyboard(page, page.getByRole('link', { name: 'Lessons Library' }));
  const libraryLesson = page.getByRole('link', { name: `View ${title}` });
  await activateWithKeyboard(page, libraryLesson);
  await activateWithKeyboard(page, details.getByRole('button', { name: 'Hide comment', exact: true }));
  await fillWithKeyboard(page, details.getByRole('textbox', { name: 'Reason for hiding' }), 'Keep discussion focused on the handover.');
  await page.route('**/comments/*/hide', (route) => route.abort(), { times: 1 });
  await activateWithKeyboard(page, details.getByRole('button', { name: 'Confirm hide' }));
  await expect(details.getByRole('alert')).toContainText('The comment could not be hidden.');
  await expect(details.getByRole('textbox', { name: 'Reason for hiding' })).toHaveValue('Keep discussion focused on the handover.');
  await activateWithKeyboard(page, details.getByRole('button', { name: 'Confirm hide' }));
  await expect(details.getByText('Comment hidden by PMO')).toBeVisible();
  await expect(details.getByText(reply, { exact: true })).toBeVisible();
  await activateWithKeyboard(page, details.getByRole('checkbox', { name: 'Show hidden comments' }), 'Space');
  await expect(details.getByText('Keep discussion focused on the handover.')).toBeVisible();
  await activateWithKeyboard(page, details.getByRole('button', { name: 'Close lesson', exact: true }));
  await activateWithKeyboard(page, page.getByRole('button', { name: 'Confirm closure' }));
  await expect(page.getByRole('row').filter({ has: libraryLesson })).toContainText('Closed');

  await enterModule('local-contributor', 'Local PMO');
  await activateWithKeyboard(page, page.getByRole('link', { name: 'Lessons Library' }));
  await activateWithKeyboard(page, libraryLesson);
  await expect(status).toHaveText('Closed');
  await expect(details.getByRole('heading', { name: 'History' })).toHaveCount(0);

  await page.goto('/lessons-learned/?page=pmo-dashboard');
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  await page.goto('/lessons-learned/?page=evaluation-queue');
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
});

test('FT-014, FT-028: PMO rejects by keyboard, and other Contributors cannot read the archived lesson', async ({ page, request }) => {
  const title = `Rejected review ${Date.now()}`;
  const reason = 'The example is specific to an individual incident.';
  const lesson = await submitLessonForReview(request, title);
  await page.addInitScript(() => localStorage.setItem('pmo-hub.local-user-id', 'local-pmo'));
  await page.goto('/lessons-learned/?page=evaluation-queue');

  const reject = page.getByRole('button', { name: `Reject ${title}` });
  await activateWithKeyboard(page, reject);
  const dialog = page.getByRole('dialog', { name: 'Reject lesson' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(reject).toBeFocused();
  await activateWithKeyboard(page, reject);
  const reasonField = dialog.getByRole('textbox', { name: 'Reason for rejection' });
  const confirm = dialog.getByRole('button', { name: 'Confirm rejection' });
  await activateWithKeyboard(page, confirm);
  await expect(reasonField).toHaveAttribute('aria-invalid', 'true');
  await fillWithKeyboard(page, reasonField, reason);
  await activateWithKeyboard(page, confirm);
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: `Reject ${title}` })).toHaveCount(0);

  const path = `http://127.0.0.1:5199/api/lessons-learned/v1/lessons/${lesson.id}`;
  const denied = await request.get(path, { headers: { 'X-PMO-Local-User-ID': 'local-developer' } });
  expect(denied.status()).toBe(404);
  const archived = await request.get(path, { headers: { 'X-PMO-Local-User-ID': 'local-contributor' } });
  expect(archived.status()).toBe(200);
  await expect(archived.json()).resolves.toMatchObject({
    status: 'Archived',
    history: expect.arrayContaining([expect.objectContaining({ eventType: 'Rejected', reason })]),
  });
});

test('FT-027–028, FT-030: keyboard draft creation recovers from failure and restores focus', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(() => localStorage.setItem('pmo-hub.local-user-id', 'local-contributor'));
  await page.goto('/lessons-learned/?page=my-submissions');
  const title = `Keyboard recovery ${Date.now()}`;
  const open = page.getByRole('button', { name: 'Create lesson' });
  await tabTo(page, open);
  await expect(open).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Create lesson' });
  const titleField = dialog.getByRole('textbox', { name: 'Title' });
  await expect(titleField).toBeFocused();
  const close = dialog.getByRole('button', { name: 'Close editor' });
  const save = dialog.getByRole('button', { name: 'Save Draft' });
  await page.keyboard.press('Shift+Tab');
  await expect(close).toBeFocused();
  const closeBounds = await close.boundingBox();
  expect(closeBounds?.width).toBeGreaterThanOrEqual(44);
  expect(closeBounds?.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.insertText(title);

  const requestGate = Promise.withResolvers<void>();
  await page.route('**/api/lessons-learned/v1/lessons', async (route) => {
    await requestGate.promise;
    await route.abort();
  }, { times: 1 });
  await tabTo(page, save);
  await page.keyboard.press('Enter');
  try {
    await expect(dialog.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Draft saved.', { exact: true })).toHaveCount(0);
  } finally {
    requestGate.resolve();
  }
  await expect(dialog.getByRole('alert')).toContainText(/could not be saved/i);
  await expect(titleField).toHaveValue(title);

  page.once('dialog', (confirmation) => confirmation.dismiss());
  await page.keyboard.press('Escape');
  await expect(titleField).toHaveValue(title);
  await tabTo(page, save);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Edit lesson' }).getByRole('status')).toHaveText('Draft saved.');
  await page.keyboard.press('Escape');
  await expect(open).toBeFocused();
});

test('PMO edits a lesson during evaluation without changing its author or queue position', async ({ page }) => {
  expect(process.env.LESSONS_LEARNED_DATABASE_URL, 'Run through test:e2e:lessons-learned to start isolated PostgreSQL.').toBeTruthy();
  const firstTitle = `Issue 31 first evaluation ${Date.now()}`;
  const secondTitle = `Issue 31 second evaluation ${Date.now()}`;
  const correctedTitle = `${firstTitle} reviewed`;

  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-developer');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  await page.getByRole('link', { name: 'My Submissions' }).click();

  async function submitCompleteLesson(title: string) {
    await page.getByRole('button', { name: 'Create lesson' }).click();
    const createEditor = page.getByRole('dialog', { name: 'Create lesson' });
    await createEditor.getByRole('textbox', { name: 'Title' }).fill(title);
    await createEditor.getByRole('button', { name: 'Save Draft' }).click();
    const editor = page.getByRole('dialog', { name: 'Edit lesson' });
    await expect(editor.getByText('Draft saved.', { exact: true })).toBeVisible();
    await editor.getByRole('combobox', { name: 'Project category' }).selectOption('Technology');
    await editor.getByRole('combobox', { name: 'Project phase' }).selectOption('Execution');
    await editor.getByRole('textbox', { name: 'Situation observed' }).fill('The release handover omitted the current runbook.');
    await editor.getByRole('textbox', { name: 'Root cause' }).fill('No checklist owner had been assigned.');
    await editor.getByRole('combobox', { name: 'Lesson type' }).selectOption('Future Prevention');
    await editor.getByRole('textbox', { name: 'Impact' }).fill('The release team repeated verification work.');
    await editor.getByRole('textbox', { name: 'Recommendation' }).fill('Assign an owner to review the checklist.');
    await editor.getByRole('textbox', { name: 'Applicability' }).fill('Use for releases with shared operational ownership.');
    await editor.getByRole('button', { name: 'Save Draft' }).click();
    await expect(editor.getByText('Draft saved.', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Submit for PMO Review' }).click();
    const submittedLesson = page.getByRole('dialog', { name: 'Lesson submitted' });
    await expect(submittedLesson.getByRole('status')).toContainText('Lesson submitted for PMO review.');
    await submittedLesson.getByRole('button', { name: 'Close editor' }).click();
  }

  await submitCompleteLesson(firstTitle);
  await submitCompleteLesson(secondTitle);

  await page.getByRole('button', { name: 'Local Developer' }).click();
  await page.getByRole('button', { name: 'Change profile' }).click();
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-pmo');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  await page.getByRole('link', { name: 'Evaluation Queue' }).click();

  const queue = page.getByRole('table', { name: 'Lessons awaiting PMO evaluation, oldest submission first' });
  await page.getByRole('searchbox', { name: 'Search title or ID' }).fill('Issue 31');
  const rows = queue.getByRole('row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText(firstTitle);
  await expect(rows.nth(2)).toContainText(secondTitle);
  await rows.nth(1).getByRole('button', { name: `View ${firstTitle}` }).click();
  const details = page.getByRole('dialog', { name: 'Lesson details' });
  await expect(details.getByText('PMOEvaluation', { exact: true })).toBeVisible();
  await details.getByRole('button', { name: 'Edit lesson' }).click();

  const evaluationEditor = page.getByRole('dialog', { name: 'Edit lesson' });
  await expect(evaluationEditor.getByRole('button', { name: 'Submit for PMO Review' })).toHaveCount(0);
  await evaluationEditor.getByRole('textbox', { name: 'Title' }).fill(correctedTitle);
  await evaluationEditor.getByRole('textbox', { name: 'Impact' }).fill('PMO clarified the operational impact for review.');
  await evaluationEditor.getByRole('button', { name: 'Save Draft' }).click();
  await expect(evaluationEditor.getByText('Draft saved.', { exact: true })).toBeVisible();
  await evaluationEditor.getByRole('button', { name: /^Close$/ }).click();

  await expect(rows.nth(1)).toContainText(correctedTitle);
  await expect(rows.nth(2)).toContainText(secondTitle);
  await rows.nth(1).getByRole('button', { name: `View ${correctedTitle}` }).click();
  const updatedDetails = page.getByRole('dialog', { name: 'Lesson details' });
  await expect(updatedDetails.getByText('Author', { exact: true }).locator('..')).toContainText('local-developer');
  await expect(updatedDetails.getByText('Updated by', { exact: true }).locator('..')).toContainText('local-pmo');
  await expect(updatedDetails.getByRole('region', { name: 'History' }).getByText('Submitted', { exact: true })).toBeVisible();
  await expect(updatedDetails.getByRole('region', { name: 'History' }).getByText('Edited', { exact: true })).toHaveCount(0);
});

test('change profile from Lessons Learned returns to selection and browser history never restores a stale profile', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-pmo');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  await expect(page.getByText('Welcome, Local PMO')).toBeVisible();

  await page.getByRole('button', { name: 'Local PMO' }).click();
  await page.getByRole('button', { name: 'Change profile' }).click();
  await expect(page.getByRole('combobox', { name: 'Local profile' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).not.toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('pmo-hub.local-user-id'))).toBeNull();

  await page.goBack();
  await expect(page).toHaveURL(/\/lessons-learned\/?$/);
  await expect(page.getByRole('heading', { name: 'Access check' })).toBeVisible();
  await expect(page.getByText('Welcome, Local PMO')).not.toBeVisible();
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByText(/No local profile is selected/)).toBeVisible();

  await page.goForward();
  await expect(page.getByRole('combobox', { name: 'Local profile' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-contributor');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, Local Contributor' })).toBeVisible();

  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  await expect(page.getByText('Welcome, Local Contributor')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Local Contributor' })).toBeVisible();
  await expect(page.getByText('Welcome, Local PMO')).not.toBeVisible();

  await page.getByRole('link', { name: 'PMO Hub', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await page.goBack();
  await expect(page.getByText('Welcome, Local Contributor')).toBeVisible();
  await expect(page.getByText('Welcome, Local PMO')).not.toBeVisible();
});

test.describe('change profile from PMO moderation destinations', () => {
  const pmoDestinations = {
    'evaluation-queue': {
      name: 'Evaluation Queue',
      urlPattern: /\/lessons-learned\/\?page=evaluation-queue$/,
      apiPath: '/api/lessons-learned/v1/lessons/evaluation-queue',
    },
    'pmo-management': {
      name: 'PMO Dashboard',
      urlPattern: /\/lessons-learned\/\?page=pmo-dashboard$/,
      apiPath: '/api/lessons-learned/v1/pmo/dashboard',
    },
  } as const;
  const pmoDraftsDestination = {
    name: 'PMO Drafts',
    urlPattern: /\/lessons-learned\/\?page=pmo-drafts$/,
    apiPath: '/api/lessons-learned/v1/lessons/pmo-drafts',
  } as const;
  type PmoDestination = typeof pmoDestinations[keyof typeof pmoDestinations] | typeof pmoDraftsDestination;
  const profileSelectionUrl = /^http:\/\/(?:localhost|127\.0\.0\.1):\d+\/(\?.*)?$/;

  async function openPmoDestination(page: Page, destination: PmoDestination) {
    await page.goto('/');
    await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-pmo');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();

    await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
    await expect(page.getByText('Welcome, Local PMO')).toBeVisible();

    await page.getByRole('link', { name: destination.name }).click();
    await expect(page).toHaveURL(destination.urlPattern);
    await expect(page.getByRole('heading', { name: destination.name })).toBeVisible();
  }

  async function changeProfileFromPmoHeader(page: Page) {
    await page.getByRole('button', { name: 'Local PMO' }).click();
    await page.getByRole('button', { name: 'Change profile' }).click();
    await page.waitForURL(profileSelectionUrl);
    await expect(page.getByRole('combobox', { name: 'Local profile' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Module catalog' })).not.toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('pmo-hub.local-user-id'))).toBeNull();
  }

  async function selectProfileAndVerifyCatalog(
    page: Page,
    profileId: string,
    expectedDisplayName: string,
  ) {
    await page.getByRole('combobox', { name: 'Local profile' }).selectOption(profileId);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
    await expect(page.getByRole('heading', { name: `Welcome, ${expectedDisplayName}` })).toBeVisible();
  }

  async function expectNoFurtherPmoRequests(
    page: Page,
    destination: PmoDestination,
    action: () => Promise<void>,
  ) {
    const calls: string[] = [];
    const listener = (request: { url: () => string }) => {
      if (request.url().includes(destination.apiPath)) calls.push(request.url());
    };
    page.on('request', listener);
    try {
      await action();
    } finally {
      page.off('request', listener);
    }
    expect(calls).toEqual([]);
  }

  async function returnToAccessCheckBeforeProfileSelection(
    page: Page,
    destination: PmoDestination,
    privateLessonTitle: string,
  ) {
    await changeProfileFromPmoHeader(page);

    await expectNoFurtherPmoRequests(page, destination, async () => {
      await page.goBack();
      await expect(page).toHaveURL(destination.urlPattern);
      await expect(page.getByRole('heading', { name: 'Access check' })).toBeVisible();
      await expect(page.getByText(/No local profile is selected/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Local PMO' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: `View ${privateLessonTitle}` })).toHaveCount(0);
    });

    await page.goForward();
    await expect(page).toHaveURL(profileSelectionUrl);
    await expect(page.getByRole('combobox', { name: 'Local profile' })).toBeVisible();
  }

  async function switchProfileAndReturnToDestination(
    page: Page,
    destination: PmoDestination,
    profileId: string,
    expectedDisplayName: string,
    { profileSelectionAlreadyOpen = false }: { profileSelectionAlreadyOpen?: boolean } = {},
  ) {
    if (!profileSelectionAlreadyOpen) await changeProfileFromPmoHeader(page);
    else await expect(page).toHaveURL(profileSelectionUrl);

    await selectProfileAndVerifyCatalog(page, profileId, expectedDisplayName);

    await expectNoFurtherPmoRequests(page, destination, async () => {
      await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
      await expect(page).toHaveURL(/\/lessons-learned\/?$/);
      await expect(page.getByRole('heading', { name: /^(Home|Access denied)$/ })).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(profileSelectionUrl);
      await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(destination.urlPattern);
    });
  }

  test('Evaluation Queue returns to Access check before selection and shows Access denied to Contributor on history back', async ({ page, request }) => {
    expect(process.env.LESSONS_LEARNED_DATABASE_URL, 'Run through test:e2e:lessons-learned to start isolated PostgreSQL.').toBeTruthy();
    const submittedTitle = `Issue 18 evaluation queue ${Date.now()}`;
    await submitLessonForReview(request, submittedTitle, { authorId: 'local-developer' });

    const destination = pmoDestinations['evaluation-queue'];
    await openPmoDestination(page, pmoDestinations['evaluation-queue']);
    await expect(page.getByRole('button', { name: `View ${submittedTitle}` })).toBeVisible();

    await returnToAccessCheckBeforeProfileSelection(page, destination, submittedTitle);
    await switchProfileAndReturnToDestination(page, destination, 'local-contributor', 'Local Contributor', {
      profileSelectionAlreadyOpen: true,
    });

    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('The PMO Review Queue is restricted to PMO moderators.');
    await expect(page.getByRole('link', { name: 'Back to Home' })).toBeVisible();
    await expect(page.getByRole('banner').getByRole('button', { name: 'Local Contributor' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Local PMO' })).toHaveCount(0);
    await expect(page.getByText(submittedTitle)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Evaluation Queue' })).toHaveCount(0);
  });

  test('PMO Dashboard returns to Access check before selection and denies access to Contributor without leaking data on history back', async ({ page, request }) => {
    expect(process.env.LESSONS_LEARNED_DATABASE_URL, 'Run through test:e2e:lessons-learned to start isolated PostgreSQL.').toBeTruthy();
    const dashboardTitle = `Issue 18 dashboard ${Date.now()}`;
    await submitLessonForReview(request, dashboardTitle, { authorId: 'local-developer' });

    const destination = pmoDestinations['pmo-management'];
    const summaryGroup = page.getByRole('group', { name: /Operational summary/i });
    await openPmoDestination(page, pmoDestinations['pmo-management']);
    await expect(summaryGroup).toBeVisible();
    await expect(page.getByRole('button', { name: `View ${dashboardTitle}` })).toBeVisible();

    await returnToAccessCheckBeforeProfileSelection(page, destination, dashboardTitle);
    await switchProfileAndReturnToDestination(page, destination, 'local-contributor', 'Local Contributor', {
      profileSelectionAlreadyOpen: true,
    });

    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('The PMO Dashboard is restricted to PMO moderators.');
    await expect(page.getByRole('link', { name: 'Back to Home' })).toBeVisible();
    await expect(page.getByRole('banner').getByRole('button', { name: 'Local Contributor' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Local PMO' })).toHaveCount(0);
    await expect(page.getByText(dashboardTitle)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'PMO Dashboard' })).toHaveCount(0);
    await expect(summaryGroup).toHaveCount(0);
  });

  test('PMO Drafts opens Module catalog for Contributor and falls back to Home on history back', async ({ page }) => {
    expect(process.env.LESSONS_LEARNED_DATABASE_URL, 'Run through test:e2e:lessons-learned to start isolated PostgreSQL.').toBeTruthy();
    const draftTitle = `Issue 18 pmo draft ${Date.now()}`;
    const created = await page.request.post('/api/lessons-learned/v1/lessons', {
      headers: { 'X-PMO-Local-User-ID': 'local-developer' },
      data: { title: draftTitle },
    });
    expect(created.status()).toBe(201);

    await openPmoDestination(page, pmoDraftsDestination);
    await expect(page.getByRole('button', { name: `View ${draftTitle}` })).toBeVisible();

    await switchProfileAndReturnToDestination(page, pmoDraftsDestination, 'local-contributor', 'Local Contributor');

    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
    await expect(page.getByText('Welcome, Local Contributor')).toBeVisible();
    await expect(page.getByRole('banner').getByRole('button', { name: 'Local Contributor' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Local PMO' })).toHaveCount(0);
    await expect(page.getByText(draftTitle)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'PMO Drafts' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'PMO Drafts' })).toHaveCount(0);
  });

  test('switching from Evaluation Queue to a profile without module access opens Module catalog and denies module access on history back', async ({ page, request }) => {
    expect(process.env.LESSONS_LEARNED_DATABASE_URL, 'Run through test:e2e:lessons-learned to start isolated PostgreSQL.').toBeTruthy();
    const submittedTitle = `Issue 18 module access ${Date.now()}`;
    await submitLessonForReview(request, submittedTitle, { authorId: 'local-developer' });

    const destination = pmoDestinations['evaluation-queue'];
    await openPmoDestination(page, pmoDestinations['evaluation-queue']);
    await expect(page.getByRole('button', { name: `View ${submittedTitle}` })).toBeVisible();
    await switchProfileAndReturnToDestination(page, destination, 'local-no-access', 'Local User Without Access');

    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Your local profile does not have access to Lessons Learned.');
    await expect(page.getByRole('banner').getByRole('button', { name: 'local-no-access' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Local PMO' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Lessons Learned' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: `View ${submittedTitle}` })).toHaveCount(0);
  });
});

test('header theme icon is keyboard operable, readable, and shared across both apps in the current tab', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pmo-hub.local-user-id', 'local-contributor'));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  const themeToggle = (target = page) => target.getByRole('banner').getByRole('button', { name: 'Dark theme' });
  const expectThemeToggle = async (theme: 'light' | 'dark', target = page) => {
    const toggle = themeToggle(target);
    await expect(toggle).toHaveAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    await expect(toggle).toHaveAttribute('data-theme-icon', theme === 'dark' ? 'moon' : 'sun');
    await expect(toggle).toHaveAttribute('title', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    await expect(toggle.locator('svg')).toHaveCount(1);
  };
  const toggleWithKeyboard = async () => {
    await page.getByRole('banner').getByRole('link', { name: 'PMO Hub', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(themeToggle()).toBeFocused();
    await expect(themeToggle()).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('Enter');
  };
  const assertReadableTheme = async () => {
    const ratios = await getThemeContrastRatios(page);
    const { focus, themeToggleIcon, ...textAndControlRatios } = ratios;
    for (const [element, ratio] of Object.entries(textAndControlRatios)) {
      expect(ratio, `${element} contrast`).toBeGreaterThanOrEqual(4.5);
    }
    expect(themeToggleIcon, 'theme icon contrast').toBeGreaterThanOrEqual(3);
    if (focus !== null) expect(focus).toBeGreaterThanOrEqual(3);
  };

  await expect(page.getByRole('group', { name: 'Color theme' })).toHaveCount(0);
  await expectThemeToggle('light');
  await assertReadableTheme();

  await toggleWithKeyboard();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectThemeToggle('dark');
  await expect(page.getByRole('link', { name: 'Open Lessons Learned' }).locator('.module-action')).toHaveCSS('background-color', 'rgb(24, 104, 219)');
  await assertReadableTheme();

  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectThemeToggle('dark');
  await assertReadableTheme();
  await toggleWithKeyboard();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expectThemeToggle('light');
  await expect(page.locator('.home-primary-button')).toHaveCSS('background-color', 'rgb(24, 104, 219)');
  await assertReadableTheme();

  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expectThemeToggle('light');
  await toggleWithKeyboard();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.reload();
  await expectThemeToggle('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  const freshTab = await page.context().newPage();
  await freshTab.addInitScript(() => localStorage.setItem('pmo-hub.local-user-id', 'local-contributor'));
  await freshTab.goto('/');
  await expect(freshTab.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
  await expectThemeToggle('light', freshTab);
});

test('migrates the existing Lessons Learned theme preference to the shared session preference', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pmo-hub.local-user-id', 'local-contributor');
    sessionStorage.setItem('pmo-hub.lessons-learned.theme', 'dark');
  });
  await page.goto('/lessons-learned');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Local Contributor' }).click();
  await expect(page.getByRole('group', { name: 'Color theme' }).getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => sessionStorage.getItem('pmo-hub.theme'))).toBe('dark');
  expect(await page.evaluate(() => sessionStorage.getItem('pmo-hub.lessons-learned.theme'))).toBeNull();
});

test('catalog entry checks the Contributor identity before rendering Home', async ({ page }) => {
  let releaseCheck!: () => void;
  const accessCheck = new Promise<void>((resolve) => { releaseCheck = resolve; });
  await page.route('**/api/lessons-learned/v1/home', async (route) => {
    await accessCheck;
    await route.continue();
  });

  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-contributor');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();

  await expect(page.getByRole('status')).toContainText('local-contributor');
  await expect(page.getByRole('heading', { name: 'Home' })).not.toBeVisible();
  releaseCheck();

  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.getByText('Welcome, Local Contributor')).toBeVisible();
  await expect(page.getByText('Contributor', { exact: true })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Lessons Learned navigation' })).toBeVisible();
});

test('direct URL checks the PMO identity before rendering its Home', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pmo-hub.local-user-id', 'local-pmo'));
  let releaseCheck!: () => void;
  const accessCheck = new Promise<void>((resolve) => { releaseCheck = resolve; });
  await page.route('**/api/lessons-learned/v1/home', async (route) => {
    await accessCheck;
    await route.continue();
  });

  await page.goto('/lessons-learned');

  await expect(page.getByRole('status')).toContainText('local-pmo');
  await expect(page.getByRole('heading', { name: 'Home' })).not.toBeVisible();
  releaseCheck();

  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.getByText('Welcome, Local PMO')).toBeVisible();
  await expect(page.getByText('PMO', { exact: true })).toBeVisible();
});

test('a profile without module access sees Access denied', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-no-access');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();

  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Contact the PMO');
  await expect(page.getByRole('navigation', { name: 'Lessons Learned' })).toHaveCount(0);
});

test('a direct module URL denies a saved Hub profile without module access', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pmo-hub.local-user-id', 'local-no-access'));
  await page.goto('/lessons-learned');

  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('button', { name: 'local-no-access' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Contact the PMO');
  await expect(page.getByRole('navigation', { name: 'Lessons Learned' })).toHaveCount(0);
  await expect(page.getByText(/No local profile is selected/)).toHaveCount(0);
});

test('duplicate module profiles show a configuration error', async ({ page }) => {
  const originalConfig = readFileSync(localProfilesFile, 'utf8');
  const profiles = JSON.parse(originalConfig) as { id: string; displayName: string; role: string }[];

  try {
    writeFileSync(localProfilesFile, JSON.stringify([
      ...profiles,
      { id: 'local-pmo', displayName: 'Duplicate PMO', role: 'LESSONS_USER' },
    ]));

    await page.goto('/');
    await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-pmo');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('link', { name: 'Open Lessons Learned' }).click();

    await expect(page.getByRole('heading', { name: 'Access configuration error' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Contact the responsible team');
  } finally {
    writeFileSync(localProfilesFile, originalConfig, 'utf8');
  }
});

test('a temporary access check failure can be retried', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/lessons-learned/v1/home', async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Unavailable' }) });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-contributor');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();

  await expect(page.getByRole('heading', { name: 'Access check temporarily unavailable' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
});

test('revoking access blocks the next protected Home request after the tab regains focus', async ({ page }) => {
  const originalConfig = readFileSync(localProfilesFile, 'utf8');
  const profiles = JSON.parse(originalConfig) as { id: string; displayName: string; role: string }[];

  try {
    await page.goto('/');
    await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-contributor');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
    await expect(page.getByText('Welcome, Local Contributor')).toBeVisible();

    writeFileSync(localProfilesFile, JSON.stringify(profiles.filter(({ id }) => id !== 'local-contributor')));
    const revalidation = page.waitForResponse((response) =>
      response.url().includes('/api/lessons-learned/v1/home') && response.status() === 403,
    );
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await revalidation;

    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    await expect(page.getByText('Welcome, Local Contributor')).not.toBeVisible();
  } finally {
    writeFileSync(localProfilesFile, originalConfig, 'utf8');
  }
});

test('module screen stays open and offers return when its API is unavailable', async ({ page }) => {
  await page.goto('http://127.0.0.1:5182');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-developer');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();

  await expect(page.getByRole('heading', { name: 'Access check temporarily unavailable' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Retry');
  await page.getByRole('link', { name: 'PMO Hub' }).click();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
});

test('Hub proxy matches complete module prefixes only', async ({ page }) => {
  await page.goto('/lessons-learned-extra');
  await expect(page.getByRole('heading', { name: 'Welcome to PMO Hub' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lessons Learned' })).not.toBeVisible();

  const unrelatedApiStatus = await page.evaluate(async () => {
    const response = await fetch('/api/lessons-learned-extra/v1/health');
    return response.status;
  });
  expect(unrelatedApiStatus).toBe(404);
});
