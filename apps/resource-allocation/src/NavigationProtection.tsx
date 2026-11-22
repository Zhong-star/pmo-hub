import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

interface FormProtectionState {
  isDirty: boolean;
  isPending: boolean;
}

interface NavigationProtectionContextValue {
  isDirty: boolean;
  isPending: boolean;
  notice: string;
  guardNavigation: (navigate?: () => void, formIds?: readonly string[]) => boolean;
  allowUnloadOnce: () => void;
  reportFormState: (id: string, state: FormProtectionState) => void;
  removeForm: (id: string) => void;
}

const NavigationProtectionContext = createContext<NavigationProtectionContextValue | null>(null);

export function NavigationProtectionProvider({ children }: { children: ReactNode }) {
  const formStatesRef = useRef(new Map<string, FormProtectionState>());
  const allowUnloadRef = useRef(false);
  const [formStates, setFormStates] = useState(() => new Map<string, FormProtectionState>());

  const reportFormState = useCallback((id: string, state: FormProtectionState) => {
    const current = formStatesRef.current.get(id);
    if (current?.isDirty === state.isDirty && current.isPending === state.isPending) return;
    const next = new Map(formStatesRef.current);
    next.set(id, state);
    formStatesRef.current = next;
    setFormStates(next);
  }, []);

  const removeForm = useCallback((id: string) => {
    if (!formStatesRef.current.has(id)) return;
    const next = new Map(formStatesRef.current);
    next.delete(id);
    formStatesRef.current = next;
    setFormStates(next);
  }, []);

  const isDirty = [...formStates.values()].some((state) => state.isDirty);
  const isPending = [...formStates.values()].some((state) => state.isPending);
  const notice = isPending ? 'A save is in progress. Navigation will be available when it finishes.' : '';

  const guardNavigation = useCallback((navigate?: () => void, formIds?: readonly string[]) => {
    const states = formIds
      ? formIds.map((id) => formStatesRef.current.get(id)).filter((state): state is FormProtectionState => Boolean(state))
      : [...formStatesRef.current.values()];

    if (states.some((state) => state.isPending)) return false;

    if (states.some((state) => state.isDirty) && !window.confirm('You have unsaved changes. Discard them and continue?')) return false;

    navigate?.();
    return true;
  }, []);

  const allowUnloadOnce = useCallback(() => {
    allowUnloadRef.current = true;
  }, []);

  useEffect(() => {
    if (!isDirty && !isPending) return;

    function protectUnload(event: BeforeUnloadEvent) {
      if (allowUnloadRef.current) {
        allowUnloadRef.current = false;
        return;
      }
      event.preventDefault();
      event.returnValue = '';
    }

    window.addEventListener('beforeunload', protectUnload);
    return () => window.removeEventListener('beforeunload', protectUnload);
  }, [isDirty, isPending]);

  const value = useMemo(() => ({
    isDirty,
    isPending,
    notice,
    guardNavigation,
    allowUnloadOnce,
    reportFormState,
    removeForm,
  }), [allowUnloadOnce, guardNavigation, isDirty, isPending, notice, removeForm, reportFormState]);

  return (
    <NavigationProtectionContext.Provider value={value}>
      {children}
    </NavigationProtectionContext.Provider>
  );
}

export function useNavigationProtection() {
  const value = useContext(NavigationProtectionContext);
  if (!value) throw new Error('useNavigationProtection must be used inside NavigationProtectionProvider.');
  return value;
}

export function useNavigationFormProtection(formName: string, isDirty: boolean, isPending: boolean) {
  const { guardNavigation, reportFormState, removeForm } = useNavigationProtection();
  const instanceId = useId();
  const formId = `${formName}:${instanceId}`;

  useEffect(() => {
    reportFormState(formId, { isDirty, isPending });
    return () => removeForm(formId);
  }, [formId, isDirty, isPending, removeForm, reportFormState]);

  return useCallback((navigate: () => void) => guardNavigation(navigate, [formId]), [formId, guardNavigation]);
}
