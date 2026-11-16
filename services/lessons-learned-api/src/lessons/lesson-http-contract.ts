import {
  applyDecorators, type ArgumentsHost, BadRequestException, CallHandler, Catch, ExecutionContext, HttpException,
  Injectable, Logger, type ExceptionFilter, type NestInterceptor, type ValidationError,
} from '@nestjs/common';
import { ApiHeader, ApiProperty, ApiPropertyOptional, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { createHash, randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import { catchError, tap } from 'rxjs';
import { LocalAccessException, LocalAccessProblem } from '../local-access-problem';
import { emitsRepresentationTokens } from './lesson-token-format';

const problemMediaType = 'application/problem+json';
const correlationIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

class LessonFieldProblem {
  @ApiProperty({ type: String }) path!: string;
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) message!: string;
}

export class LessonProblem extends LocalAccessProblem {
  @ApiPropertyOptional({ type: [LessonFieldProblem] })
  errors?: LessonFieldProblem[];
}

class LessonProblemException extends HttpException {
  constructor(readonly problem: LessonProblem) {
    super(problem, problem.status);
  }
}

@Catch(LessonProblemException)
export class LessonProblemFilter implements ExceptionFilter {
  catch(exception: LessonProblemException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { json(body: LessonProblem): void };
    }>();
    response.status(exception.problem.status).json(exception.problem);
  }
}

export function ConditionalLessonWrite() {
  return applyDecorators(
    ApiHeader({ name: 'If-Match', required: false, description: 'Strong ETag from the displayed lesson. Legacy clients can supply version in the body.' }),
    ApiHeader({ name: 'Accept', required: false, description: 'Include application/problem+json for Problem Details errors and application/json for successful writes.' }),
    ApiResponse({ status: 412, description: 'The displayed lesson representation or its legacy version is stale.', content: {
      [problemMediaType]: { schema: { $ref: getSchemaPath(LessonProblem) } },
      'application/json': { schema: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } },
    } }),
  );
}

class RequestValidationException extends BadRequestException {
  constructor(readonly fields: LessonFieldProblem[]) {
    super(fields.map(({ message }) => message));
  }
}

export function requestValidationError(errors: ValidationError[]): BadRequestException {
  const fields: LessonFieldProblem[] = errors.flatMap((error) => Object.values(error.constraints ?? {}).map((message) => ({
    path: error.property, code: 'INVALID_FIELD', message,
  })));
  return new RequestValidationException(fields);
}

type LessonRepresentation = { id: number; version: number; status: string; etag?: string };

function isLesson(value: unknown): value is LessonRepresentation {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'number' &&
    'version' in value && typeof value.version === 'number' && 'status' in value && typeof value.status === 'string';
}

export function lessonRepresentationETag(value: LessonRepresentation, includeInBody: boolean): string {
  const representation = createHash('sha256').update(JSON.stringify([includeInBody, value])).digest('hex');
  return `"lesson-${value.id}-v${value.version}-${representation}"`;
}

export function isRepresentationETag(tag: string): boolean {
  return /-[a-f0-9]{64}"$/.test(tag);
}

function exposeETags(value: unknown, includeInBody: boolean, representationTokens: boolean): string | undefined {
  if (Array.isArray(value)) {
    if (includeInBody) value.forEach((item) => exposeETags(item, true, representationTokens));
  } else if (isLesson(value)) {
    const etag = representationTokens
      ? lessonRepresentationETag(value, includeInBody)
      : `"lesson-${value.id}-v${value.version}"`;
    if (includeInBody) value.etag = etag;
    return etag;
  } else if (includeInBody && typeof value === 'object' && value !== null && 'items' in value && Array.isArray(value.items)) {
    value.items.forEach((item) => exposeETags(item, true, representationTokens));
  }
}

function applyIfMatch(input: unknown, lessonId: string | undefined, ifMatch: string): void {
  const tag = /^"lesson-(\d+)-v([1-9]\d*)(?:-[a-f0-9]{64})?"$/.exec(ifMatch);
  const version = Number(tag?.[2]);
  if (!tag || Number(tag[1]) !== Number(lessonId) || !Number.isSafeInteger(version)) {
    throw new BadRequestException('If-Match must contain the ETag of this lesson.');
  }
  if (typeof input !== 'object' || !input || Array.isArray(input)) throw new BadRequestException('A JSON object is required.');
  if ('version' in input && input.version !== version) throw new BadRequestException('If-Match and version must agree.');
  Object.assign(input, { version });
}

const problemCodes: Record<number, string> = {
  400: 'VALIDATION_ERROR', 401: 'AUTHENTICATION_REQUIRED', 403: 'ACCESS_DENIED',
  404: 'RESOURCE_NOT_FOUND', 409: 'RESOURCE_CONFLICT', 412: 'PRECONDITION_FAILED',
  500: 'INTERNAL_ERROR', 503: 'DEPENDENCY_UNAVAILABLE',
};

@Injectable()
export class LessonHttpContract implements NestInterceptor {
  private readonly logger = new Logger(LessonHttpContract.name);
  private readonly representationTokens = emitsRepresentationTokens();

  intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp();
    const req = http.getRequest<{
      method: string; path: string; params: { id?: string }; body?: unknown;
      headers: Record<string, string | string[] | undefined>;
    }>();
    const res = http.getResponse<{ setHeader(name: string, value: string): void }>();
    const accept = req.headers.accept;
    const problemRequested = typeof accept === 'string' && accept.split(',').some((entry) => {
      const [mediaType, ...parameters] = entry.trim().toLowerCase().split(';');
      return mediaType.trim() === problemMediaType && !parameters.some((p) => /^q\s*=\s*0(?:\.0*)?$/.test(p.trim()));
    });
    const hasLessonWrite = req.params.id !== undefined && (req.method === 'PATCH' || req.method === 'POST');
    const ifMatch = hasLessonWrite ? req.headers['if-match'] : undefined;
    res.setHeader('Vary', 'Accept, X-PMO-Local-User-ID');

    const translateError = (error: unknown): never => {
      if (error instanceof LocalAccessException) throw error;
      const legacy = error instanceof HttpException ? error : undefined;
      const payload = legacy?.getResponse();
      const body = typeof payload === 'object' && payload !== null
        ? payload as { code?: string; message?: string | string[]; fieldErrors?: Record<string, string> }
        : undefined;
      const stale = ifMatch !== undefined && body?.code === 'STALE_LESSON_VERSION';
      const status = stale ? 412 : legacy?.getStatus() ?? 500;
      const code = stale ? 'PRECONDITION_FAILED' : body?.code ?? problemCodes[status] ?? 'REQUEST_FAILED';
      const detail = stale ? body?.message : payload && typeof payload === 'string' ? payload : body?.message;
      const message = typeof detail === 'string' ? detail : STATUS_CODES[status] ?? 'Request failed';
      if (!problemRequested) {
        if (stale) throw new HttpException({ code, message }, status);
        throw error;
      }
      if (!legacy) this.logger.error('Unexpected Lessons Learned API failure', error instanceof Error ? error.stack : undefined);

      const supplied = req.headers['x-correlation-id'];
      const correlationId = typeof supplied === 'string' && correlationIdPattern.test(supplied) ? supplied : randomUUID();
      const errors = error instanceof RequestValidationException ? error.fields :
        Object.entries(body?.fieldErrors ?? {}).map(([path, message]) => ({ path, code: 'INVALID_FIELD', message }));
      const problem: LessonProblem = {
        type: `https://pmo-hub.example/problems/${code.toLowerCase().replaceAll('_', '-')}`,
        title: STATUS_CODES[status] ?? 'Request failed', status,
        detail: status >= 500 ? STATUS_CODES[status] ?? 'Request failed' : message,
        instance: req.path, code, correlationId,
        ...(errors.length ? { errors } : {}),
      };
      res.setHeader('Content-Type', problemMediaType);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Correlation-ID', correlationId);
      throw new LessonProblemException(problem);
    };

    try {
      if (ifMatch !== undefined) {
        if (typeof ifMatch !== 'string') throw new BadRequestException('Send one If-Match value.');
        req.body ??= {};
        applyIfMatch(req.body, req.params.id, ifMatch);
      }
    } catch (error) {
      translateError(error);
    }
    return next.handle().pipe(
      tap((value: unknown) => {
        const etag = exposeETags(value, problemRequested, this.representationTokens);
        if (etag) res.setHeader('ETag', etag);
      }),
      catchError(translateError),
    );
  }
}
