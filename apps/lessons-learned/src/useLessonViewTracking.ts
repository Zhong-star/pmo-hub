import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { recordLibraryView, type ContributorProfileResponse, type LessonDetails, type LibraryLesson, type LibraryPage } from './api';
import { updateProfileLesson } from './contributorProfileCache';

type DiscoverySurface = 'library' | 'contributor-profile';

type Opening = {
  profileId: string;
  surface: DiscoverySurface;
  lessonId: number;
  openingId: string;
};

type DiscoveryDetail = {
  surface: DiscoverySurface;
  lessonId: number;
  confirmedLesson: Pick<LessonDetails, 'id' | 'authorId'> | undefined;
};

function createOpeningId(): string {
  if (typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function updateLibraryPageViewCount(page: LibraryPage | LibraryLesson[], lessonId: number, viewCount: number) {
  const update = (lesson: LibraryLesson) => lesson.id === lessonId
    ? { ...lesson, viewCount: Math.max(lesson.viewCount, viewCount) }
    : lesson;
  return Array.isArray(page) ? page.map(update) : { ...page, items: page.items.map(update) };
}

export function useLessonViewTracking(profileId: string | null, detail: DiscoveryDetail | null) {
  const pendingOpening = useRef<Opening | null>(null);
  const queryClient = useQueryClient();
  const { mutate: recordView } = useMutation({
    mutationFn: ({ profileId, lessonId, openingId }: Opening & { authorId: string }) =>
      recordLibraryView(profileId, lessonId, { openingId }),
    retry: 2,
    networkMode: 'always',
    onSuccess: ({ viewCount }, opening) => {
      const { profileId, lessonId, authorId } = opening;
      queryClient.setQueriesData<InfiniteData<LibraryPage | LibraryLesson[]>>(
        { queryKey: ['lessons-learned-library', profileId] },
        (current) => current ? {
          ...current,
          pages: current.pages.map((page) => updateLibraryPageViewCount(page, lessonId, viewCount)),
        } : current,
      );
      const profiles = queryClient.getQueriesData<InfiniteData<ContributorProfileResponse>>({
        queryKey: ['lessons-learned-contributor-profile', profileId, authorId],
      });
      for (const [queryKey, current] of profiles) {
        const updated = updateProfileLesson(current, lessonId, (item) => ({
          ...item, viewCount: Math.max(item.viewCount, viewCount),
        }));
        if (updated === current) {
          // The aggregate includes lessons outside the loaded pages and filters.
          void queryClient.invalidateQueries({ queryKey, exact: true });
        } else {
          queryClient.setQueryData(queryKey, updated);
        }
      }
      void queryClient.invalidateQueries({ queryKey: ['lessons-learned-profiles', profileId] });
      void queryClient.invalidateQueries({ queryKey: ['lessons-learned-rankings', profileId] });
    },
  });

  const surface = detail?.surface;
  const lessonId = detail?.lessonId;
  const confirmedLesson = detail?.confirmedLesson;
  useEffect(() => {
    const opening = pendingOpening.current;
    if (!opening) return;
    if (opening.profileId !== profileId || opening.surface !== surface || opening.lessonId !== lessonId) {
      pendingOpening.current = null;
      return;
    }
    if (confirmedLesson?.id !== opening.lessonId) return;

    // Consume the opening once. Mutation retries keep its original identifier.
    pendingOpening.current = null;
    recordView({ ...opening, authorId: confirmedLesson.authorId });
  }, [confirmedLesson, lessonId, profileId, recordView, surface]);

  function beginOpening(surface: DiscoverySurface, lessonId: number) {
    if (!profileId) return;
    pendingOpening.current = { profileId, surface, lessonId, openingId: createOpeningId() };
  }

  function cancelPendingOpening() {
    pendingOpening.current = null;
  }

  return { beginOpening, cancelPendingOpening };
}
