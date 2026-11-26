import type { JSHandle, Locator, Page } from '@playwright/test';
import { performanceSettings } from './settings';

/**
 * In-page timing. Playwright's own waits poll at coarse intervals (up to 500 ms or more), which is
 * too imprecise for a 1 s target, so the end of each interval is detected inside the page on every
 * animation frame and timed with the page's own clock:
 *
 * - an opening runs from the navigation start (`performance.timeOrigin`) until the content is usable;
 * - an action runs from the confirming click until the durable result is shown.
 *
 * The probes are serialized into the page, so each one must be self-contained.
 */

export type OpeningCheck = 'open-module' | 'presentation-queue' | 'my-allocations' | 'capacity-comparison';
type ProbeResult = false | { at: number } | { error: string };

declare global {
  interface Window {
    __pmoPerformanceActionStart?: number;
  }
}

function openingProbe(check: OpeningCheck): ProbeResult {
  const textOf = (element: Element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  const alerts = Array.from(document.querySelectorAll('[role="alert"]')).map(textOf).filter(Boolean);
  if (alerts.length > 0) return { error: `The page shows an error: ${alerts.join(' | ')}` };
  const loading = Array.from(document.querySelectorAll('[role="status"]')).some((element) => /^(Loading|Checking)\b/.test(textOf(element)));
  if (loading) return false;

  let ready: boolean;
  if (check === 'open-module') {
    ready = document.getElementById('my-requests-title') !== null
      && document.querySelector('.request-list .request-list-item, .request-panel .empty-state') !== null;
  } else if (check === 'presentation-queue') {
    const panel = document.querySelector('[role="tabpanel"][aria-label="Presentation queue"]');
    ready = panel !== null && panel.querySelector('.request-queue-card, .empty-state') !== null;
  } else if (check === 'my-allocations') {
    ready = document.querySelector('.allocation-list-area .allocation-list li, .allocation-list-area .allocation-empty') !== null
      && document.querySelector('.allocation-capacity table, .allocation-capacity .allocation-empty') !== null;
  } else {
    ready = document.querySelector('.capacity-compare-week table') !== null
      && document.querySelector('.capacity-list .capacity-card, .capacity-list-panel .capacity-empty-state') !== null;
  }
  return ready ? { at: performance.now() } : false;
}

type ActionCheck = { kind: 'approve-request'; requestId: string } | { kind: 'create-allocation' };

function actionProbe(check: ActionCheck): ProbeResult {
  const started = window.__pmoPerformanceActionStart;
  if (started === undefined) return false;
  const textOf = (element: Element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim();

  if (check.kind === 'approve-request') {
    const panel = document.querySelector('[role="tabpanel"][aria-label="Presentation queue"]');
    const alerts = panel ? Array.from(panel.querySelectorAll('[role="alert"]')).map(textOf).filter(Boolean) : [];
    if (alerts.length > 0) return { error: `The approval failed: ${alerts.join(' | ')}` };
    const gone = document.getElementById(`resource-request-${check.requestId}`) === null;
    return gone && panel !== null ? { at: performance.now() - started } : false;
  }

  const creation = document.querySelector('.allocation-create');
  const alerts = creation ? Array.from(creation.querySelectorAll('[role="alert"]')).map(textOf).filter(Boolean) : [];
  if (alerts.length > 0) return { error: `The allocation was not recorded: ${alerts.join(' | ')}` };
  const confirmed = Array.from(document.querySelectorAll('.allocation-action-message[role="status"]'))
    .some((element) => textOf(element).includes('was recorded for'));
  const detail = document.querySelector('.allocation-detail');
  const detailLoaded = detail !== null
    && detail.querySelector('h3') !== null
    && !Array.from(detail.querySelectorAll('[role="status"]')).some((element) => textOf(element).startsWith('Loading allocation details'));
  return confirmed && detailLoaded ? { at: performance.now() - started } : false;
}

async function probeValue(handle: JSHandle<ProbeResult>): Promise<number> {
  const result = (await handle.jsonValue()) as Exclude<ProbeResult, false>;
  await handle.dispose();
  if ('error' in result) throw new Error(result.error);
  return result.at;
}

async function waitForOpening(page: Page, check: OpeningCheck): Promise<number> {
  return probeValue(await page.waitForFunction(openingProbe, check, { polling: 'raf', timeout: performanceSettings.sampleTimeoutMs }));
}

async function waitForAction(page: Page, check: ActionCheck): Promise<number> {
  return probeValue(await page.waitForFunction(actionProbe, check, { polling: 'raf', timeout: performanceSettings.sampleTimeoutMs }));
}

/** Navigates and returns the time from navigation start until the content is usable. */
export async function timeOpening(page: Page, path: string, check: OpeningCheck): Promise<{ startedAt: string; durationMs: number }> {
  const startedAt = new Date().toISOString();
  await page.goto(path, { waitUntil: 'commit', timeout: performanceSettings.sampleTimeoutMs });
  const durationMs = await waitForOpening(page, check);
  return { startedAt, durationMs };
}

/** Waits until the page is usable without timing it (preparation between samples). */
export async function waitUntilUsable(page: Page, check: OpeningCheck): Promise<void> {
  await waitForOpening(page, check);
}

/** Clicks the confirming control and returns the time from that click until the durable result is shown. */
export async function timeAction(page: Page, confirm: Locator, check: ActionCheck): Promise<{ startedAt: string; durationMs: number }> {
  await page.evaluate(() => {
    window.__pmoPerformanceActionStart = undefined;
    document.addEventListener('click', () => { window.__pmoPerformanceActionStart = performance.now(); }, { capture: true, once: true });
  });
  const startedAt = new Date().toISOString();
  await confirm.click();
  const durationMs = await waitForAction(page, check);
  return { startedAt, durationMs };
}
