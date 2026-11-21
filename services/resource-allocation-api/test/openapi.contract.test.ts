import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type OpenApiDocument = {
  paths: Record<string, Record<string, {
    parameters?: Array<{ name?: string; required?: boolean }>;
    security?: Array<Record<string, unknown>>;
    responses: Record<string, {
      content?: Record<string, unknown>;
      headers?: Record<string, unknown>;
    }>;
  }>>;
  components: { schemas: Record<string, { properties?: Record<string, { enum?: string[] }> }> };
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
});
