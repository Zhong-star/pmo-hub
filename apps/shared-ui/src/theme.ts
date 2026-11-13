import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'pmo-hub.theme';
const LEGACY_THEME_STORAGE_KEY = 'pmo-hub.lessons-learned.theme';

function isTheme(value: string | null): value is Theme {
  return value === 'light' || value === 'dark';
}

function readThemePreference(): Theme {
  try {
    const savedTheme = window.sessionStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(savedTheme)) {
      window.sessionStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
      return savedTheme;
    }

    if (savedTheme === null) {
      const legacyTheme = window.sessionStorage.getItem(LEGACY_THEME_STORAGE_KEY);
      if (isTheme(legacyTheme)) {
        window.sessionStorage.setItem(THEME_STORAGE_KEY, legacyTheme);
        window.sessionStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
        return legacyTheme;
      }
    }
  } catch {
    // Default to light when session storage is unavailable.
  }

  return 'light';
}

export function useThemePreference(): { theme: Theme; selectTheme: (theme: Theme) => void } {
  const [theme, setTheme] = useState<Theme>(readThemePreference);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    function restoreThemePreference() {
      setTheme(readThemePreference());
    }

    window.addEventListener('pageshow', restoreThemePreference);
    return () => window.removeEventListener('pageshow', restoreThemePreference);
  }, []);

  const selectTheme = useCallback((nextTheme: Theme) => {
    setTheme(nextTheme);
    try {
      window.sessionStorage.setItem(THEME_STORAGE_KEY, nextTheme);
      window.sessionStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
    } catch {
      // Keep the current selection for this render if browser storage is unavailable.
    }
  }, []);

  return { theme, selectTheme };
}
