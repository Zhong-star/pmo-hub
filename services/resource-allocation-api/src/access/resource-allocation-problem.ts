import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  ValidationPipe,
  type Type,
  type ValidationError,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AdministratorContactDto } from './access-response.dto';
import { isDatabaseUnavailable } from '../database/database-errors';

export const localProfileHeader = 'X-PMO-Local-User-ID';
export const localProfileChallenge = 'LocalProfile realm="Tech Resource Allocation"';

export interface ResourceAllocationFieldError {
  path: string;
  code: string;
  message: string;
}

export class ResourceAllocationException extends HttpException {
  constructor(
    readonly code: string,
    readonly title: string,
    status: number,
    readonly detail: string,
    readonly administrators?: AdministratorContactDto[],
    cause?: unknown,
    readonly errors?: ResourceAllocationFieldError[],
  ) {
    super(detail, status, { cause });
  }
}

export function translateResourceAllocationDatabaseError(
  error: unknown,
  unavailableDetail = 'The Resource Allocation database is unavailable or not prepared.',
): ResourceAllocationException {
  if (error instanceof ResourceAllocationException) return error;
  if (isDatabaseUnavailable(error)) {
    return new ResourceAllocationException(
      'DEPENDENCY_UNAVAILABLE',
      'Dependency unavailable',
      503,
      unavailableDetail,
      undefined,
      error,
    );
  }
  return new ResourceAllocationException(
    'INTERNAL_ERROR',
    'Internal Server Error',
    500,
    'Internal Server Error',
    undefined,
    error,
  );
}

function toFieldErrorCode(constraintKey: string): string {
  const normalized = constraintKey
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return normalized || 'INVALID_FIELD';
}

function flattenValidationErrors(errors: ValidationError[], parentPath = ''): ResourceAllocationFieldError[] {
  const fields: ResourceAllocationFieldError[] = [];
  for (const error of errors) {
    const path = parentPath
      ? (error.property ? `${parentPath}.${error.property}` : parentPath)
      : error.property;
    if (error.constraints) {
      for (const [constraintKey, message] of Object.entries(error.constraints)) {
        fields.push({
          path: path || 'body',
          code: toFieldErrorCode(constraintKey),
          message: typeof message === 'string' && message.trim().length > 0 ? message : 'Invalid value.',
        });
      }
    }
    if (error.children && error.children.length > 0) {
      fields.push(...flattenValidationErrors(error.children, path));
    }
  }
  return fields;
}

export function createValidationException(errors: ValidationError[]): ResourceAllocationException {
  const fieldErrors = flattenValidationErrors(errors);
  return new ResourceAllocationException(
    'VALIDATION_ERROR',
    'Request validation failed',
    400,
    'One or more fields are invalid.',
    undefined,
    undefined,
    fieldErrors.length > 0 ? fieldErrors : undefined,
  );
}

export function createValidationPipe(expectedType?: Type<unknown>): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    ...(expectedType ? { expectedType } : {}),
    exceptionFactory: createValidationException,
  });
}

interface ProblemResponse {
  setHeader(name: string, value: string): void;
  status(code: number): ProblemResponse;
  json(body: Record<string, unknown>): void;
}

interface ProblemRequest {
  path: string;
  headers: Record<string, unknown>;
}

function standardProblem(status: number): { code: string; title: string; detail: string } {
  if (status === 400) return { code: 'VALIDATION_ERROR', title: 'Request validation failed', detail: 'One or more fields are invalid.' };
  if (status === 401) return { code: 'AUTHENTICATION_REQUIRED', title: 'Local profile required', detail: 'Select a local Hub profile.' };
  if (status === 403) return { code: 'ACCESS_DENIED', title: 'Access denied', detail: 'You do not have permission to access this resource.' };
  if (status === 404) return { code: 'RESOURCE_NOT_FOUND', title: 'Resource not found', detail: 'The requested resource was not found.' };
  if (status === 503) return { code: 'DEPENDENCY_UNAVAILABLE', title: 'Dependency unavailable', detail: 'A required service is unavailable.' };
  return { code: 'INTERNAL_ERROR', title: 'Internal Server Error', detail: 'Internal Server Error' };
}

@Catch()
export class ResourceAllocationProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<ProblemRequest>();
    const response = http.getResponse<ProblemResponse>();
    const status = isDatabaseUnavailable(exception)
      ? 503
      : exception instanceof HttpException ? exception.getStatus() : 500;
    const defaults = standardProblem(status);
    const problem = exception instanceof ResourceAllocationException
      ? exception
      : undefined;
    const suppliedId = request.headers['x-correlation-id'];
    const correlationId = typeof suppliedId === 'string' &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(suppliedId)
      ? suppliedId : randomUUID();

    const fieldErrors = problem?.errors && problem.errors.length > 0 && status < 500
      ? problem.errors
      : undefined;

    response.setHeader('Content-Type', 'application/problem+json');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Correlation-ID', correlationId);
    if (status === 401) response.setHeader('WWW-Authenticate', localProfileChallenge);
    response.status(status).json({
      type: `https://pmo-hub.example/problems/${(problem?.code ?? defaults.code).toLowerCase().replaceAll('_', '-')}`,
      title: problem?.title ?? defaults.title,
      status,
      detail: problem?.detail ?? defaults.detail,
      instance: request.path,
      code: problem?.code ?? defaults.code,
      correlationId,
      ...(problem?.administrators ? { administrators: problem.administrators } : {}),
      ...(fieldErrors ? { errors: fieldErrors } : {}),
    });
  }
}
