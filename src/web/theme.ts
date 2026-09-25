import { useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';

const KEY = 'sp-theme';
const media = (): MediaQueryList | null => (typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null);

/** Выбор темы — удобство одного браузера: хранится в localStorage, без него просто светлая. */
export function readTheme(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === 'dark' || value === 'system' ? value : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const dark = choice === 'dark' || (choice === 'system' && media()?.matches === true);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/** Тема приложения: светлая по умолчанию (решение 20.09), тёмная и «как в системе» — переключателем. */
export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);

  useEffect(() => {
    applyTheme(choice);
    if (choice !== 'system') return undefined;
    const query = media();
    const follow = (): void => applyTheme('system');
    query?.addEventListener('change', follow);
    return () => query?.removeEventListener('change', follow);
  }, [choice]);

  const set = (next: ThemeChoice): void => {
    setChoice(next);
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // приватное окно или запрет хранилища: тема действует до перезагрузки
    }
  };
  return [choice, set];
}
