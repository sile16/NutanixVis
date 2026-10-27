import { useEffect, useState } from 'react';
import type { ThemePref } from '../store/ui-store';

const KEY = 'nutanixvis.theme';

export function loadThemePref(): ThemePref {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function saveThemePref(t: ThemePref): void {
  try {
    window.localStorage.setItem(KEY, t);
  } catch {
    // storage unavailable (private mode): the choice lasts for this page only
  }
}

/** Applies the theme to <html data-theme> and returns the resolved mode. */
export function useResolvedTheme(pref: ThemePref): 'light' | 'dark' {
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const resolved = pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);
  return resolved;
}
