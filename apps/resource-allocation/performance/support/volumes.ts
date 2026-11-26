import { readFileSync } from 'node:fs';
import type { APIRequestContext } from '@playwright/test';
import { listAll } from '../../e2e/real/support/admin-preparation';
import { performanceSettings } from './settings';

/**
 * Volumes behind the measurement: what each measurement identity sees through the API, counted
 * before any sample runs (the request context must use the measured base URL), plus the optional
 * `prepare:volume` summary, which is the only source of counts taken in the database.
 */

export interface VolumeCount {
  label: string;
  identity: string;
  count: number | null;
  error?: string;
}

export interface VolumeReport {
  countedAt: string;
  counts: VolumeCount[];
  summary: { source: string; json: Record<string, unknown> } | { source: string; error: string } | null;
}

async function countCollection(
  request: APIRequestContext,
  identity: string,
  path: string,
  params: Record<string, string> = {},
): Promise<number> {
  return (await listAll<unknown>(request, path, params, identity)).length;
}

function readSummary(): VolumeReport['summary'] {
  const source = performanceSettings.volumeSummaryPath;
  if (!source) return null;
  try {
    const content = readFileSync(source, 'utf8');
    const line = content.split(/\r?\n/).find((entry) => entry.includes('VOLUME_DATASET_SUMMARY '));
    const json = line ? line.slice(line.indexOf('VOLUME_DATASET_SUMMARY ') + 'VOLUME_DATASET_SUMMARY '.length) : content;
    return { source, json: JSON.parse(json) as Record<string, unknown> };
  } catch (error) {
    return { source, error: error instanceof Error ? error.message : 'The summary could not be read.' };
  }
}

export async function countVolumes(request: APIRequestContext): Promise<VolumeReport> {
  const { admin, leadership, user } = performanceSettings.identities;
  const plan: Array<{ label: string; identity: string; path: string; params?: Record<string, string> }> = [
    { label: 'People (all)', identity: admin, path: '/admin/people' },
    { label: 'Groups (all)', identity: admin, path: '/admin/groups' },
    { label: 'Resource profiles (all)', identity: admin, path: '/admin/resource-profiles' },
    { label: 'ITDM initiatives (all)', identity: admin, path: '/admin/initiatives' },
    { label: 'FTE capacity entries (all)', identity: admin, path: '/capacities' },
    { label: 'Requests visible to the Admin', identity: admin, path: '/requests', params: { scope: 'visible' } },
    { label: 'Allocations visible to the Admin', identity: admin, path: '/allocations' },
    { label: 'Presentation queue (Admin)', identity: admin, path: '/request-queues/presentation' },
    { label: 'Group decision queue (Manager)', identity: leadership, path: '/request-queues/team-decision' },
    { label: 'Groups covered by the Manager', identity: leadership, path: '/allocation-groups' },
    { label: 'Allocations visible to the User', identity: user, path: '/allocations' },
    { label: 'Requests of the User', identity: user, path: '/requests' },
  ];
  const counts: VolumeCount[] = [];
  for (const entry of plan) {
    try {
      counts.push({ label: entry.label, identity: entry.identity, count: await countCollection(request, entry.identity, entry.path, entry.params) });
    } catch (error) {
      counts.push({ label: entry.label, identity: entry.identity, count: null, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { countedAt: new Date().toISOString(), counts, summary: readSummary() };
}
