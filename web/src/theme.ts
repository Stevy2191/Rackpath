// Light/dark theme, remembered in this browser.
export type Theme = 'light' | 'dark';

export function currentTheme(): Theme {
  try {
    const saved = localStorage.getItem('rackpath.theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* storage unavailable */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('rackpath.theme', t);
  } catch {
    /* storage unavailable */
  }
}
