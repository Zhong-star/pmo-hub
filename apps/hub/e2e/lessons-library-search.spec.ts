import { expect, test } from '@playwright/test';

test('Contributor searches and filters published Library lessons without losing state in details', async ({ page }) => {
  expect(process.env.LESSONS_LEARNED_DATABASE_URL, 'Run through test:e2e:lessons-learned to start isolated PostgreSQL.').toBeTruthy();
  const apiBase = 'http://127.0.0.1:5199/api/lessons-learned/v1';
  const stamp = Date.now();
  const targetTitle = `Gestão de riscos ${stamp}`;
  const wrongProjectTitle = `Gestão de riscos em outro projeto ${stamp}`;
  const wrongTypeTitle = `Gestão de riscos sem tipo correspondente ${stamp}`;
  const unrelatedTitle = `Capacity planning ${stamp}`;

  async function publish(title: string, projectId: string | null, projectName: string | null, lessonType: string) {
    const created = await page.request.post(`${apiBase}/lessons`, {
      headers: { 'X-PMO-Local-User-ID': 'local-developer' },
      data: { title },
    });
    expect(created.status()).toBe(201);
    const draft = await created.json();
    const submitted = await page.request.post(`${apiBase}/lessons/${draft.id}/submit`, {
      headers: { 'X-PMO-Local-User-ID': 'local-developer' },
      data: {
        version: draft.version,
        title,
        projectId,
        projectName,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: `Description for ${title}.`,
        rootCause: 'The previous result was not found before work started.',
        lessonType,
        impact: 'The team spent time repeating an earlier investigation.',
        recommendation: 'Search the Lessons Library before starting.',
        applicability: 'Use on projects with similar delivery risks.',
      },
    });
    expect(submitted.status()).toBe(200);
    const evaluation = await submitted.json();
    const approved = await page.request.post(`${apiBase}/lessons/${draft.id}/approve`, {
      headers: { 'X-PMO-Local-User-ID': 'local-pmo' },
      data: { version: evaluation.version },
    });
    expect(approved.status()).toBe(200);
    return approved.json();
  }

  await publish(targetTitle, null, null, 'Communication');
  await publish(wrongProjectTitle, 'LOCAL-PROJECT-001', 'Fictional Atlas Modernization', 'Communication');
  await publish(wrongTypeTitle, null, null, 'Future Prevention');
  await publish(unrelatedTitle, 'LOCAL-PROJECT-001', 'Fictional Atlas Modernization', 'Future Prevention');

  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-contributor');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();
  await page.getByRole('link', { name: 'Lessons Library' }).click();
  const table = page.getByRole('table', { name: 'Published lessons, newest approval first' });
  await expect(table.getByRole('row', { name: new RegExp(targetTitle) })).toBeVisible();

  const search = page.getByRole('searchbox', { name: 'Search title or ID' });
  await search.fill('gestao');
  await page.getByRole('combobox', { name: 'Project' }).selectOption('without-project');
  await page.getByRole('combobox', { name: 'Lesson type' }).selectOption('Communication');

  await expect(table.getByRole('row', { name: new RegExp(targetTitle) })).toBeVisible();
  await expect(table.getByRole('row', { name: new RegExp(wrongProjectTitle) })).toHaveCount(0);
  await expect(table.getByRole('row', { name: new RegExp(wrongTypeTitle) })).toHaveCount(0);
  const targetRow = table.getByRole('row', { name: new RegExp(targetTitle) });
  await expect(targetRow).toContainText('Local Developer');
  await expect(targetRow).toContainText(`Description for ${targetTitle}.`);
  await expect(page.getByRole('status')).toContainText('Project: No project');

  await targetRow.getByRole('button', { name: `View ${targetTitle}` }).click();
  const details = page.getByRole('dialog', { name: 'Lesson details' });
  await expect(details).toBeVisible();
  await details.getByRole('button', { name: 'Close lesson details' }).click();
  await expect(details).toHaveCount(0);
  await expect(search).toHaveValue('gestao');
  await expect(page.getByRole('combobox', { name: 'Project' })).toHaveValue('without-project');
  await expect(page.getByRole('combobox', { name: 'Lesson type' })).toHaveValue('Communication');
  await expect(table.getByRole('row', { name: new RegExp(targetTitle) })).toBeVisible();

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(search).toHaveValue('');
  await expect(page.getByRole('combobox', { name: 'Project' })).toHaveValue('');
  await expect(page.getByRole('combobox', { name: 'Lesson type' })).toHaveValue('');
  await expect(table.getByRole('row', { name: new RegExp(wrongProjectTitle) })).toBeVisible();

  await search.fill('no-matching-title');
  await expect(page.getByText('No published lessons match these filters.')).toBeVisible();
  await expect(page.getByText('No lessons have been published yet.')).toHaveCount(0);
});
