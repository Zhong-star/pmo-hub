import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const deployScript = fileURLToPath(new URL('./deploy.mjs', import.meta.url));
const mockCommands = `
  import { createRequire, syncBuiltinESMExports } from 'node:module';
  const require = createRequire(process.cwd() + '/package.json');
  require('node:child_process').execFileSync = (command, args, options) => {
    if (command === 'docker' || command === 'kind') return '';
    const [verb, resource, name] = args.slice(4);
    if (verb === 'get' && resource === 'configmap' && name === 'pmo-backend-release') {
      return JSON.stringify({ data: { lessonTokenFormat: 'legacy', withPostgres: process.env.TEST_PREVIOUS_POSTGRES } });
    }
    if (verb === 'get' && resource === 'secret') return 'secret/lessons-learned-postgres';
    if (verb === 'apply' && options.input?.includes('"kind":"List"')) {
      const deployment = JSON.parse(options.input).items
        .find(({ kind, metadata }) => kind === 'Deployment' && metadata.name === 'lessons-learned-api');
      const format = deployment.spec.template.spec.containers[0].env
        .find(({ name }) => name === 'LESSONS_LEARNED_TOKEN_FORMAT').value;
      console.log('Lessons Learned rollout: ' + format);
    }
    return '';
  };
  syncBuiltinESMExports();
`;
const preloader = `data:text/javascript;base64,${Buffer.from(mockCommands).toString('base64')}`;

function activateRepresentationTokens(previousWithPostgres) {
  return spawnSync(process.execPath, ['--import', preloader, deployScript, 'backend', '--with-postgres'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LESSONS_LEARNED_TOKEN_FORMAT: 'representation',
      TEST_PREVIOUS_POSTGRES: String(previousWithPostgres),
    },
  });
}

test('blocks representation token activation if the rollback release has no PostgreSQL', () => {
  const result = activateRepresentationTokens(false);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /rollback.*PostgreSQL/i);
  assert.doesNotMatch(result.stdout, /Lessons Learned rollout/);
});

test('allows representation token activation after a compatible release with PostgreSQL', () => {
  const result = activateRepresentationTokens(true);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Lessons Learned rollout: representation/);
});
