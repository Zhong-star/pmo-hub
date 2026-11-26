import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { addDays, businessToday } from '../e2e/real/support/business-calendar';
import { signInContextAs } from '../e2e/real/support/local-identity';
import { describeEnvironment } from './support/environment';
import { timeAction, timeOpening, waitUntilUsable, type OpeningCheck } from './support/probes';
import { OperationRecorder, writeRunFile, type OperationId } from './support/results';
import { performanceSettings } from './support/settings';
import { countVolumes } from './support/volumes';

const { repetitions, identities } = performanceSettings;
const { defaultBrowserType: _defaultBrowserType, ...desktopChrome } = devices['Desktop Chrome'];
void _defaultBrowserType;

/** A new browser context has an empty HTTP cache and storage; only the local profile is set. */
async function newSignedInContext(browser: Browser, localUserId: string): Promise<BrowserContext> {
  const context = await browser.newContext({ ...desktopChrome, baseURL: performanceSettings.baseURL });
  await signInContextAs(context, localUserId);
  return context;
}

async function measure(recorder: OperationRecorder, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    recorder.fail(error);
    throw error;
  }
}

test('records the environment and the real volumes before measuring', async ({ browser, playwright }, testInfo) => {
  const request = await playwright.request.newContext({ baseURL: performanceSettings.baseURL });
  try {
    writeRunFile('environment.json', await describeEnvironment(browser, request, testInfo.project.use.headless ?? true));
    writeRunFile('volumes.json', await countVolumes(request));
  } finally {
    await request.dispose();
  }
});

interface OpeningScenario {
  operation: OperationId;
  check: OpeningCheck;
  identity: string;
  path: string;
  /** Confirms with accessible roles that the usable content is the expected one (not timed). */
  confirm: (page: Page) => Promise<void>;
}

const openings: OpeningScenario[] = [
  {
    operation: 'open-module',
    check: 'open-module',
    identity: identities.user,
    path: '/resource-allocation/',
    confirm: async (page) => {
      await expect(page.getByRole('heading', { name: 'My requests', level: 2 })).toBeVisible();
    },
  },
  {
    operation: 'presentation-queue',
    check: 'presentation-queue',
    identity: identities.admin,
    path: '/resource-allocation/?page=request-queues&queue=presentation',
    confirm: async (page) => {
      await expect(page.getByRole('tab', { name: 'Presentation queue', selected: true })).toBeVisible();
      await expect(page.getByRole('tabpanel', { name: 'Presentation queue' }).getByRole('article').first()).toBeVisible();
    },
  },
  {
    operation: 'my-allocations',
    check: 'my-allocations',
    identity: identities.user,
    path: '/resource-allocation/?page=allocations',
    confirm: async (page) => {
      await expect(page.getByRole('heading', { name: 'Allocation list' })).toBeVisible();
      await expect(page.getByRole('button', { name: /^View allocation / }).first()).toBeVisible();
    },
  },
  {
    operation: 'capacity-comparison',
    check: 'capacity-comparison',
    identity: identities.leadership,
    path: '/resource-allocation/?page=capacity',
    confirm: async (page) => {
      await expect(page.getByRole('heading', { name: 'Weekly comparison' })).toBeVisible();
      await expect(page.getByRole('region', { name: /^Week of / }).getByRole('rowheader').first()).toBeVisible();
    },
  },
];

for (const scenario of openings) {
  test(`opening: ${scenario.operation} (cold and warm)`, async ({ browser }) => {
    const recorder = new OperationRecorder(scenario.operation, scenario.identity);
    await measure(recorder, async () => {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const context = await newSignedInContext(browser, scenario.identity);
        try {
          const page = await context.newPage();
          recorder.add({ series: 'cold', repetition, ...(await timeOpening(page, scenario.path, scenario.check)) });
          await scenario.confirm(page);
          recorder.add({ series: 'warm', repetition, ...(await timeOpening(page, scenario.path, scenario.check)) });
          await scenario.confirm(page);
        } finally {
          await context.close();
        }
      }
    });
  });
}

test('action: approve a request from the presentation queue', async ({ browser }) => {
  const recorder = new OperationRecorder('approve-request', identities.admin);
  const queuePath = '/resource-allocation/?page=request-queues&queue=presentation';
  const approved = new Set<string>();
  const context = await newSignedInContext(browser, identities.admin);
  try {
    const page = await context.newPage();
    await measure(recorder, async () => {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        await page.goto(queuePath);
        await waitUntilUsable(page, 'presentation-queue');
        const queue = page.getByRole('tabpanel', { name: 'Presentation queue' });
        const cards = queue.getByRole('article').filter({ has: page.getByRole('button', { name: 'Approve request' }) });
        const ids = await cards.evaluateAll((elements) => elements.map((element) => element.id));
        const cardId = ids.find((id) => !approved.has(id));
        if (!cardId) throw new Error(`No request left to approve in the presentation queue (repetition ${repetition}).`);
        const requestId = cardId.replace(/^resource-request-/, '');
        approved.add(cardId);

        const card = page.locator(`[id="${cardId}"]`);
        await card.getByRole('button', { name: 'Approve request' }).first().click();
        const form = card.getByRole('form', { name: `Approve request ${requestId}` });
        await expect(form.getByText('This approval keeps the requested period and weekly hours.')).toBeVisible();
        const person = form.getByLabel('Eligible person');
        await expect(person.locator('option')).not.toHaveCount(1);
        await person.selectOption({ index: 1 });

        const sample = await timeAction(page, form.getByRole('button', { name: 'Approve request' }), { kind: 'approve-request', requestId });
        recorder.add({ series: 'action', repetition, ...sample, note: `request ${requestId}` });
        await expect(page.locator(`[id="${cardId}"]`)).toHaveCount(0);
      }
    });
  } finally {
    await context.close();
  }
});

test('action: create an own operational allocation', async ({ browser }) => {
  const recorder = new OperationRecorder('create-allocation', identities.user);
  const run = Date.now().toString(36);
  const context = await newSignedInContext(browser, identities.user);
  try {
    const page = await context.newPage();
    await measure(recorder, async () => {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        await page.goto('/resource-allocation/?page=allocations');
        await waitUntilUsable(page, 'my-allocations');
        await page.getByRole('button', { name: 'Record allocation', exact: true }).first().click();
        const creation = page.getByRole('region', { name: 'Record an allocation' });
        await expect(creation).toBeVisible();

        // A future week per repetition; overlaps and totals above 40 h are allowed, so reruns are safe.
        const start = addDays(businessToday(), 120 + repetition * 7);
        await creation.getByLabel('Category').selectOption({ label: 'Routine / Support' });
        const profile = creation.getByLabel('Resource profile');
        await expect(profile.locator('option')).not.toHaveCount(1);
        await profile.selectOption({ index: 1 });
        await creation.getByLabel('Start date').fill(start);
        await creation.getByLabel('End date (inclusive)').fill(addDays(start, 4));
        await creation.getByLabel('Weekly hours').fill('1');
        await creation.getByLabel('Activity description').fill(`Performance measurement ${run} #${repetition}`);
        await page.getByRole('button', { name: 'Review allocation' }).click();
        await expect(page.getByRole('heading', { name: 'Review before recording' })).toBeVisible();

        const confirm = page.getByRole('button', { name: 'Record allocation', exact: true }).last();
        const sample = await timeAction(page, confirm, { kind: 'create-allocation' });
        recorder.add({ series: 'action', repetition, ...sample, note: `starts ${start}` });
        await expect(page.getByRole('status').filter({ hasText: 'Routine / Support was recorded for' })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Allocation details' })).toContainText(`Performance measurement ${run} #${repetition}`);
      }
    });
  } finally {
    await context.close();
  }
});
