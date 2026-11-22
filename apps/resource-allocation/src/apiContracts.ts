import type { components, paths } from './generated/resource-allocation-api';

type HttpMethod = 'delete' | 'get' | 'patch' | 'post' | 'put';
type Operation<Path extends keyof paths, Method extends HttpMethod> = Exclude<paths[Path][Method], undefined>;

type JsonBody<Response> = Response extends { content: infer Content }
  ? 'application/json' extends keyof Content
    ? Content['application/json']
    : never
  : never;

type JsonResponse<Responses> = Responses extends unknown
  ? JsonBody<Responses>
  : never;

type RequestBody<OperationType> = OperationType extends { requestBody: { content: infer Content } }
  ? Content[keyof Content]
  : never;

type QueryParameters<OperationType> = OperationType extends { parameters: infer Parameters }
  ? Parameters extends { query?: infer Query }
    ? Exclude<Query, undefined>
    : never
  : never;

export type ApiResponse<Path extends keyof paths, Method extends HttpMethod> =
  Operation<Path, Method> extends { responses: infer Responses }
    ? JsonResponse<Responses[keyof Responses]>
    : never;

export type ApiRequestBody<Path extends keyof paths, Method extends HttpMethod> =
  RequestBody<Operation<Path, Method>>;

export type ApiQuery<Path extends keyof paths, Method extends HttpMethod> =
  QueryParameters<Operation<Path, Method>>;

export type ApiPathParameters<Path extends keyof paths, Method extends HttpMethod> =
  Operation<Path, Method> extends { parameters: { path: infer Parameters } }
    ? Parameters
    : never;

export type ApiSchemas = components['schemas'];
export type ApiProblem = Partial<ApiSchemas['ResourceAllocationProblemDto']>;
export type ApiFieldError = ApiSchemas['ResourceAllocationFieldErrorDto'];
export type ApiAdministratorContact = ApiSchemas['AdministratorContactDto'];
