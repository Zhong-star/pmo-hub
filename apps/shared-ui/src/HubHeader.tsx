import { useRef, useState } from 'react';
import type { Theme } from './theme';
import './HubHeader.css';

export interface HubHeaderProps {
  profileName?: string;
  onChangeProfile?: () => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}

export function HubHeader({ profileName, onChangeProfile, theme, onThemeChange }: HubHeaderProps) {
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const profileMenuTrigger = useRef<HTMLButtonElement>(null);
  const canChangeProfile = Boolean(profileName && onChangeProfile);

  return (
    <header className="hub-header">
      <a className="hub-header__brand" href="/" aria-label="PMO Hub">
        <span className="hub-header__mark" aria-hidden="true">P</span>
        <span>PMO Hub</span>
      </a>

      {canChangeProfile && profileName && onChangeProfile ? (
        <div
          className="hub-header__profile"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setIsProfileMenuOpen(false);
              profileMenuTrigger.current?.focus();
            }
          }}
        >
          <button
            ref={profileMenuTrigger}
            className="hub-header__profile-trigger"
            type="button"
            aria-label={profileName}
            aria-expanded={isProfileMenuOpen}
            aria-controls="hub-profile-menu"
            onClick={() => setIsProfileMenuOpen((isOpen) => !isOpen)}
          >
            <span>{profileName}</span>
            <span className="hub-header__chevron" aria-hidden="true">⌄</span>
          </button>
          <div
            className="hub-header__profile-menu"
            id="hub-profile-menu"
            aria-label="Profile actions"
            hidden={!isProfileMenuOpen}
          >
            <div className="hub-header__theme-controls" role="group" aria-label="Color theme">
              <button
                type="button"
                aria-pressed={theme === 'light'}
                onClick={() => onThemeChange('light')}
              >
                Light
              </button>
              <button
                type="button"
                aria-pressed={theme === 'dark'}
                onClick={() => onThemeChange('dark')}
              >
                Dark
              </button>
            </div>
            <div className="hub-header__menu-divider" aria-hidden="true" />
            <button
              type="button"
              onClick={() => {
                setIsProfileMenuOpen(false);
                onChangeProfile();
              }}
            >
              Change profile
            </button>
          </div>
        </div>
      ) : (
        <span className="hub-header__context">Select a local profile</span>
      )}
    </header>
  );
}
