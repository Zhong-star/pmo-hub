import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type OpenApiDocument = {
  paths: Record<string, Record<string, {
    parameters?: Array<{ name?: string; required?: boolean; schema?: { enum?: string[] } }>;
    security?: Array<Record<string, unknown>>;
    requestBody?: { content?: Record<string, unknown> };
    responses: Record<string, {
      content?: Record<string, unknown>;
      headers?: Record<string, unknown>;
    }>;
  }>>;
  components: {
    schemas: Record<string, {
      required?: string[];
      properties?: Record<string, {
        enum?: string[];
        $ref?: string;
        type?: string;
        items?: { $ref?: string };
      }>;
    }>;
  };
};

const contract = JSON.parse(
  readFileSync(resolve(process.cwd(), 'openapi/resource-allocation-v1.json'), 'utf8'),
) as OpenApiDocument;

describe('backend-owned Resource Allocation OpenAPI contract', () => {
  it('documents optional local profile access and RFC 9457 denial responses', () => {
    const access = contract.paths['/api/resource-allocation/v1/access'].get;
    expect(access.parameters).toContainEqual(expect.objectContaining({
      name: 'X-PMO-Local-User-ID',
      required: false,
    }));
    expect(access.security).toEqual(expect.arrayContaining([expect.objectContaining({ localProfile: [] }), {}]));
    expect(access.responses['401'].content).toHaveProperty('application/problem+json');
    expect(access.responses['401'].headers).toHaveProperty('WWW-Authenticate');
    expect(access.responses['403'].content).toHaveProperty('application/problem+json');
    expect(access.responses['503'].content).toHaveProperty('application/problem+json');
    expect(access.responses['500'].content).toHaveProperty('application/problem+json');
  });

  it('documents the five canonical module roles and the three health checks', () => {
    const personSchema = contract.components.schemas.ResourcePersonAccessDto;
    expect(personSchema.properties?.role?.enum).toEqual([
      'ALLOCATION_USER',
      'ALLOCATION_MODERATOR',
      'ALLOCATION_SUPERVISOR',
      'ALLOCATION_MANAGER',
      'ALLOCATION_ADMIN',
    ]);
    expect(contract.paths).toHaveProperty('/health/live');
    expect(contract.paths).toHaveProperty('/health/ready');
    expect(contract.paths).toHaveProperty('/health/startup');
  });

  it('documents Admin create idempotency, conditional edits, and ETags only for mutable items', () => {
    const collection = contract.paths['/api/resource-allocation/v1/admin/initiatives'];
    const create = collection.post;
    expect(create.parameters).toContainEqual(expect.objectContaining({ name: 'Idempotency-Key', required: true }));
    expect(create.responses['201'].headers).toHaveProperty('Location');
    expect(create.responses['201'].headers).toHaveProperty('ETag');
    expect(create.responses['201'].headers).toHaveProperty('Idempotency-Replayed');
    expect(create.responses['409'].content).toHaveProperty('application/problem+json');
    expect(create.responses['401'].content).toHaveProperty('application/problem+json');

    const item = contract.paths['/api/resource-allocation/v1/admin/initiatives/{id}'];
    expect(item.get.responses['200'].headers).toHaveProperty('ETag');
    expect(item.patch.parameters).toContainEqual(expect.objectContaining({ name: 'If-Match', required: true }));
    expect(item.patch.requestBody?.content).toHaveProperty('application/merge-patch+json');
    expect(item.patch.responses['200'].headers).toHaveProperty('ETag');
    expect(item.patch.responses['412'].content).toHaveProperty('application/problem+json');
    expect(collection.get.responses['200'].headers ?? {}).not.toHaveProperty('ETag');
  });

  it('documents minimum selection projections without administrative identity fields', () => {
    const peopleList = contract.paths['/api/resource-allocation/v1/people'].get;
    const peopleSchema = contract.components.schemas.ResourcePersonSelectionDto;
    expect(peopleList.responses['200'].content).toHaveProperty('application/json');
    expect(peopleSchema.properties).toHaveProperty('id');
    expect(peopleSchema.properties).toHaveProperty('displayName');
    expect(peopleSchema.properties).toHaveProperty('groupId');
    expect(peopleSchema.properties).not.toHaveProperty('email');
    expect(peopleSchema.properties).not.toHaveProperty('localUserId');
    expect(peopleSchema.properties).not.toHaveProperty('role');
  });

  it('documents requester filtering, conditional edits, idempotent withdrawal, and protected audit reads', () => {
    const collection = contract.paths['/api/resource-allocation/v1/requests'];
    expect(collection.get.responses['200'].content).toHaveProperty('application/json');
    expect(collection.get.responses['200'].headers ?? {}).not.toHaveProperty('ETag');
    expect(collection.get.responses['400'].content).toHaveProperty('application/problem+json');

    const item = contract.paths['/api/resource-allocation/v1/requests/{id}'];
    expect(item.get.responses['200'].headers).toHaveProperty('ETag');
    expect(item.patch.parameters).toContainEqual(expect.objectContaining({ name: 'If-Match', required: true }));
    expect(item.patch.requestBody?.content).toHaveProperty('application/merge-patch+json');
    expect(item.patch.responses['200'].headers).toHaveProperty('ETag');
    expect(item.patch.responses['400'].content).toHaveProperty('application/problem+json');
    expect(item.patch.responses['412'].content).toHaveProperty('application/problem+json');

    const withdraw = contract.paths['/api/resource-allocation/v1/requests/{id}/withdrawals'].post;
    expect(withdraw.parameters).toContainEqual(expect.objectContaining({ name: 'If-Match', required: true }));
    expect(withdraw.parameters).toContainEqual(expect.objectContaining({ name: 'Idempotency-Key', required: true }));
    expect(withdraw.responses['409'].content).toHaveProperty('application/problem+json');

    const audit = contract.paths['/api/resource-allocation/v1/request-audits/{id}'].get;
    expect(audit.responses['200'].content).toHaveProperty('application/json');
    expect(audit.responses['404'].content).toHaveProperty('application/problem+json');
  });

  it('documents scoped notification reads, conditional marking, and whole-inbox idempotency', () => {
    const collection = contract.paths['/api/resource-allocation/v1/notifications'];
    expect(collection.get.parameters).toContainEqual(expect.objectContaining({ name: 'read', required: false }));
    expect(collection.get.responses['200'].content).toHaveProperty('application/json');
    expect(collection.get.responses['400'].content).toHaveProperty('application/problem+json');

    const markOne = contract.paths['/api/resource-allocation/v1/notifications/{id}/readings'].post;
    expect(markOne.parameters).toContainEqual(expect.objectContaining({ name: 'If-Match', required: true }));
    expect(markOne.parameters).toContainEqual(expect.objectContaining({ name: 'Idempotency-Key', required: true }));
    expect(markOne.responses['200'].headers).toHaveProperty('ETag');
    expect(markOne.responses['412'].content).toHaveProperty('application/problem+json');

    const markAll = contract.paths['/api/resource-allocation/v1/notification-readings'].post;
    expect(markAll.parameters).toContainEqual(expect.objectContaining({ name: 'Idempotency-Key', required: true }));
    expect(markAll.responses['200'].content).toHaveProperty('application/json');
    expect(markAll.responses['409'].content).toHaveProperty('application/problem+json');
  });

  it('documents revalidation, requester-response, and the conditional commands used by the request queue client', () => {
    const root = '/api/resource-allocation/v1';
    const queues = contract.paths[`${root}/request-queues/{queueCode}`].get;
    expect(queues.parameters?.find(({ name }) => name === 'queueCode')?.schema?.enum).toEqual([
      'presentation',
      'team-decision',
      'requester-response',
      'exceptions',
      'revalidation',
    ]);
    expect(queues.parameters?.find(({ name }) => name === 'decisionState')?.schema?.enum).toEqual(expect.arrayContaining([
      'APPROVED_WITH_CHANGES',
      'DENIED',
    ]));
    expect(contract.components.schemas.RequestQueueItemDto.properties?.originState?.enum).toContain('APPROVED_WITH_CHANGES');
    expect(contract.components.schemas.RequestQueueItemDto.properties?.nextResponsible).toMatchObject({
      oneOf: expect.arrayContaining([
        expect.objectContaining({ type: 'object' }),
        expect.objectContaining({ type: 'array' }),
      ]),
    });
    expect(contract.components.schemas.CorrectRequestReferencesDto.properties).toHaveProperty('personId');

    for (const operation of ['referrals', 'reference-corrections']) {
      const command = contract.paths[`${root}/requests/{id}/${operation}`].post;
      expect(command.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'If-Match', required: true }),
        expect.objectContaining({ name: 'Idempotency-Key', required: true }),
      ]));
      expect(command.responses['200'].content).toMatchObject({
        'application/json': { schema: { $ref: '#/components/schemas/RequestChangeReceiptDto' } },
      });
      expect(command.responses['200'].headers).toHaveProperty('Idempotency-Replayed');
      expect(command.responses['412'].content).toHaveProperty('application/problem+json');
    }
    expect(contract.components.schemas.RequestChangeReceiptDto.properties).toHaveProperty('version');
  });

  it('documents receipt schema on GET /submissions/{id} and generalized operation receipts without ETag on GET /operation-results/{attemptKey}', () => {
    const root = '/api/resource-allocation/v1';
    const submission = contract.paths[`${root}/submissions/{id}`].get;
    expect(submission.responses['200'].content).toMatchObject({
      'application/json': { schema: { $ref: '#/components/schemas/ResourceSubmissionResponseDto' } },
    });

    const operationResult = contract.paths[`${root}/operation-results/{attemptKey}`].get;
    const operationParam = operationResult.parameters?.find(({ name }) => name === 'operation');
    expect(operationParam).toMatchObject({ required: true });
    expect(operationParam?.schema?.enum).toEqual(expect.arrayContaining([
      'submission.create',
      'admin.createPerson',
      'admin.createGroup',
      'admin.createResourceProfile',
      'admin.createInitiative',
      'request.withdraw',
      'request.refer',
      'request.correctReferences',
      'request.administrativeRemoval',
      'request.approve',
      'request.acceptChanges',
      'request.deny',
      'request.contestDenial',
      'request.exception.escalate',
      'request.exception.recordStrategy',
      'request.exception.resolve',
      'request.exception.cancel',
      'request.cancelDenied',
      'allocation.suspend',
      'allocation.reserve',
      'allocation.resume',
      'allocation.activate',
      'allocation.complete',
      'allocation.cancel',
      'notifications.mark-one-read',
      'notifications.mark-all-read',
    ]));
    expect(operationParam?.schema?.enum).toHaveLength(26);
    expect(operationResult.responses['200'].headers ?? {}).not.toHaveProperty('ETag');
    expect(operationResult.responses['200'].content).toMatchObject({
      'application/json': {
        schema: {
          oneOf: expect.arrayContaining([
            { $ref: '#/components/schemas/ResourceSubmissionLineResponseDto' },
            { $ref: '#/components/schemas/ResourceSubmissionResponseDto' },
            { $ref: '#/components/schemas/ResourcePersonResponseDto' },
            { $ref: '#/components/schemas/ResourceGroupResponseDto' },
            { $ref: '#/components/schemas/ResourceProfileResponseDto' },
            { $ref: '#/components/schemas/ResourceInitiativeResponseDto' },
            { $ref: '#/components/schemas/ResourceRequestAuditEventResponseDto' },
            { $ref: '#/components/schemas/RequestChangeReceiptDto' },
            { $ref: '#/components/schemas/RemovedRequestReceiptDto' },
            { $ref: '#/components/schemas/ApproveRequestResponseDto' },
            { $ref: '#/components/schemas/RequestDecisionResponseDto' },
            { $ref: '#/components/schemas/AllocationViewDto' },
            { $ref: '#/components/schemas/ResourceNotificationDto' },
            { $ref: '#/components/schemas/ResourceNotificationReadAllDto' },
          ]),
        },
      },
    });
  });

  it('documents problem+json errors[], protected error statuses, and 401 WWW-Authenticate across every versioned API route', () => {
    const problemSchema = contract.components.schemas.ResourceAllocationProblemDto;
    expect(problemSchema.properties?.errors).toMatchObject({
      type: 'array',
      items: { $ref: '#/components/schemas/ResourceAllocationFieldErrorDto' },
    });
    expect(problemSchema.required ?? []).not.toContain('errors');

    const fieldErrorSchema = contract.components.schemas.ResourceAllocationFieldErrorDto;
    expect(fieldErrorSchema.properties).toHaveProperty('path');
    expect(fieldErrorSchema.properties).toHaveProperty('code');
    expect(fieldErrorSchema.properties).toHaveProperty('message');

    const apiPaths = Object.entries(contract.paths).filter(([path]) => path.startsWith('/api/resource-allocation/v1/'));
    expect(apiPaths.length).toBeGreaterThan(0);

    for (const [path, pathItem] of apiPaths) {
      for (const [method, operation] of Object.entries(pathItem)) {
        for (const status of ['401', '403', '500', '503']) {
          expect(operation.responses, `${method.toUpperCase()} ${path} missing ${status}`).toHaveProperty(status);
        }
        expect(operation.responses['401'].headers, `${method.toUpperCase()} ${path} missing WWW-Authenticate`).toHaveProperty('WWW-Authenticate');
        for (const [status, response] of Object.entries(operation.responses)) {
          const code = Number(status);
          if (code < 400 || code > 599) continue;
          expect(response.content, `${method.toUpperCase()} ${path} ${status} missing problem+json`).toMatchObject({
            'application/problem+json': { schema: { $ref: '#/components/schemas/ResourceAllocationProblemDto' } },
          });
        }
      }
    }
  });
});
