import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'pmo-hub.theme';
const LEGACY_THEME_STORAGE_KEY = 'pmo-hub.lessons-learned.theme';

function isTheme(value: string | null): value is Theme {
  return value === 'light' || value === 'dark';
}

interface ThemePreference {
  theme: Theme;
  copyLegacyTheme: boolean;
  clearLegacyTheme: boolean;
}

function readThemePreference(): ThemePreference {
  try {
    const savedTheme = window.sessionStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(savedTheme)) {
      return { theme: savedTheme, copyLegacyTheme: false, clearLegacyTheme: true };
    }

    if (savedTheme === null) {
      const legacyTheme = window.sessionStorage.getItem(LEGACY_THEME_STORAGE_KEY);
      if (isTheme(legacyTheme)) {
        return { theme: legacyTheme, copyLegacyTheme: true, clearLegacyTheme: true };
      }
    }
  } catch {
    // Default to light when session storage is unavailable.
  }

  return { theme: 'light', copyLegacyTheme: false, clearLegacyTheme: false };
}

function migrateThemePreference(preference: ThemePreference): void {
  try {
    if (preference.copyLegacyTheme) window.sessionStorage.setItem(THEME_STORAGE_KEY, preference.theme);
    if (preference.clearLegacyTheme) window.sessionStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
  } catch {
    // Keep the in-memory preference if browser storage is unavailable.
  }
}

export function useThemePreference(): { theme: Theme; selectTheme: (theme: Theme) => void } {
  const [theme, setTheme] = useState<Theme>(() => readThemePreference().theme);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    migrateThemePreference(readThemePreference());

    function restoreThemePreference() {
      const preference = readThemePreference();
      migrateThemePreference(preference);
      setTheme(preference.theme);
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
