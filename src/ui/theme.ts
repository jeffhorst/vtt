export const DEFAULT_THEME_COLOR = '#facc15';
const GLOBAL_THEME_KEY = 'vtt-theme-color';

function parseHexRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

export function getSavedThemeColor(userId?: number | null): string {
  try {
    if (userId !== undefined && userId !== null) {
      const userColor = localStorage.getItem(`${GLOBAL_THEME_KEY}-${userId}`);
      if (userColor && parseHexRgb(userColor)) return userColor;
    }
    const globalColor = localStorage.getItem(GLOBAL_THEME_KEY);
    if (globalColor && parseHexRgb(globalColor)) return globalColor;
  } catch {
    // ignore storage failures
  }
  return DEFAULT_THEME_COLOR;
}

export function applyThemeColor(hex: string, userId?: number | null): void {
  const rgb = parseHexRgb(hex) ?? parseHexRgb(DEFAULT_THEME_COLOR)!;
  const root = document.documentElement.style;
  root.setProperty('--text-gold', hex);
  root.setProperty('--border-gold', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.40)`);
  root.setProperty(
    '--border-gold-strong',
    `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.75)`
  );
  root.setProperty('--accent-bg', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.18)`);

  try {
    localStorage.setItem(GLOBAL_THEME_KEY, hex);
    if (userId !== undefined && userId !== null) {
      localStorage.setItem(`${GLOBAL_THEME_KEY}-${userId}`, hex);
    }
  } catch {
    // ignore storage failures
  }
}
