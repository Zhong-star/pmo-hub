import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { ResourceAllocationProblemDto } from './access-response.dto';
import { localProfileChallenge } from './resource-allocation-problem';

export function ProblemResponse(status: number, description: string) {
  return ApiResponse({
    status,
    description,
    content: {
      'application/problem+json': { schema: { $ref: getSchemaPath(ResourceAllocationProblemDto) } },
    },
    ...(status === 401
      ? { headers: { 'WWW-Authenticate': { schema: { type: 'string', example: localProfileChallenge } } } }
      : {}),
  });
}

export function ProtectedResourceProblems() {
  return applyDecorators(
    ApiExtraModels(ResourceAllocationProblemDto),
    ProblemResponse(401, 'A local Hub profile is required.'),
    ProblemResponse(403, 'The active module profile is not allowed to perform this operation.'),
    ProblemResponse(500, 'An unexpected server error occurred.'),
    ProblemResponse(503, 'The Resource Allocation database is unavailable.'),
  );
}
