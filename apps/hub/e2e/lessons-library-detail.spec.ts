import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { publishLesson } from './fixtures/lessons-library';

const lessonsPath = 'http://127.0.0.1:5199/api/lessons-learned/v1/lessons';

async function getLibraryLesson(request: APIRequestContext, lessonId: number, profileId = 'local-contributor') {
  const response = await request.get(`${lessonsPath}/library`, {
    headers: { 'X-PMO-Local-User-ID': profileId },
  });
  expect(response.status()).toBe(200);
  const lessons = await response.json() as { id: number; status: string; approvedAt: string; viewCount: number }[];
  const lesson = lessons.find(({ id }) => id === lessonId);
  expect(lesson).toBeDefined();
  return lesson!;
}

async function setProfileAndOpenLesson(page: Page, profileId: string, lessonId: number) {
  await page.goto('/lessons-learned/');
  await page.evaluate((id) => localStorage.setItem('pmo-hub.local-user-id', id), profileId);
  await page.goto(`/lessons-learned/?page=library&lesson=${lessonId}`);
}

test('published Library detail supports direct and list navigation with role checks', async ({ page, request }) => {
  expect(process.env.LESSONS_LEARNED_DATABASE_URL, 'Run through test:e2e:lessons-learned to start isolated PostgreSQL.').toBeTruthy();
  const title = `Shareable published lesson ${Date.now()}`;
  const published = await publishLesson(request, title);

  await setProfileAndOpenLesson(page, 'local-contributor', published.id);
  const authorDetails = page.getByRole('dialog', { name: 'Published lesson details' });
  await expect(authorDetails).toBeVisible();
  await expect(authorDetails.getByText('Local Contributor', { exact: true })).toBeVisible();
  await expect(authorDetails.getByText('No checklist owner had been assigned.', { exact: true })).toBeVisible();
  await expect(authorDetails.getByRole('heading', { name: 'History' })).toBeVisible();
  await expect(authorDetails.getByRole('button', { name: 'Close lesson', exact: true })).toHaveCount(0);
  expect((await getLibraryLesson(request, published.id)).viewCount).toBe(0);

  await authorDetails.getByRole('button', { name: 'Close published lesson details' }).click();
  await expect(page).toHaveURL(/\?page=library$/);
  await expect(page.getByRole('heading', { name: 'Lessons Library' })).toBeVisible();
  const listLink = page.getByRole('link', { name: `View ${title}` });
  await expect(listLink).toHaveAttribute('href', new RegExp(`page=library&lesson=${published.id}`));
  const listPanel = page.locator('main');
  await listPanel.evaluate((panel) => { panel.scrollTop = 180; });
  const scrollTopBeforeOpen = await listPanel.evaluate((panel) => panel.scrollTop);

  await listLink.click();
  await expect(page).toHaveURL(new RegExp(`page=library&lesson=${published.id}`));
  await expect(page.getByRole('dialog', { name: 'Published lesson details' })).toBeVisible();
  await expect.poll(async () => (await getLibraryLesson(request, published.id)).viewCount).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\?page=library$/);
  await expect(page.getByRole('link', { name: `View ${title}` })).toBeFocused();
  await expect.poll(() => listPanel.evaluate((panel) => panel.scrollTop)).toBe(scrollTopBeforeOpen);

  await page.getByRole('link', { name: `View ${title}` }).click();
  await expect(page.getByRole('dialog', { name: 'Published lesson details' })).toBeVisible();
  await expect.poll(async () => (await getLibraryLesson(request, published.id)).viewCount).toBe(2);
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Published lesson details' })).toBeVisible();
  await expect.poll(async () => (await getLibraryLesson(request, published.id)).viewCount).toBe(2);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\?page=library$/);
  await expect(page.getByRole('heading', { name: 'Lessons Library' })).toBeFocused();
  await page.goForward();
  await expect(page.getByRole('dialog', { name: 'Published lesson details' })).toBeVisible();
  await expect.poll(async () => (await getLibraryLesson(request, published.id)).viewCount).toBe(2);

  await setProfileAndOpenLesson(page, 'local-developer', published.id);
  const contributorDetails = page.getByRole('dialog', { name: 'Published lesson details' });
  await expect(contributorDetails).toBeVisible();
  await expect(contributorDetails.getByRole('heading', { name: 'History' })).toHaveCount(0);
  await expect(contributorDetails.getByRole('button', { name: 'Close lesson', exact: true })).toHaveCount(0);

  await setProfileAndOpenLesson(page, 'local-pmo', published.id);
  const pmoDetails = page.getByRole('dialog', { name: 'Published lesson details' });
  await expect(pmoDetails.getByRole('heading', { name: 'History' })).toBeVisible();
  await pmoDetails.getByRole('button', { name: 'Close lesson', exact: true }).click();
  await page.getByRole('dialog', { name: 'Close lesson' }).getByRole('button', { name: 'Confirm closure' }).click();
  await expect(page).toHaveURL(/\?page=library$/);
  await expect.poll(async () => getLibraryLesson(request, published.id, 'local-pmo')).toMatchObject({
    status: 'Closed',
    approvedAt: published.approvedAt,
    viewCount: 2,
  });

  await setProfileAndOpenLesson(page, 'revoked-profile', published.id);
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Published lesson details' })).toHaveCount(0);
});
