// Light/dark theme: remembered in storage, defaults to the operating system preference.
import { z } from 'zod';
import { loadStored, saveStored } from './storage';

export type Theme = 'light' | 'dark';
const themeSchema = z.enum(['light', 'dark']);
const listeners: (() => void)[] = [];

/** Returns the saved theme, or the OS preference on first run. */
export function initialTheme(): Theme {
  const osDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  return loadStored<Theme>('theme', themeSchema, osDark ? 'dark' : 'light');
}

/** Current theme as applied to the document. */
export function currentTheme(): Theme {
  return document.documentElement.dataset['theme'] === 'dark' ? 'dark' : 'light';
}

/** Applies and saves a theme, then tells canvas/chart components to repaint. */
export function setTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme;
  saveStored('theme', theme);
  for (const l of listeners) l();
}

/** Registers a callback for theme changes. */
export function onThemeChange(fn: () => void): void {
  listeners.push(fn);
}

/** Reads a CSS custom property (design token) from the document, for canvas/chart drawing. */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
