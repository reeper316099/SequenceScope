// Typed, failure-tolerant wrapper around localStorage (it can throw or be empty; the app must work without it).
import type { z } from 'zod';

/** Reads a JSON value under `key` and validates it with `schema`; returns `fallback` on any problem. */
export function loadStored<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(`sequencescope:${key}`);
    if (raw === null) return fallback;
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

/** Stores a JSON value; silently ignores storage failures. */
export function saveStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(`sequencescope:${key}`, JSON.stringify(value));
  } catch {
    /* storage unavailable: preferences just won't persist */
  }
}
