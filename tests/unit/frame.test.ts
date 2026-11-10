// The binary frame decoder (the Rust side of the frame is tested in src-tauri/src/frame.rs; the real Rust-to-page round trip is
// checked by the bridge tests and by the Tauri window smoke test).
import { describe, expect, it } from 'vitest';
import { decodeFrame } from '../../src/backend/frame';

/** Builds a frame exactly as src-tauri/src/frame.rs documents it (an independent encoder, so the decoder is really tested). */
function buildFrame(json: string, tables: { kind: 0 | 1 | 2 | 3 | 4; name: string; values: number[] }[]): ArrayBuffer {
  const align8 = (n: number): number => Math.ceil(n / 8) * 8;
  const jsonBytes = new TextEncoder().encode(json);
  const size = (k: number): number => (k === 0 || k === 4 ? 4 : k === 1 ? 1 : k === 2 ? 2 : 8);
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
    t.values.forEach((v, k) => { if (t.kind === 0) dv.setInt32(pos + 4 * k, v, true); else if (t.kind === 1) dv.setUint8(pos + k, v); else if (t.kind === 2) dv.setUint16(pos + 2 * k, v, true); else if (t.kind === 3) dv.setFloat64(pos + 8 * k, v, true); else dv.setUint32(pos + 4 * k, v, true); });
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
  it('decodes f64 and u32 tables bit-exactly', () => {
    const f = decodeFrame(buildFrame('{}', [{ kind: 3, name: 'V', values: [0.1 + 0.2, -0.5, 1e300] }, { kind: 4, name: 'C', values: [0, 4294967295] }]));
    expect(Array.from(f.tables['V'] as Float64Array)).toEqual([0.1 + 0.2, -0.5, 1e300]);
    expect(Array.from(f.tables['C'] as Uint32Array)).toEqual([0, 4294967295]);
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
