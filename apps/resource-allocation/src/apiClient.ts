import axios from 'axios';
import type { ApiAdministratorContact, ApiFieldError, ApiProblem } from './apiContracts';

export const RESOURCE_ALLOCATION_API_TIMEOUT_MS = 10_000;

export const api = axios.create({
  baseURL: import.meta.env.VITE_RESOURCE_ALLOCATION_API_BASE_URL ?? '',
  timeout: RESOURCE_ALLOCATION_API_TIMEOUT_MS,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseFieldErrors(value: unknown): ApiFieldError[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    if (!isRecord(item)
      || typeof item.path !== 'string'
      || typeof item.code !== 'string'
      || typeof item.message !== 'string') {
      return [];
    }
    return [{ path: item.path, code: item.code, message: item.message }];
  });
}

function parseAdministrators(value: unknown): ApiAdministratorContact[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.displayName !== 'string' || typeof item.email !== 'string') return [];
    return [{ displayName: item.displayName, email: item.email }];
  });
}

export function parseApiProblem(payload: unknown): ApiProblem | null {
  if (!isRecord(payload)) return null;
  return {
    type: typeof payload.type === 'string' ? payload.type : undefined,
    title: typeof payload.title === 'string' ? payload.title : undefined,
    status: typeof payload.status === 'number' ? payload.status : undefined,
    detail: typeof payload.detail === 'string' ? payload.detail : undefined,
    instance: typeof payload.instance === 'string' ? payload.instance : undefined,
    code: typeof payload.code === 'string' ? payload.code : undefined,
    correlationId: typeof payload.correlationId === 'string' ? payload.correlationId : undefined,
    administrators: parseAdministrators(payload.administrators),
    errors: parseFieldErrors(payload.errors),
  };
}

export class ResourceAllocationApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly problem: ApiProblem | null,
    fallbackMessage: string,
    errorName: string,
  ) {
    super(problem?.detail ?? problem?.title ?? fallbackMessage);
    this.name = errorName;
  }
}

export type ResourceAllocationApiErrorConstructor = new (
  status: number | null,
  problem: ApiProblem | null,
) => ResourceAllocationApiError;

export function throwApiRequestError(
  error: unknown,
  ErrorType: ResourceAllocationApiErrorConstructor,
): never {
  if (!axios.isAxiosError(error)) throw error;
  throw new ErrorType(error.response?.status ?? null, parseApiProblem(error.response?.data));
}
