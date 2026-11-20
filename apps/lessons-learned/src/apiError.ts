function getErrorResponse(error: unknown): object | null {
  if (typeof error !== 'object' || error === null || !('response' in error)) return null;
  const response = error.response;
  return typeof response === 'object' ? response : null;
}

export function getApiErrorCode(error: unknown): string | null {
  const response = getErrorResponse(error);
  if (!response || !('data' in response)) return null;
  const data = response.data;
  if (typeof data !== 'object' || data === null || !('code' in data)) return null;
  return typeof data.code === 'string' ? data.code : null;
}

export function getApiErrorStatus(error: unknown): number | null {
  const response = getErrorResponse(error);
  if (!response || !('status' in response)) return null;
  return typeof response.status === 'number' ? response.status : null;
}
