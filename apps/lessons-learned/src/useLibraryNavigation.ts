import { useCallback, useEffect, useState } from 'react';

const LIBRARY_DETAIL_PARAMETER = 'lesson';
const LIBRARY_LIST_ORIGIN_KEY = '__pmoHubLessonsLibraryListOrigin';

function readLibraryLessonId(): number | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get('page') !== 'library') return null;

  const value = params.get(LIBRARY_DETAIL_PARAMETER);
  if (!value || !/^\d+$/.test(value)) return null;
  const lessonId = Number(value);
  return Number.isSafeInteger(lessonId) && lessonId > 0 ? lessonId : null;
}

function toRelativeUrl(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

export function getLibraryLessonHref(lessonId: number): string {
  const url = new URL(window.location.href);
  url.searchParams.set('page', 'library');
  url.searchParams.set(LIBRARY_DETAIL_PARAMETER, String(lessonId));
  return toRelativeUrl(url);
}

export function useLibraryNavigation() {
  const [lessonId, setLessonId] = useState(readLibraryLessonId);

  useEffect(() => {
    function syncFromLocation() {
      setLessonId(readLibraryLessonId());
    }
    window.addEventListener('popstate', syncFromLocation);
    return () => window.removeEventListener('popstate', syncFromLocation);
  }, []);

  const openLesson = useCallback((nextLessonId: number) => {
    if (!Number.isSafeInteger(nextLessonId) || nextLessonId < 1) return;

    const url = new URL(window.location.href);
    url.searchParams.set('page', 'library');
    url.searchParams.set(LIBRARY_DETAIL_PARAMETER, String(nextLessonId));
    const state = typeof window.history.state === 'object' && window.history.state !== null
      ? window.history.state
      : {};
    window.history.pushState({ ...state, [LIBRARY_LIST_ORIGIN_KEY]: true }, '', toRelativeUrl(url));
    setLessonId(nextLessonId);
  }, []);

  const closeLesson = useCallback(() => {
    const state = window.history.state;
    if (typeof state === 'object' && state !== null && state[LIBRARY_LIST_ORIGIN_KEY] === true) {
      window.history.back();
      return;
    }

    const url = new URL(window.location.href);
    url.searchParams.set('page', 'library');
    url.searchParams.delete(LIBRARY_DETAIL_PARAMETER);
    window.history.replaceState(state, '', toRelativeUrl(url));
    setLessonId(null);
  }, []);

  const clearLesson = useCallback(() => setLessonId(null), []);

  return { lessonId, openLesson, closeLesson, clearLesson };
}
