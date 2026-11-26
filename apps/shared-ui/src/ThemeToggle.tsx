import type { Theme } from './theme';

export interface ThemeToggleProps {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  className?: string;
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M12 2.5v2.25M12 19.25v2.25M4.75 4.75l1.6 1.6M17.65 17.65l1.6 1.6M2.5 12h2.25M19.25 12h2.25M4.75 19.25l1.6-1.6M17.65 6.35l1.6-1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M20.25 14.6A8.25 8.25 0 0 1 9.4 3.75a8.25 8.25 0 1 0 10.85 10.85Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Single icon button that toggles the color theme.
 * The icon shows the active theme (sun = light, moon = dark); the button is a
 * pressed/unpressed "Dark theme" toggle for assistive technology.
 */
export function ThemeToggle({ theme, onThemeChange, className }: ThemeToggleProps) {
  const isDark = theme === 'dark';
  const actionLabel = isDark ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button
      type="button"
      className={className ? `theme-toggle ${className}` : 'theme-toggle'}
      aria-label="Dark theme"
      aria-pressed={isDark}
      title={actionLabel}
      data-theme-icon={isDark ? 'moon' : 'sun'}
      onClick={() => onThemeChange(isDark ? 'light' : 'dark')}
    >
      {isDark ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}
