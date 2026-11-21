import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const router = fileURLToPath(new URL('./router.yaml', import.meta.url));
const postgres = fileURLToPath(new URL('./postgres.yaml', import.meta.url));
const resourceAllocationPostgres = fileURLToPath(new URL('./resource-allocation-postgres.yaml', import.meta.url));
const cluster = 'pmo-hub';
const namespace = 'pmo-hub';
const databaseSecret = 'lessons-learned-postgres';
const resourceAllocationDatabaseSecret = 'resource-allocation-postgres';
const layers = {
  frontend: [
    { name: 'hub', port: 8080, path: '/' },
    { name: 'lessons-learned', port: 8080, path: '/lessons-learned/' },
    { name: 'resource-allocation', port: 8080, path: '/resource-allocation/' },
  ],
  backend: [
    { name: 'hub-api', port: 3001, path: '/api/hub/v1/status' },
    { name: 'lessons-learned-api', port: 3002, path: '/api/lessons-learned/v1/health' },
    { name: 'resource-allocation-api', port: 3003, path: '/health/startup' },
  ],
};

function run(command, args, input) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'],
    windowsHide: true,
  }).trim();
}

function kubectl(args, input) {
  return run('kubectl', ['--context', `kind-${cluster}`, '--namespace', namespace, ...args], input);
}

function apply(resource) {
  kubectl(['apply', '-f', '-'], JSON.stringify(resource));
}

function databaseEnv() {
  return [{
    name: 'LESSONS_LEARNED_DATABASE_URL',
    valueFrom: { secretKeyRef: { name: databaseSecret, key: 'url' } },
  }];
}

function resourceAllocationDatabaseEnv() {
  return [{
    name: 'RESOURCE_ALLOCATION_DATABASE_URL',
    valueFrom: { secretKeyRef: { name: resourceAllocationDatabaseSecret, key: 'url' } },
  }];
}

function firstAdminFromEnvironment() {
  const firstAdmin = {
    localUserId: process.env.RESOURCE_ALLOCATION_FIRST_ADMIN_LOCAL_USER_ID?.trim(),
    displayName: process.env.RESOURCE_ALLOCATION_FIRST_ADMIN_DISPLAY_NAME?.trim(),
    email: process.env.RESOURCE_ALLOCATION_FIRST_ADMIN_EMAIL?.trim(),
  };
  if (!firstAdmin.localUserId || !firstAdmin.displayName || !firstAdmin.email) {
    throw new Error('Set RESOURCE_ALLOCATION_FIRST_ADMIN_LOCAL_USER_ID, RESOURCE_ALLOCATION_FIRST_ADMIN_DISPLAY_NAME, and RESOURCE_ALLOCATION_FIRST_ADMIN_EMAIL before deploying the backend with PostgreSQL.');
  }
  return firstAdmin;
}
function migrateDatabase(image, version) {
  if (!kubectl(['get', 'secret', databaseSecret, '--ignore-not-found', '-o', 'name'])) {
    const password = randomUUID();
    kubectl(['create', '-f', '-'], JSON.stringify({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: databaseSecret },
      immutable: true,
      data: {
        password: Buffer.from(password).toString('base64'),
        url: Buffer.from(`postgresql://lessons_learned:${password}@${databaseSecret}:5432/lessons_learned`).toString('base64'),
      },
    }));
  }
  kubectl(['apply', '-f', postgres]);
  kubectl(['rollout', 'status', `statefulset/${databaseSecret}`, '--timeout=120s']);

  const name = `lessons-learned-migrate-${version}`;
  kubectl(['create', '-f', '-'], JSON.stringify({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 90,
      ttlSecondsAfterFinished: 3600,
      template: {
        spec: {
          restartPolicy: 'Never',
          containers: [{
            name: 'migrate',
            image,
            imagePullPolicy: 'Never',
            command: ['node', '/app/node_modules/typeorm/cli.js', 'migration:run', '-d', 'dist/database/data-source.js'],
            env: databaseEnv(),
          }],
        },
      },
    },
  }));
  try {
    kubectl(['wait', '--for=condition=complete', `job/${name}`, '--timeout=100s']);
  } catch (error) {
    throw new Error(`Migration job ${name} did not complete. Inspect its status and logs in namespace ${namespace}.`, {
      cause: error,
    });
  }
  console.log(kubectl(['logs', `job/${name}`]));
}

function migrateResourceAllocationDatabase(image, version, firstAdmin) {
  if (!kubectl(['get', 'secret', resourceAllocationDatabaseSecret, '--ignore-not-found', '-o', 'name'])) {
    const password = randomUUID();
    kubectl(['create', '-f', '-'], JSON.stringify({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: resourceAllocationDatabaseSecret },
      immutable: true,
      data: {
        password: Buffer.from(password).toString('base64'),
        url: Buffer.from(`postgresql://resource_allocation:${password}@${resourceAllocationDatabaseSecret}:5432/resource_allocation`).toString('base64'),
      },
    }));
  }
  kubectl(['apply', '-f', resourceAllocationPostgres]);
  kubectl(['rollout', 'status', `statefulset/${resourceAllocationDatabaseSecret}`, '--timeout=120s']);

  const migrationName = `resource-allocation-migrate-${version}`;
  kubectl(['create', '-f', '-'], JSON.stringify({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: migrationName },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 90,
      ttlSecondsAfterFinished: 3600,
      template: {
        spec: {
          restartPolicy: 'Never',
          containers: [{
            name: 'migrate',
            image,
            imagePullPolicy: 'Never',
            command: ['node', '/app/node_modules/typeorm/cli.js', 'migration:run', '-d', 'dist/database/data-source.js'],
            env: resourceAllocationDatabaseEnv(),
          }],
        },
      },
    },
  }));
  try {
    kubectl(['wait', '--for=condition=complete', `job/${migrationName}`, '--timeout=100s']);
  } catch (error) {
    throw new Error(`Migration job ${migrationName} did not complete. Inspect its status and logs in namespace ${namespace}.`, { cause: error });
  }
  console.log(kubectl(['logs', `job/${migrationName}`]));

  const secretName = `resource-allocation-first-admin-${version}`;
  const secretData = Object.fromEntries(Object.entries(firstAdmin).map(([key, value]) => [key, Buffer.from(value).toString('base64')]));
  kubectl(['create', '-f', '-'], JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: secretName },
    immutable: true,
    data: secretData,
  }));
  const preparationName = `resource-allocation-prepare-admin-${version}`;
  try {
    kubectl(['create', '-f', '-'], JSON.stringify({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: preparationName },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: 90,
        ttlSecondsAfterFinished: 3600,
        template: {
          spec: {
            restartPolicy: 'Never',
            containers: [{
              name: 'prepare-first-admin',
              image,
              imagePullPolicy: 'Never',
              command: ['node', 'dist/database/prepare-first-admin.js'],
              env: [
                ...resourceAllocationDatabaseEnv(),
                ...Object.entries({
                  RESOURCE_ALLOCATION_FIRST_ADMIN_LOCAL_USER_ID: 'localUserId',
                  RESOURCE_ALLOCATION_FIRST_ADMIN_DISPLAY_NAME: 'displayName',
                  RESOURCE_ALLOCATION_FIRST_ADMIN_EMAIL: 'email',
                }).map(([name, key]) => ({
                  name,
                  valueFrom: { secretKeyRef: { name: secretName, key } },
                })),
              ],
            }],
          },
        },
      },
    }));
    try {
      kubectl(['wait', '--for=condition=complete', `job/${preparationName}`, '--timeout=100s']);
    } catch (error) {
      throw new Error(`First Admin preparation job ${preparationName} did not complete. Inspect its status and logs in namespace ${namespace}.`, { cause: error });
    }
    console.log(kubectl(['logs', `job/${preparationName}`]));
  } finally {
    kubectl(['delete', 'secret', secretName, '--ignore-not-found']);
  }
}
function resources(layer, { images, withPostgres, lessonTokenFormat }) {
  const items = layers[layer].flatMap(({ name, port, path }) => {
    const labels = { app: name, layer };
    return [
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name },
        spec: { selector: labels, ports: [{ port, targetPort: 'http' }] },
      },
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name, labels },
        spec: {
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              containers: [{
                name,
                image: images[name],
                imagePullPolicy: 'Never',
                ...(name === 'lessons-learned-api' ? {
                  env: [
                    { name: 'LESSONS_LEARNED_LOCAL_AUTH_ENABLED', value: 'true' },
                    ...(lessonTokenFormat ? [{ name: 'LESSONS_LEARNED_TOKEN_FORMAT', value: lessonTokenFormat }] : []),
                    ...(withPostgres ? databaseEnv() : []),
                  ],
                } : {}),
                ...(name === 'resource-allocation-api' ? {
                  env: [
                    { name: 'RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED', value: 'true' },
                    ...(withPostgres ? resourceAllocationDatabaseEnv() : []),
                  ],
                } : {}),
                ports: [{ name: 'http', containerPort: port }],
                readinessProbe: { httpGet: { path: name === 'resource-allocation-api' && !withPostgres ? '/health/live' : path, port: 'http' }, periodSeconds: 2 },
              }],
            },
          },
        },
      },
    ];
  });
  if (layer === 'backend') {
    const labels = { app: 'resource-allocation-worker', layer };
    items.push({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'resource-allocation-worker', labels },
      spec: {
        replicas: withPostgres ? 1 : 0,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            containers: [{
              name: 'resource-allocation-worker',
              image: images['resource-allocation-api'],
              imagePullPolicy: 'Never',
              command: ['node', 'dist/submissions/run-submission-worker.js'],
              ...(withPostgres ? { env: resourceAllocationDatabaseEnv() } : {}),
            }],
          },
        },
      },
    });
  }
  return { apiVersion: 'v1', kind: 'List', items };
}

function release(layer, configuration) {
  apply(resources(layer, configuration));
  const names = layers[layer].map(({ name }) => name);
  if (layer === 'backend') names.push('resource-allocation-worker');
  for (const name of names) {
    kubectl(['rollout', 'status', `deployment/${name}`, '--timeout=90s']);
  }
}

function deploy(layer, failureTarget, withPostgres) {
  const firstAdmin = layer === 'backend' && withPostgres ? firstAdminFromEnvironment() : undefined;
  const names = layers[layer].map(({ name }) => name);
  const lessonTokenFormat = layer === 'backend' ? process.env.LESSONS_LEARNED_TOKEN_FORMAT ?? 'legacy' : undefined;
  if (lessonTokenFormat && !['legacy', 'representation'].includes(lessonTokenFormat)) {
    throw new Error('LESSONS_LEARNED_TOKEN_FORMAT must be legacy or representation.');
  }
  if (failureTarget && !names.includes(failureTarget)) {
    throw new Error(`Choose a failure target in the ${layer} layer.`);
  }

  kubectl(['get', 'namespace', namespace]);
  const version = randomUUID();
  const images = Object.fromEntries(names.map((name) => [name, `pmo-hub/${name}:${version}`]));
  for (const name of names) {
    if (name === failureTarget) continue;
    console.log(`Building ${images[name]}`);
    run('docker', ['build', '--target', name, '--tag', images[name], '.']);
    run('kind', ['load', 'docker-image', '--name', cluster, images[name]]);
  }

  const state = `pmo-${layer}-release`;
  const lock = `pmo-${layer}-deploy-lock`;
  kubectl(['create', 'configmap', lock]);
  try {
    const saved = kubectl(['get', 'configmap', state, '--ignore-not-found', '-o', 'json']);
    const previous = saved ? JSON.parse(saved).data : undefined;
    if (failureTarget && !previous) throw new Error('Deploy a successful release before testing rollback.');
    if (lessonTokenFormat === 'representation' && !previous?.lessonTokenFormat) {
      throw new Error('Validate a backend release with legacy token emission before enabling representation tokens.');
    }
    if (lessonTokenFormat === 'representation' && withPostgres && previous?.withPostgres !== 'true') {
      throw new Error('The rollback release must have PostgreSQL enabled before enabling representation tokens with PostgreSQL.');
    }
    if (withPostgres) {
      migrateDatabase(images['lessons-learned-api'], version);
      migrateResourceAllocationDatabase(images['resource-allocation-api'], version, firstAdmin);
    }
    try {
      release(layer, { images, withPostgres, lessonTokenFormat });
      apply({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: state },
        data: {
          images: JSON.stringify(images),
          withPostgres: String(withPostgres),
          ...(lessonTokenFormat ? { lessonTokenFormat } : {}),
        },
      });
    } catch (error) {
      if (!previous) throw new Error('First release failed. No previous release is available.', { cause: error });
      try {
        release(layer, {
          images: JSON.parse(previous.images),
          withPostgres: previous.withPostgres === 'true',
          lessonTokenFormat: previous.lessonTokenFormat,
        });
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `${layer} release and rollback failed.`);
      }
      throw new Error(`${layer} release failed. Both components returned to the last validated release.`, { cause: error });
    }
    console.log(`${layer} release ${version} is ready.`);
  } finally {
    try {
      kubectl(['delete', 'configmap', lock, '--ignore-not-found']);
    } catch {
      console.error(`Could not remove ${lock}. See the README before retrying.`);
      process.exitCode = 1;
    }
  }
}

const [command, option, ...extra] = process.argv.slice(2);
try {
  if (command === 'setup' && option === undefined) {
    const clusters = run('kind', ['get', 'clusters']).split(/\r?\n/);
    if (!clusters.includes(cluster)) run('kind', ['create', 'cluster', '--name', cluster, '--wait', '120s']);
    apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } });
    const manifest = readFileSync(router, 'utf8');
    const revision = createHash('sha256').update(manifest).digest('hex');
    kubectl(['apply', '-f', '-'], manifest.replace('ROUTER_MANIFEST_HASH', revision));
    kubectl(['rollout', 'status', 'deployment/pmo-router', '--timeout=90s']);
    console.log('Local cluster and router are ready.');
  } else if (Object.hasOwn(layers, command) && !extra.length &&
      (!option || option.startsWith('--fail=') || (command === 'backend' && option === '--with-postgres'))) {
    deploy(command, option?.startsWith('--fail=') ? option.slice('--fail='.length) : undefined, option === '--with-postgres');
  } else {
    throw new Error('Usage: node deploy.mjs setup | frontend [--fail=component] | backend [--with-postgres | --fail=component]');
  }
} catch (error) {
  console.error(error.message);
  if (error instanceof AggregateError) {
    for (const failure of error.errors) console.error(failure.message);
  } else if (error.cause) {
    console.error(error.cause.message);
  }
  process.exitCode = 1;
}
