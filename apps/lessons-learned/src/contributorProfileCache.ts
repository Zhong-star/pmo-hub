import type { InfiniteData } from '@tanstack/react-query';
import type { ContributorProfileResponse, LibraryLesson } from './api';

export function updateProfileLesson(
  current: InfiniteData<ContributorProfileResponse> | undefined,
  lessonId: number,
  update: (lesson: LibraryLesson) => LibraryLesson,
): InfiniteData<ContributorProfileResponse> | undefined {
  if (!current) return current;
  const previous = current.pages.flatMap((page) => page.items).find((item) => item.id === lessonId);
  if (!previous) return current;
  const updated = update(previous);
  return {
    ...current,
    pages: current.pages.map((page) => ({
      ...page,
      profile: {
        ...page.profile,
        votesReceivedCount: Math.max(0, page.profile.votesReceivedCount + updated.votesCount - previous.votesCount),
        viewsReceivedCount: page.profile.viewsReceivedCount + updated.viewCount - previous.viewCount,
      },
      items: page.items.map((item) => item.id === lessonId ? updated : item),
    })),
  };
}
