import { api, throwApiRequestError } from './apiClient';
import { AdministrationRequestError } from './administrationApi';
import type { ApiQuery, ApiResponse } from './apiContracts';

const manageableGroupsPath = '/api/resource-allocation/v1/admin/resource-profile-groups';

export type ManageableProfileGroupPage = ApiResponse<typeof manageableGroupsPath, 'get'>;

export async function getManageableProfileGroups(
  localUserId: string,
  cursor: string | null,
): Promise<ManageableProfileGroupPage> {
  try {
    const response = await api.get<ManageableProfileGroupPage>(manageableGroupsPath, {
      headers: {
        'X-PMO-Local-User-ID': localUserId,
        'Cache-Control': 'no-cache',
      },
      params: { limit: 50, ...(cursor ? { cursor } : {}) } satisfies Partial<ApiQuery<typeof manageableGroupsPath, 'get'>>,
    });
    return response.data;
  } catch (error) {
    return throwApiRequestError(error, AdministrationRequestError);
  }
}
