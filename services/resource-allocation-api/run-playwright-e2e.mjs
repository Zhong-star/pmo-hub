import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const extraPlaywrightArgs = process.argv.slice(2);
const npmCliPath = process.env.npm_execpath;

if (!npmCliPath) {
  throw new Error('Run this helper through an npm script so it can locate the npm CLI.');
}

const port = process.env.PLAYWRIGHT_PORT ?? '5188';
const apiPort = process.env.RESOURCE_ALLOCATION_E2E_API_PORT ?? '5303';

function runNode(args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      env,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`node ${args.join(' ')} exited with ${code ?? signal ?? 'an unknown error'}.`));
    });
  });
}

function runNpm(args, env) {
  return runNode([npmCliPath, ...args], env);
}

function startNode(scriptPath, env) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: repositoryRoot,
    env,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  child.once('error', (error) => {
    process.stderr.write(`${scriptPath} could not start: ${error.message}\n`);
  });
  return child;
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once('exit', resolveExit));
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([waitForExit(child), delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function waitForApi(apiProcess, url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (apiProcess.exitCode !== null || apiProcess.signalCode !== null) {
      throw new Error(`Resource Allocation API exited before becoming ready (${apiProcess.exitCode ?? apiProcess.signalCode}).`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await delay(250);
  }
  throw new Error(`Resource Allocation API did not become ready at ${url}.`);
}

const postgres = await new PostgreSqlContainer('postgres:17-alpine')
  .withDatabase('resource_allocation_e2e')
  .withUsername('resource_allocation_e2e')
  .withPassword('e2e_only_password')
  .start();

const env = {
  ...process.env,
  PLAYWRIGHT_PORT: port,
  PORT: apiPort,
  RESOURCE_ALLOCATION_DATABASE_URL: postgres.getConnectionUri(),
  RESOURCE_ALLOCATION_API_TARGET: `http://127.0.0.1:${apiPort}`,
  // The real journeys prepare what the minimal baseline lacks through the API as this local Admin.
  RESOURCE_ALLOCATION_FIRST_ADMIN_LOCAL_USER_ID: process.env.RESOURCE_ALLOCATION_FIRST_ADMIN_LOCAL_USER_ID ?? 'local-developer',
  RESOURCE_ALLOCATION_FIRST_ADMIN_DISPLAY_NAME: process.env.RESOURCE_ALLOCATION_FIRST_ADMIN_DISPLAY_NAME ?? 'Local Developer',
  RESOURCE_ALLOCATION_FIRST_ADMIN_EMAIL: process.env.RESOURCE_ALLOCATION_FIRST_ADMIN_EMAIL ?? 'local-developer@example.test',
};

let apiProcess;
let workerProcess;

try {
  await runNpm(['run', 'build', '--workspace', '@pmo-hub/resource-allocation-api'], env);
  await runNpm(['run', 'migration:run', '--workspace', '@pmo-hub/resource-allocation-api'], env);
  await runNpm(['run', 'prepare:minimal', '--workspace', '@pmo-hub/resource-allocation-api'], env);
  await runNode([resolve(repositoryRoot, 'services/resource-allocation-api/dist/database/prepare-first-admin.js')], env);

  apiProcess = startNode(resolve(repositoryRoot, 'services/resource-allocation-api/dist/main.js'), env);
  workerProcess = startNode(resolve(repositoryRoot, 'services/resource-allocation-api/dist/submissions/run-submission-worker.js'), env);
  await waitForApi(apiProcess, `http://127.0.0.1:${apiPort}/health/ready`);
  await delay(250);
  if (workerProcess.exitCode !== null || workerProcess.signalCode !== null) {
    throw new Error(`Resource Allocation worker exited before E2E started (${workerProcess.exitCode ?? workerProcess.signalCode}).`);
  }

  await runNpm([
    'run', 'test:e2e', '--workspace', '@pmo-hub/resource-allocation', '--',
    '--config', 'playwright.real.config.ts',
    ...extraPlaywrightArgs,
  ], env);
} finally {
  if (workerProcess) await stop(workerProcess);
  if (apiProcess) await stop(apiProcess);
  await postgres.stop();
}
