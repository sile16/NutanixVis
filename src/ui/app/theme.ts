import { useEffect } from 'react';

/** The simulator is dark only: set <html data-theme="dark"> (the CSS tokens key off it). */
export function useDarkTheme(): void {
  useEffect(() => {
    document.documentElement.dataset.theme = 'dark';
  }, []);
}
