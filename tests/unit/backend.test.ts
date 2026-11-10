// The backend switch and the binary frame decoder (the Rust side of the frame is tested in src-tauri/src/frame.rs; the
// real Rust-to-page round trip is checked in the Tauri window by `SEQUENCESCOPE_SMOKE_MODE=parity`).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectedBackend } from '../../src/backend';
import { decodeFrame } from '../../src/backend/frame';

/** Builds a frame exactly as src-tauri/src/frame.rs documents it (an independent encoder, so the decoder is really tested). */
function buildFrame(json: string, tables: { kind: 0 | 1 | 2; name: string; values: number[] }[]): ArrayBuffer {
  const align8 = (n: number): number => Math.ceil(n / 8) * 8;
  const jsonBytes = new TextEncoder().encode(json);
  const size = (k: number): number => (k === 0 ? 4 : k === 1 ? 1 : 2);
  const headerEnd = align8(16 + 16 * tables.length + jsonBytes.length);
  const total = headerEnd + tables.reduce((t, x) => t + align8(x.values.length * size(x.kind)), 0);
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  new Uint8Array(buf).set(new TextEncoder().encode('SSB1'), 0);
  dv.setUint32(4, jsonBytes.length, true);
  dv.setUint32(8, tables.length, true);
  tables.forEach((t, i) => { dv.setUint8(16 + 16 * i, t.kind); dv.setUint8(17 + 16 * i, t.name.charCodeAt(0)); dv.setUint32(24 + 16 * i, t.values.length, true); });
  new Uint8Array(buf).set(jsonBytes, 16 + 16 * tables.length);
  let pos = headerEnd;
  for (const t of tables) {
    t.values.forEach((v, k) => { if (t.kind === 0) dv.setInt32(pos + 4 * k, v, true); else if (t.kind === 1) dv.setUint8(pos + k, v); else dv.setUint16(pos + 2 * k, v, true); });
    pos += align8(t.values.length * size(t.kind));
  }
  return buf;
}

describe('decodeFrame', () => {
  it('decodes the header and every table kind as views without copying', () => {
    const buf = buildFrame('{"x":1}', [{ kind: 0, name: 'H', values: [1, -2, 300000] }, { kind: 1, name: 'P', values: [1, 2, 3] }, { kind: 2, name: 'Q', values: [513, 7] }]);
    const f = decodeFrame(buf);
    expect(f.header).toEqual({ x: 1 });
    expect(Array.from(f.tables['H'] as Int32Array)).toEqual([1, -2, 300000]);
    expect(Array.from(f.tables['P'] as Uint8Array)).toEqual([1, 2, 3]);
    expect(Array.from(f.tables['Q'] as Uint16Array)).toEqual([513, 7]);
    expect((f.tables['H'] as Int32Array).buffer).toBe(buf);
  });
  it('handles empty tables and no tables', () => {
    expect(Object.keys(decodeFrame(buildFrame('{}', [])).tables)).toEqual([]);
    expect(decodeFrame(buildFrame('{}', [{ kind: 0, name: 'H', values: [] }])).tables['H']).toHaveLength(0);
  });
  it('rejects bytes that do not follow the layout, with an Error', () => {
    expect(() => decodeFrame(new ArrayBuffer(4))).toThrow(/too short/);
    const bad = buildFrame('{}', []);
    new Uint8Array(bad)[0] = 0x58;
    expect(() => decodeFrame(bad)).toThrow(/magic/);
    const truncated = buildFrame('{}', [{ kind: 0, name: 'H', values: [1, 2, 3, 4] }]);
    expect(() => decodeFrame(truncated.slice(0, truncated.byteLength - 8))).toThrow(/past the end/);
    const trailing = new Uint8Array(buildFrame('{}', []).byteLength + 8);
    trailing.set(new Uint8Array(buildFrame('{}', [])));
    expect(() => decodeFrame(trailing.buffer)).toThrow(/trailing/);
  });
});

describe('selectedBackend', () => {
  afterEach(() => vi.unstubAllGlobals());
  /** Pretends to be a page: `tauri` adds the Tauri marker, `override` is the injected global, `stored` the localStorage value. */
  function page(opts: { tauri: boolean; override?: unknown; stored?: string | null; storageThrows?: boolean }): void {
    const w: Record<string, unknown> = {};
    if (opts.tauri) w['__TAURI_INTERNALS__'] = {};
    if (opts.override !== undefined) w['__SEQUENCESCOPE_BACKEND__'] = opts.override;
    vi.stubGlobal('window', w);
    vi.stubGlobal('localStorage', { getItem: () => { if (opts.storageThrows === true) throw new Error('blocked'); return opts.stored ?? null; } });
  }
  it('is always "ts" outside Tauri (Electron and browsers have no Rust backend)', () => {
    page({ tauri: false, override: 'rust', stored: 'rust' });
    expect(selectedBackend()).toBe('ts');
  });
  it('defaults to "ts" inside Tauri', () => {
    page({ tauri: true });
    expect(selectedBackend()).toBe('ts');
  });
  it('the injected global wins over localStorage; localStorage works alone', () => {
    page({ tauri: true, override: 'rust', stored: 'ts' });
    expect(selectedBackend()).toBe('rust');
    page({ tauri: true, stored: 'rust' });
    expect(selectedBackend()).toBe('rust');
  });
  it('ignores unknown values and a broken localStorage', () => {
    page({ tauri: true, override: 'python', stored: 'java' });
    expect(selectedBackend()).toBe('ts');
    page({ tauri: true, storageThrows: true });
    expect(selectedBackend()).toBe('ts');
  });
});
