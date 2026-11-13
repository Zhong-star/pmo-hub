import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';

export const localProfileHeader = 'X-PMO-Local-User-ID';
export const localProfileScheme = 'localProfile';
export const localProfileChallenge = 'LocalProfile realm="Lessons Learned"';

export class LocalAccessProblem {
  @ApiProperty({ type: String })
  type!: string;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: Number })
  status!: number;

  @ApiProperty({ type: String })
  detail!: string;

  @ApiProperty({ type: String })
  instance!: string;

  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  correlationId!: string;
}

export class LocalAccessException extends HttpException {
  constructor(
    readonly code: string,
    readonly title: string,
    status: number,
    readonly detail: string,
    cause?: unknown,
  ) {
    super(detail, status, { cause });
  }
}

interface ProblemResponse {
  setHeader(name: string, value: string): void;
  status(code: number): ProblemResponse;
  json(body: LocalAccessProblem): void;
}

@Catch(LocalAccessException)
export class LocalAccessProblemFilter implements ExceptionFilter {
  catch(exception: LocalAccessException, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<{ path: string; headers: Record<string, unknown> }>();
    const response = http.getResponse<ProblemResponse>();
    const status = exception.getStatus();
    const suppliedId = request.headers['x-correlation-id'];
    const correlationId = typeof suppliedId === 'string' &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(suppliedId)
      ? suppliedId : randomUUID();

    response.setHeader('Content-Type', 'application/problem+json');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Correlation-ID', correlationId);
    if (status === 401) response.setHeader('WWW-Authenticate', localProfileChallenge);
    response.status(status).json({
      type: `https://pmo-hub.example/problems/${exception.code.toLowerCase().replaceAll('_', '-')}`,
      title: exception.title,
      status,
      detail: exception.detail,
      instance: request.path,
      code: exception.code,
      correlationId,
    });
  }
}
