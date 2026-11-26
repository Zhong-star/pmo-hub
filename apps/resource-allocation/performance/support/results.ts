import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runDirectory } from './settings';

/** The six release 1 operations and their targets. */
export const operations = [
  {
    id: 'open-module',
    title: 'Open the module',
    kind: 'opening',
    targetMs: 3_000,
    measured: 'Navigation to `/resource-allocation/` until the access check and the default Requests list have loaded.',
  },
  {
    id: 'presentation-queue',
    title: 'Presentation queue',
    kind: 'opening',
    targetMs: 3_000,
    measured: 'Navigation to the Admin presentation queue until its first page of requests is listed.',
  },
  {
    id: 'my-allocations',
    title: 'My allocations',
    kind: 'opening',
    targetMs: 3_000,
    measured: 'Navigation to Allocations as a User until the allocation list and the weekly hours by date have loaded.',
  },
  {
    id: 'capacity-comparison',
    title: 'Weekly capacity comparison',
    kind: 'opening',
    targetMs: 3_000,
    measured: 'Navigation to Capacity as the Manager until the weekly comparison table and the capacity entries have loaded.',
  },
  {
    id: 'approve-request',
    title: 'Approve a request',
    kind: 'action',
    targetMs: 1_000,
    measured: 'Click on the final "Approve request" until the request leaves the presentation queue after the queue reloads from the API. Each repetition approves a different request without changes.',
  },
  {
    id: 'create-allocation',
    title: 'Create an allocation',
    kind: 'action',
    targetMs: 1_000,
    measured: 'Click on the final "Record allocation" until the confirmation is shown and the new allocation details are read back from the API.',
  },
] as const;

export type OperationId = (typeof operations)[number]['id'];
export type OperationDefinition = (typeof operations)[number];
export type SampleSeries = 'cold' | 'warm' | 'action';

export interface Sample {
  series: SampleSeries;
  repetition: number;
  /** When the measured interval started, as an ISO timestamp. */
  startedAt: string;
  durationMs: number;
  note?: string;
}

export interface OperationRecord {
  operation: OperationId;
  identity: string;
  samples: Sample[];
  errors: string[];
}

function operationFile(operation: OperationId): string {
  const directory = join(runDirectory(), 'operations');
  mkdirSync(directory, { recursive: true });
  return join(directory, `${operation}.json`);
}

/**
 * Keeps one operation's samples on disk after every sample, so a failure later in the run never
 * hides the samples already measured.
 */
export class OperationRecorder {
  private readonly record: OperationRecord;

  constructor(operation: OperationId, identity: string) {
    this.record = { operation, identity, samples: [], errors: [] };
    this.flush();
  }

  add(sample: Sample): void {
    this.record.samples.push({ ...sample, durationMs: Math.round(sample.durationMs) });
    this.flush();
  }

  fail(error: unknown): void {
    this.record.errors.push(error instanceof Error ? error.message.split('\n')[0] : String(error));
    this.flush();
  }

  private flush(): void {
    writeFileSync(operationFile(this.record.operation), `${JSON.stringify(this.record, null, 2)}\n`);
  }
}

export function readOperationRecord(directory: string, operation: OperationId): OperationRecord | null {
  const file = join(directory, 'operations', `${operation}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as OperationRecord;
}

export function writeRunFile(name: string, value: unknown): void {
  writeFileSync(join(runDirectory(), name), `${JSON.stringify(value, null, 2)}\n`);
}

export function readRunFile<T>(directory: string, name: string): T | null {
  const file = join(directory, name);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}
