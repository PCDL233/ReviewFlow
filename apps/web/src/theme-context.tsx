import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

export type ThemeMode = 'light' | 'dark';

type ThemeContextValue = {
  mode: ThemeMode;
  toggle: () => void;
};

const themeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'reviewflow-theme';

function readInitialMode(): ThemeMode {
  const preset = document.documentElement.dataset.theme;
  if (preset === 'dark' || preset === 'light') return preset;
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider(props: { children: ReactNode }): ReactElement {
  const [mode, setMode] = useState<ThemeMode>(readInitialMode);

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
    window.localStorage.setItem(STORAGE_KEY, mode);
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta !== null) meta.content = mode === 'dark' ? '#0b1220' : '#f6f7fb';
  }, [mode]);

  // React Compiler 会自动 memo 化该对象；不要手写 useMemo。
  const value: ThemeContextValue = {
    mode,
    toggle: () => setMode((current) => (current === 'light' ? 'dark' : 'light')),
  };

  return <themeContext.Provider value={value}>{props.children}</themeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(themeContext);
  if (value === null) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
