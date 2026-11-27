import { useRef, useState, type ReactNode } from 'react';
import { ChevronDownIcon, HubMarkIcon, SwitchUserIcon, UserIcon } from './Icons';
import type { Theme } from './theme';
import { ThemeToggle } from './ThemeToggle';
import './HubHeader.css';

export interface HubHeaderProps {
  profileName?: string;
  onChangeProfile?: () => void | boolean;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  actions?: ReactNode;
}

export function HubHeader({ profileName, onChangeProfile, theme, onThemeChange, actions }: HubHeaderProps) {
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const profileMenuTrigger = useRef<HTMLButtonElement>(null);
  const canChangeProfile = Boolean(profileName && onChangeProfile);

  return (
    <header className="hub-header">
      <a className="hub-header__brand" href="/" aria-label="PMO Hub">
        <span className="hub-header__mark" aria-hidden="true">
          <HubMarkIcon size={16} />
        </span>
        <span>PMO Hub</span>
      </a>

      <div className="hub-header__right">
        <ThemeToggle className="hub-header__theme-toggle" theme={theme} onThemeChange={onThemeChange} />
        {actions}
        {canChangeProfile && profileName && onChangeProfile && (
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
              <UserIcon size={16} className="ui-icon hub-header__profile-icon" />
              <span className="hub-header__profile-name">{profileName}</span>
              <ChevronDownIcon size={15} className="ui-icon hub-header__chevron" />
            </button>
            <div
              className="hub-header__profile-menu"
              id="hub-profile-menu"
              aria-label="Profile actions"
              hidden={!isProfileMenuOpen}
            >
              <button
                type="button"
                onClick={() => {
                  if (onChangeProfile() !== false) setIsProfileMenuOpen(false);
                }}
              >
                <SwitchUserIcon size={15} />
                <span>Change profile</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
