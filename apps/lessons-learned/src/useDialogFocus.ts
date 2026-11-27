import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';

const inertShells = new WeakMap<HTMLElement, { dialogs: number; wasInert: boolean }>();

export function useDialogBackdropClose(onRequestClose: () => void) {
  const mouseDownOnBackdropRef = useRef(false);

  function isOutsideDialogBox(event: ReactMouseEvent<HTMLDialogElement>): boolean {
    if (event.target !== event.currentTarget) return false;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return true;
    return (
      event.clientX < rect.left
      || event.clientX > rect.right
      || event.clientY < rect.top
      || event.clientY > rect.bottom
    );
  }

  return {
    onMouseDown(event: ReactMouseEvent<HTMLDialogElement>) {
      mouseDownOnBackdropRef.current = isOutsideDialogBox(event);
    },
    onClick(event: ReactMouseEvent<HTMLDialogElement>) {
      const shouldClose = mouseDownOnBackdropRef.current && isOutsideDialogBox(event);
      mouseDownOnBackdropRef.current = false;
      if (shouldClose) onRequestClose();
    },
  };
}

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
    const shellState = appShell && (inertShells.get(appShell) ?? {
      dialogs: 0,
      wasInert: appShell.hasAttribute('inert'),
    });

    function trapDialogTab(event: KeyboardEvent) {
      if (event.key !== 'Tab' || !dialog) return;
      const focusableElements = [...dialog.querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, [tabindex]',
      )].filter((element) => element.tabIndex >= 0
        && !element.matches(':disabled, input[type="hidden"]')
        && !element.closest('[hidden], [inert]')
        && getComputedStyle(element).visibility === 'visible'
        && getComputedStyle(element).display !== 'none');
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

    if (appShell && shellState) {
      shellState.dialogs += 1;
      inertShells.set(appShell, shellState);
      appShell.setAttribute('inert', '');
    }
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    else dialog?.setAttribute('open', '');
    dialog?.addEventListener('keydown', trapDialogTab);
    initialFocusRef.current?.focus();

    return () => {
      dialog?.removeEventListener('keydown', trapDialogTab);
      if (dialog?.open && typeof dialog.close === 'function') dialog.close();
      else dialog?.removeAttribute('open');
      if (appShell && shellState && --shellState.dialogs === 0) {
        if (!shellState.wasInert) appShell.removeAttribute('inert');
        inertShells.delete(appShell);
      }

      if (returnFocus?.isConnected && returnFocus !== document.body && !returnFocus.closest('[inert]')) {
        returnFocus.focus();
      } else {
        (getReturnFocusTargetRef.current?.() ?? document.querySelector<HTMLElement>('#page-title'))?.focus();
      }
    };
  }, [dialogRef, initialFocusRef]);
}
