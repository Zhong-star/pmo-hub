import { expect, test } from '@playwright/test';
import { publishLesson } from './fixtures/lessons-library';

test('Contributor searches and filters published Library lessons without losing state in details', async ({ page }) => {
  expect(process.env.LESSONS_LEARNED_DATABASE_URL, 'Run through test:e2e:lessons-learned to start isolated PostgreSQL.').toBeTruthy();
  const apiBase = 'http://127.0.0.1:5199/api/lessons-learned/v1';
  const stamp = Date.now();
  const targetTitle = `Gestão de riscos ${stamp}`;
  const wrongProjectTitle = `Gestão de riscos em outro projeto ${stamp}`;
  const wrongTypeTitle = `Gestão de riscos sem tipo correspondente ${stamp}`;
  const unrelatedTitle = `Capacity planning ${stamp}`;

  await publishLesson(page.request, targetTitle, { authorId: 'local-developer', lessonType: 'Communication' });
  await publishLesson(page.request, wrongProjectTitle, {
    authorId: 'local-developer',
    projectId: 'LOCAL-PROJECT-001',
    projectName: 'Fictional Atlas Modernization',
    lessonType: 'Communication',
  });
  await publishLesson(page.request, wrongTypeTitle, { authorId: 'local-developer' });
  await publishLesson(page.request, unrelatedTitle, {
    authorId: 'local-developer',
    projectId: 'LOCAL-PROJECT-001',
    projectName: 'Fictional Atlas Modernization',
  });

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

  await targetRow.getByRole('link', { name: `View ${targetTitle}` }).click();
  const details = page.getByRole('dialog', { name: 'Published lesson details' });
  await expect(details).toBeVisible();
  await details.getByRole('button', { name: 'Close published lesson details' }).click();
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

  const sortPrefix = `Sort item ${stamp}`;
  const sortingTitles = [`${sortPrefix} Alpha`, `${sortPrefix} Beta`];
  await Promise.all(sortingTitles.map((title) => publishLesson(page.request, title, { authorId: 'local-developer', lessonType: 'Communication' })));
  const sortQuery = new URLSearchParams({ search: sortPrefix, sort: 'title', limit: '1' });
  const sortFirstResponse = await page.request.get(`${apiBase}/lessons/library?${sortQuery}`, {
    headers: { 'X-PMO-Local-User-ID': 'local-contributor' },
  });
  expect(sortFirstResponse.status()).toBe(200);
  const sortFirstPage = await sortFirstResponse.json();
  expect(sortFirstPage.items).toHaveLength(1);
  expect(sortFirstPage.items[0].title).toBe(sortingTitles[0]);
  expect(sortFirstPage.page.nextCursor).toBeTruthy();
  const sortSecondResponse = await page.request.get(
    `${apiBase}/lessons/library?${new URLSearchParams({
      search: sortPrefix,
      sort: 'title',
      limit: '1',
      cursor: sortFirstPage.page.nextCursor,
    })}`,
    { headers: { 'X-PMO-Local-User-ID': 'local-contributor' } },
  );
  expect(sortSecondResponse.status()).toBe(200);
  const sortSecondPage = await sortSecondResponse.json();
  expect(sortSecondPage.items).toHaveLength(1);
  expect(sortSecondPage.items[0].title).toBe(sortingTitles[1]);

  const pageRequests: { sort: string | null; cursor: string | null }[] = [];
  await page.route(
    (url) => url.pathname.endsWith('/api/lessons-learned/v1/lessons/library'),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('search') !== sortPrefix || url.searchParams.get('sort') !== 'title') {
        await route.continue();
        return;
      }
      const cursor = url.searchParams.get('cursor');
      pageRequests.push({ sort: url.searchParams.get('sort'), cursor });
      if (cursor === null) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: sortFirstPage.items, page: { limit: 1, nextCursor: 'title-next' } }),
        });
        return;
      }
      expect(cursor).toBe('title-next');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: sortSecondPage.items, page: { limit: 1, nextCursor: null } }),
      });
    },
  );
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await search.fill(sortPrefix);
  const sortOrderResponse = page.waitForResponse((response) => {
    if (!response.url().includes('/api/lessons-learned/v1/lessons/library?')) return false;
    const query = new URL(response.url()).searchParams;
    return query.get('search') === sortPrefix && query.get('sort') === 'title';
  });
  await page.getByRole('combobox', { name: 'Sort by' }).selectOption('title');
  await sortOrderResponse;
  const sortedTable = page.getByRole('table', { name: 'Published lessons, title order' });
  await expect(sortedTable).toBeVisible();
  const firstTitle = sortingTitles[0]!;
  const finalTitle = sortingTitles[1]!;
  await expect(sortedTable.getByRole('row', { name: new RegExp(firstTitle) })).toBeVisible();
  await expect(sortedTable.getByRole('row', { name: new RegExp(finalTitle) })).toHaveCount(0);

  await page.getByRole('button', { name: 'Load more' }).click();
  const finalRow = sortedTable.getByRole('row', { name: new RegExp(finalTitle) });
  await expect(finalRow).toBeVisible();
  await finalRow.getByRole('link', { name: `View ${finalTitle}` }).click();
  const sortingDetails = page.getByRole('dialog', { name: 'Lesson details' });
  await expect(sortingDetails).toBeVisible();
  await sortingDetails.getByRole('button', { name: 'Close published lesson details' }).click();
  await expect(sortingDetails).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Sort by' })).toHaveValue('title');
  await expect(sortedTable.getByRole('row', { name: new RegExp(firstTitle) })).toBeVisible();
  await expect(sortedTable.getByRole('row', { name: new RegExp(finalTitle) })).toBeVisible();
  const loadedRows = await sortedTable.getByRole('row').allTextContents();
  expect(loadedRows.findIndex((row) => row.includes(firstTitle))).toBeLessThan(
    loadedRows.findIndex((row) => row.includes(finalTitle)),
  );
  expect(pageRequests).toEqual([
    { sort: 'title', cursor: null },
    { sort: 'title', cursor: 'title-next' },
  ]);
});
