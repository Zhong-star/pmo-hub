import type { Browser, Page } from '@playwright/test';

/** Browser storage key the module reads to pick the local Hub profile. */
export const localProfileStorageKey = 'pmo-hub.local-user-id';

/** Header the API reads to identify the local Hub profile. */
export const localProfileHeader = 'X-PMO-Local-User-ID';

/** Local Admin prepared by the real runner (`prepare-first-admin`) before the journeys start. */
export const localAdminUserId = process.env.RESOURCE_ALLOCATION_FIRST_ADMIN_LOCAL_USER_ID ?? 'local-developer';

/**
 * Opens a page in its own browser context signed in as the local profile, so several people can
 * act in one journey without sharing storage. Close it with `page.context().close()`.
 */
export async function openPageAs(browser: Browser, baseURL: string | undefined, localUserId: string): Promise<Page> {
  const context = await browser.newContext({ baseURL });
  await context.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
    key: localProfileStorageKey,
    value: localUserId,
  });
  return context.newPage();
}
