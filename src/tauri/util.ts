// Small helpers shared by the in-window checks (smoke, parity, bench). Only loaded in smoke mode.

/** Resolves after `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Waits (up to `ms`) until `test` returns true; resolves false on timeout. */
export async function waitFor(test: () => boolean, ms: number, step = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return true;
    await sleep(step);
  }
  return test();
}

/** One reported check. */
export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

/** Appends a check to a list (detail omitted when empty). */
export function addCheck(checks: Check[], name: string, pass: boolean, detail?: string): void {
  checks.push(detail === undefined || detail === '' ? { name, pass } : { name, pass, detail });
}

/** FNV-1a 32-bit hash of bytes as 8 hex digits (used to compare big tables across runs without printing them). */
export function fnv1a32(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] as number;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Hash of any typed array's raw bytes. */
export const hashTyped = (a: Int32Array | Uint8Array | Uint16Array | Float64Array | Uint32Array): string => fnv1a32(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));

/** The 64-bit pattern of a double as 16 hex digits (exact comparison of floating-point results across languages). */
export function bitsHex(x: number): string {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  return dv.getBigUint64(0).toString(16).padStart(16, '0');
}

const ulpView = new DataView(new ArrayBuffer(16));
/** Distance in units in the last place between two doubles (Infinity if the signs differ). */
export function ulpDistance(a: number, b: number): number {
  if (a === b) return 0;
  if (Math.sign(a) !== Math.sign(b)) return Infinity;
  ulpView.setFloat64(0, Math.abs(a)); ulpView.setFloat64(8, Math.abs(b));
  const d = ulpView.getBigUint64(0) - ulpView.getBigUint64(8);
  return Number(d < 0n ? -d : d);
}

/**
 * Path and values of the first difference between two JSON-like values, or null if they are equal. Object key order does not
 * matter; numbers may differ by up to `maxUlps` units in the last place (0 = exactly equal).
 */
export function jsonDiff(a: unknown, b: unknown, maxUlps = 0, path = '$'): string | null {
  if (typeof a === 'number' && typeof b === 'number') return ulpDistance(a, b) <= maxUlps || (Number.isNaN(a) && Number.isNaN(b)) ? null : `${path}: ${a} vs ${b}`;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b) || a === b ? null : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined).sort();
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined).sort();
  if (ka.join('\u0001') !== kb.join('\u0001')) return `${path}: keys [${ka.join(',')}] vs [${kb.join(',')}]`;
  for (const k of ka) {
    const d = jsonDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], maxUlps, Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`);
    if (d !== null) return d;
  }
  return null;
}
