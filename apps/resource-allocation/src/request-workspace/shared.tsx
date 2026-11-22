import { useInfiniteQuery } from '@tanstack/react-query';
import type { RequestCategory } from '../submissionApi';
import { getSelectionCollection, SELECTIONS_QUERY_ROOT, SubmissionRequestError, type SelectionItem } from '../submissionApi';
import { RequestApiError, type ResourceRequestItem } from '../requestApi';

export interface RequestFormValues {
  initiativeId: string;
  category: RequestCategory;
  groupId: string;
  resourceProfileId: string;
  startDate: string;
  endDate: string;
  weeklyHours: string;
  comment: string;
}

export function rowsFromPages<T>(data: { pages: Array<{ items: T[] }> } | undefined): T[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

export function formValues(item: ResourceRequestItem): RequestFormValues {
  return {
    initiativeId: item.requestedConditions.initiativeId,
    category: item.requestedConditions.category,
    groupId: item.requestedConditions.groupId,
    resourceProfileId: item.requestedConditions.resourceProfileId,
    startDate: item.requestedConditions.startDate,
    endDate: item.requestedConditions.endDate,
    weeklyHours: String(item.requestedConditions.weeklyHours),
    comment: item.requestedConditions.comment ?? '',
  };
}

export function hasAccessError(error: unknown): boolean {
  return (error instanceof RequestApiError || error instanceof SubmissionRequestError)
    && (error.status === 401 || error.status === 403);
}

export function issueMutationError(error: unknown): string {
  if (error instanceof RequestApiError) return error.message;
  return 'The request could not be saved. Your form values are still available.';
}

export function useRequestSelectionQuery<C extends 'groups' | 'resource-profiles' | 'initiatives'>(localUserId: string, collection: C) {
  return useInfiniteQuery({
    queryKey: [...SELECTIONS_QUERY_ROOT, localUserId, collection],
    queryFn: ({ pageParam }) => getSelectionCollection(collection, localUserId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export type RequestSelections = {
  groups: SelectionItem<'groups'>[];
  profiles: SelectionItem<'resource-profiles'>[];
  initiatives: SelectionItem<'initiatives'>[];
};
