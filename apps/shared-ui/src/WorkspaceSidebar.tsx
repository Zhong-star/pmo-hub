import { useRef, type ReactNode } from 'react';
import { ChevronDownIcon, MenuIcon } from './Icons';
import './WorkspaceSidebar.css';

export function WorkspaceSidebar({
  label,
  navigationLabel,
  navigationId,
  open,
  onToggle,
  children,
}: {
  label: string;
  navigationLabel: string;
  navigationId: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const toggleRef = useRef<HTMLButtonElement>(null);

  return (
    <aside
      className="workspace-sidebar"
      aria-label={label}
      data-menu-open={open}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open || !toggleRef.current?.getClientRects().length) return;
        event.preventDefault();
        onToggle();
        toggleRef.current.focus();
      }}
    >
      <button
        ref={toggleRef}
        className="workspace-menu-toggle"
        type="button"
        aria-controls={navigationId}
        aria-expanded={open}
        onClick={onToggle}
      >
        <MenuIcon size={16} />
        <span>Module menu</span>
        <ChevronDownIcon size={15} className="ui-icon workspace-menu-toggle__chevron" />
      </button>
      <nav className="workspace-navigation" id={navigationId} aria-label={navigationLabel}>
        {children}
      </nav>
    </aside>
  );
}
