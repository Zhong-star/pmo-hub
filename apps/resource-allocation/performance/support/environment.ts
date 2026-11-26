import { execFileSync } from 'node:child_process';
import { cpus, arch, platform, release, totalmem, type as osType, version as osVersion } from 'node:os';
import type { APIRequestContext, Browser } from '@playwright/test';
import { performanceSettings } from './settings';

export interface MeasurementEnvironment {
  label: string;
  baseURL: string;
  cpu: string;
  logicalCpus: number;
  ramGiB: number;
  os: string;
  node: string;
  browser: string;
  headless: boolean;
  buildMode: string;
  runnerSha: string;
  deployedSha: string | null;
  repetitions: number;
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: performanceSettings.appRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function runnerSha(): string {
  const sha = git(['rev-parse', 'HEAD']);
  if (!sha) return 'unknown (not a Git checkout)';
  const dirty = git(['status', '--porcelain']);
  return dirty ? `${sha} (with uncommitted changes)` : sha;
}

/** A Vite development server injects its client into the page; a production build does not. */
async function detectBuildMode(request: APIRequestContext): Promise<string> {
  if (performanceSettings.buildMode) return performanceSettings.buildMode;
  try {
    const response = await request.get(`${performanceSettings.baseURL}/resource-allocation/`);
    const html = await response.text();
    return html.includes('/@vite/client') ? 'development (Vite dev server, detected)' : 'production build (detected)';
  } catch (error) {
    return `unknown (${error instanceof Error ? error.message.split('\n')[0] : 'detection failed'})`;
  }
}

export async function describeEnvironment(browser: Browser, request: APIRequestContext, headless: boolean): Promise<MeasurementEnvironment> {
  const processors = cpus();
  return {
    label: performanceSettings.environmentLabel,
    baseURL: performanceSettings.baseURL,
    cpu: processors[0]?.model.trim() ?? 'unknown',
    logicalCpus: processors.length,
    ramGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    os: `${osType()} ${release()} (${platform()} ${arch()}; ${osVersion()})`,
    node: process.version,
    browser: `${browser.browserType().name()} ${browser.version()}${performanceSettings.chromiumExecutable ? ` (${performanceSettings.chromiumExecutable})` : ''}`,
    headless,
    buildMode: await detectBuildMode(request),
    runnerSha: runnerSha(),
    deployedSha: performanceSettings.deployedSha,
    repetitions: performanceSettings.repetitions,
  };
}
