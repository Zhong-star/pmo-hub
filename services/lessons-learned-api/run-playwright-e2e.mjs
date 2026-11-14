import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const extraPlaywrightArgs = process.argv.slice(2);
const npmCliPath = process.env.npm_execpath;

if (!npmCliPath) {
  throw new Error('Run this helper through an npm script so it can locate the npm CLI.');
}

function runNpm(args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [npmCliPath, ...args], {
      cwd: repositoryRoot,
      env,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`npm ${args.join(' ')} exited with ${code ?? signal ?? 'an unknown error'}.`));
    });
  });
}

const postgres = await new PostgreSqlContainer('postgres:17-alpine')
  .withDatabase('lessons_learned_e2e')
  .withUsername('lessons_learned_e2e')
  .withPassword('e2e_only_password')
  .start();

const env = {
  ...process.env,
  LESSONS_LEARNED_DATABASE_URL: postgres.getConnectionUri(),
};

try {
  await runNpm(['run', 'build', '--workspace', '@pmo-hub/hub-api'], env);
  await runNpm(['run', 'migration:run', '--workspace', '@pmo-hub/lessons-learned-api'], env);
  await runNpm([
    'exec', '--workspace', '@pmo-hub/hub', '--', 'playwright', 'test',
    '--config', 'playwright.lessons-learned.config.ts',
    ...extraPlaywrightArgs,
  ], env);

  if (extraPlaywrightArgs.length === 0) {
    await runNpm([
      'exec', '--workspace', '@pmo-hub/hub', '--', 'playwright', 'test',
      '--config', 'playwright.lessons-learned-unavailable.config.ts',
    ], env);
  }
} finally {
  await postgres.stop();
}
