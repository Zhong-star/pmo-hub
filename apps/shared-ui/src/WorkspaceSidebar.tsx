import { type ReactNode } from 'react';
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
  return (
    <aside className="workspace-sidebar" aria-label={label} data-menu-open={open}>
      <button
        className="workspace-menu-toggle"
        type="button"
        aria-controls={navigationId}
        aria-expanded={open}
        onClick={onToggle}
      >
        Module menu
      </button>
      <nav className="workspace-navigation" id={navigationId} aria-label={navigationLabel}>
        {children}
      </nav>
    </aside>
  );
}
