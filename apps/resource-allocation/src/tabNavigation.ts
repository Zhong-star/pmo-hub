import type { KeyboardEvent } from 'react';

export function handleTabListKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
  const indexForKey: Record<string, (current: number, length: number) => number> = {
    ArrowRight: (current, length) => (current + 1) % length,
    ArrowLeft: (current, length) => (current - 1 + length) % length,
    Home: () => 0,
    End: (_current, length) => length - 1,
  };
  const nextIndexFor = indexForKey[event.key];
  if (!nextIndexFor) return;

  const tabList = event.currentTarget.closest('[role="tablist"]');
  const tabs = Array.from(tabList?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') ?? []);
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex < 0 || tabs.length < 1) return;

  event.preventDefault();
  const nextTab = tabs[nextIndexFor(currentIndex, tabs.length)];
  nextTab.focus();
  nextTab.click();
}
