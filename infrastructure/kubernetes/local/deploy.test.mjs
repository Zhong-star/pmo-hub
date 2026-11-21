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
      RESOURCE_ALLOCATION_FIRST_ADMIN_LOCAL_USER_ID: 'local-developer',
      RESOURCE_ALLOCATION_FIRST_ADMIN_DISPLAY_NAME: 'Local Developer',
      RESOURCE_ALLOCATION_FIRST_ADMIN_EMAIL: 'local-developer@example.test',
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

test('runs the Resource Allocation worker from the API image only with PostgreSQL enabled', () => {
  const workerCommands = `
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const require = createRequire(process.cwd() + '/package.json');
    require('node:child_process').execFileSync = (command, args, options) => {
      if (command === 'docker' || command === 'kind') return '';
      const [verb, resource, name] = args.slice(4);
      if (verb === 'get' && resource === 'configmap' && name === 'pmo-backend-release') return '';
      if (verb === 'get' && resource === 'secret') return 'secret/resource-allocation-postgres';
      if (verb === 'apply' && options.input?.includes('"kind":"List"')) {
        const list = JSON.parse(options.input);
        const worker = list.items.find(({ kind, metadata }) => kind === 'Deployment' && metadata.name === 'resource-allocation-worker');
        if (worker) {
          const api = list.items.find(({ kind, metadata }) => kind === 'Deployment' && metadata.name === 'resource-allocation-api');
          console.log('WORKER: ' + JSON.stringify({ worker, api }));
        }
      }
      return '';
    };
    syncBuiltinESMExports();
  `;
  const preloader = `data:text/javascript;base64,${Buffer.from(workerCommands).toString('base64')}`;
  const result = spawnSync(process.execPath, ['--import', preloader, deployScript, 'backend', '--with-postgres'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RESOURCE_ALLOCATION_FIRST_ADMIN_LOCAL_USER_ID: 'local-developer',
      RESOURCE_ALLOCATION_FIRST_ADMIN_DISPLAY_NAME: 'Local Developer',
      RESOURCE_ALLOCATION_FIRST_ADMIN_EMAIL: 'local-developer@example.test',
    },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const manifest = result.stdout.split(/\r?\n/).find((line) => line.startsWith('WORKER: '));
  assert.ok(manifest, result.stdout);
  const { worker, api } = JSON.parse(manifest.slice('WORKER: '.length));
  const container = worker.spec.template.spec.containers[0];
  assert.equal(worker.spec.replicas, 1);
  assert.deepEqual(container.command, ['node', 'dist/submissions/run-submission-worker.js']);
  assert.equal(container.image, api.spec.template.spec.containers[0].image);
  assert.deepEqual(container.env, [{
    name: 'RESOURCE_ALLOCATION_DATABASE_URL',
    valueFrom: { secretKeyRef: { name: 'resource-allocation-postgres', key: 'url' } },
  }]);
  assert.equal(container.ports, undefined);
});
