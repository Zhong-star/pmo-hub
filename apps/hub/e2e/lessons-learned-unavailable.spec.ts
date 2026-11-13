import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';

test('an upstream document error gets a fallback while asset errors pass through', async ({ page }) => {
  const server = createServer((_request, response) => {
    if (_request.url?.includes('forbidden')) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('upstream forbidden');
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('upstream 404');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(5199, '127.0.0.1', resolve);
  });

  try {
    const response = await page.goto('/lessons-learned');
    expect(response?.status()).toBe(503);
    await expect(page.getByRole('heading', { name: 'Lessons Learned is unavailable' })).toBeVisible();

    const assetResult = await page.evaluate(async () => {
      const assetResponse = await fetch('/lessons-learned/assets/missing.js');
      return { status: assetResponse.status, body: await assetResponse.text() };
    });
    expect(assetResult.status).toBe(404);
    expect(assetResult.body).toBe('upstream 404');

    const forbiddenEntry = await page.goto('/lessons-learned?forbidden');
    expect(forbiddenEntry?.status()).toBe(503);
    await expect(page.getByRole('link', { name: 'Return to PMO Hub' })).toBeVisible();

    const forbiddenResponse = await page.goto('/lessons-learned/forbidden');
    expect(forbiddenResponse?.status()).toBe(403);
    await expect(page.getByText('upstream forbidden')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Lessons Learned is unavailable' })).not.toBeVisible();
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('unavailable module frontend shows a local fallback and Hub return link', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Local profile' }).selectOption('local-developer');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('link', { name: 'Open Lessons Learned' }).click();

  await expect(page.getByRole('heading', { name: 'Lessons Learned is unavailable' })).toBeVisible();
  await expect(page.getByText(/frontend did not respond successfully/i)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to PMO Hub' })).toHaveAttribute('href', '/');

  await page.getByRole('link', { name: 'Return to PMO Hub' }).click();
  await expect(page.getByRole('heading', { name: 'Module catalog' })).toBeVisible();
});
