import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getHome } from './api';
import { getApiErrorCode, getApiErrorStatus } from './apiError';

const LOCAL_USER_STORAGE_KEY = 'pmo-hub.local-user-id';

export type InteractionEndReason = 'profile-changed' | 'access-lost';
type AccessFailure = 'authentication-required' | 'access-denied' | 'configuration-error';
type AccessStatus = AccessFailure | 'checking' | 'temporarily-unavailable' | 'recheck-unavailable' | null;

function readSelectedProfileId(): string | null {
  try {
    return window.localStorage.getItem(LOCAL_USER_STORAGE_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

function getAccessFailure(error: unknown): AccessFailure | null {
  const code = getApiErrorCode(error);
  const status = getApiErrorStatus(error);
  if (code === 'AUTHENTICATION_REQUIRED' || status === 401) return 'authentication-required';
  if (code === 'ACCESS_DENIED' || status === 403) return 'access-denied';
  if (code === 'ACCESS_CONFIGURATION_ERROR' || code === 'LOCAL_AUTH_DISABLED') return 'configuration-error';
  return null;
}

export function useLocalProfileSelection(onInteractionEnd: (reason: InteractionEndReason) => void) {
  const [selection, setSelection] = useState(() => ({ profileId: readSelectedProfileId(), generation: 0 }));
  const currentSelection = useRef(selection);
  const [confirmedSelection, setConfirmedSelection] = useState<typeof selection | null>(null);
  const { profileId: selectedProfileId, generation } = selection;

  const selectProfile = useCallback((profileId: string | null) => {
    const previous = currentSelection.current;
    if (previous.profileId === profileId) return;
    const next = { profileId, generation: previous.generation + 1 };
    currentSelection.current = next;
    setSelection(next);
    setConfirmedSelection(null);
    onInteractionEnd('profile-changed');
  }, [onInteractionEnd]);

  useEffect(() => {
    const restoreSelection = () => selectProfile(readSelectedProfileId());
    function handleStorageChange(event: StorageEvent) {
      if (event.key === null || event.key === LOCAL_USER_STORAGE_KEY) restoreSelection();
    }

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('pageshow', restoreSelection);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('pageshow', restoreSelection);
    };
  }, [selectProfile]);

  const homeQuery = useQuery({
    queryKey: ['lessons-learned-home', selectedProfileId, generation],
    queryFn: async () => {
      try {
        const home = await getHome(selectedProfileId ?? '');
        // Returning to the same profile still requires a new confirmation.
        if (currentSelection.current === selection) setConfirmedSelection(selection);
        return home;
      } catch (error) {
        if (currentSelection.current === selection && getAccessFailure(error)) {
          setConfirmedSelection(null);
        }
        throw error;
      }
    },
    enabled: selectedProfileId !== null,
    networkMode: 'always',
    retry: false,
    refetchOnWindowFocus: true,
  });

  const { refetch } = homeQuery;
  const recheckAccess = useCallback(() => { void refetch(); }, [refetch]);
  const recheckAccessOnError = useCallback((...errors: unknown[]) => {
    if (errors.some((error) => getAccessFailure(error) !== null)) recheckAccess();
  }, [recheckAccess]);
  const getSelectedProfileId = useCallback(() => currentSelection.current.profileId, []);

  function clearSelectedProfile() {
    try {
      window.localStorage.removeItem(LOCAL_USER_STORAGE_KEY);
    } catch {
      // The Hub can still present profile selection when storage is unavailable.
    }
    selectProfile(null);
  }

  const accessFailure = homeQuery.isError ? getAccessFailure(homeQuery.error) : null;
  const accessLost = accessFailure !== null;
  const endInteractionAfterAccessLoss = useEffectEvent(() => onInteractionEnd('access-lost'));
  useEffect(() => {
    if (accessLost) endInteractionAfterAccessLoss();
  }, [accessLost]);

  const home = confirmedSelection === selection && !accessFailure ? homeQuery.data : undefined;
  let accessStatus: AccessStatus = null;
  if (homeQuery.isFetching) {
    if (!home) accessStatus = 'checking';
  } else if (homeQuery.isError) {
    accessStatus = accessFailure ?? (home ? 'recheck-unavailable' : 'temporarily-unavailable');
  }

  return {
    selectedProfileId,
    getSelectedProfileId,
    clearSelectedProfile,
    home,
    accessStatus,
    recheckAccess,
    recheckAccessOnError,
  };
}
