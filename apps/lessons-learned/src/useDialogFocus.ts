import { useEffect, useRef, type RefObject } from 'react';

export function useDialogFocus(
  dialogRef: RefObject<HTMLDialogElement | null>,
  initialFocusRef: RefObject<HTMLElement | null>,
  getReturnFocusTarget?: () => HTMLElement | null,
) {
  const getReturnFocusTargetRef = useRef(getReturnFocusTarget);
  useEffect(() => {
    getReturnFocusTargetRef.current = getReturnFocusTarget;
  }, [getReturnFocusTarget]);

  useEffect(() => {
    const activeElement = document.activeElement;
    const returnFocus = activeElement instanceof HTMLElement ? activeElement : null;
    const dialog = dialogRef.current;
    const appShell = document.querySelector<HTMLElement>('.app-shell');
    const wasAppShellInert = appShell?.hasAttribute('inert') ?? false;

    function trapDialogTab(event: KeyboardEvent) {
      if (event.key !== 'Tab' || !dialog) return;
      const focusableElements = [...dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (!firstElement || !lastElement) return;

      const isFocusOutsideDialog = !dialog.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === firstElement || isFocusOutsideDialog)) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && (document.activeElement === lastElement || isFocusOutsideDialog)) {
        event.preventDefault();
        firstElement.focus();
      }
    }

    if (appShell) appShell.setAttribute('inert', '');
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    else dialog?.setAttribute('open', '');
    dialog?.addEventListener('keydown', trapDialogTab);
    initialFocusRef.current?.focus();

    return () => {
      dialog?.removeEventListener('keydown', trapDialogTab);
      if (dialog?.open && typeof dialog.close === 'function') dialog.close();
      else dialog?.removeAttribute('open');
      if (appShell && !wasAppShellInert) appShell.removeAttribute('inert');

      if (returnFocus?.isConnected) {
        returnFocus.focus();
      } else {
        (getReturnFocusTargetRef.current?.() ?? document.querySelector<HTMLElement>('#page-title'))?.focus();
      }
    };
  }, [dialogRef, initialFocusRef]);
}
