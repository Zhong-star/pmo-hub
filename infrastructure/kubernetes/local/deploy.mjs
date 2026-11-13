import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const router = fileURLToPath(new URL('./router.yaml', import.meta.url));
const cluster = 'pmo-hub';
const namespace = 'pmo-hub';
const layers = {
  frontend: [
    { name: 'hub', port: 8080, path: '/' },
    { name: 'lessons-learned', port: 8080, path: '/lessons-learned/' },
  ],
  backend: [
    { name: 'hub-api', port: 3001, path: '/api/hub/v1/status' },
    { name: 'lessons-learned-api', port: 3002, path: '/api/lessons-learned/v1/health' },
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

function resources(layer, images) {
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
                ports: [{ name: 'http', containerPort: port }],
                readinessProbe: { httpGet: { path, port: 'http' }, periodSeconds: 2 },
              }],
            },
          },
        },
      },
    ];
  });
  return { apiVersion: 'v1', kind: 'List', items };
}

function release(layer, images) {
  apply(resources(layer, images));
  for (const { name } of layers[layer]) {
    kubectl(['rollout', 'status', `deployment/${name}`, '--timeout=90s']);
  }
}

function deploy(layer, failureTarget) {
  const names = layers[layer].map(({ name }) => name);
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
    const previous = saved ? JSON.parse(JSON.parse(saved).data.images) : undefined;
    if (failureTarget && !previous) throw new Error('Deploy a successful release before testing rollback.');
    try {
      release(layer, images);
      apply({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: state },
        data: { images: JSON.stringify(images) },
      });
    } catch (error) {
      if (!previous) throw new Error('First release failed. No previous release is available.', { cause: error });
      try {
        release(layer, previous);
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
  } else if (Object.hasOwn(layers, command) && !extra.length && (!option || option.startsWith('--fail='))) {
    deploy(command, option?.slice('--fail='.length));
  } else {
    throw new Error('Usage: node deploy.mjs setup | frontend | backend [--fail=component]');
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
