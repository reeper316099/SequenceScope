// Decoder for the binary result frame Rust sends for an alignment (the layout is documented in src-tauri/src/frame.rs).
// The DP tables are exposed as typed-array VIEWS on the received buffer: nothing is copied.

/** A decoded frame: the JSON header and the numeric tables by name (H, P, M, X, Y). */
export interface DecodedFrame {
  header: unknown;
  tables: Record<string, Int32Array | Uint8Array | Uint16Array | Float64Array | Uint32Array>;
}

const align8 = (n: number): number => Math.ceil(n / 8) * 8;

/** Parses a frame; throws an Error (never returns garbage) if the bytes do not follow the layout. */
export function decodeFrame(buf: ArrayBuffer): DecodedFrame {
  if (buf.byteLength < 16) throw new Error('Result frame is too short.');
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'SSB1') throw new Error(`Unexpected result frame (magic "${magic}").`);
  const jsonLen = dv.getUint32(4, true);
  const count = dv.getUint32(8, true);
  const jsonStart = 16 + 16 * count;
  if (jsonStart + jsonLen > buf.byteLength) throw new Error('Result frame header is truncated.');
  const header: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, jsonStart, jsonLen)));
  const tables: DecodedFrame['tables'] = {};
  let pos = align8(jsonStart + jsonLen);
  for (let t = 0; t < count; t++) {
    const e = 16 + 16 * t;
    const kind = dv.getUint8(e);
    const name = String.fromCharCode(dv.getUint8(e + 1));
    const n = dv.getUint32(e + 8, true) + dv.getUint32(e + 12, true) * 2 ** 32;
    const size = kind === 0 || kind === 4 ? 4 : kind === 1 ? 1 : kind === 2 ? 2 : kind === 3 ? 8 : 0;
    if (size === 0) throw new Error(`Unknown table kind ${kind}.`);
    if (pos + n * size > buf.byteLength) throw new Error(`Table ${name} runs past the end of the frame.`);
    tables[name] = kind === 0 ? new Int32Array(buf, pos, n) : kind === 1 ? new Uint8Array(buf, pos, n) : kind === 2 ? new Uint16Array(buf, pos, n) : kind === 3 ? new Float64Array(buf, pos, n) : new Uint32Array(buf, pos, n);
    pos = align8(pos + n * size);
  }
  if (pos !== buf.byteLength) throw new Error('Result frame has unexpected trailing bytes.');
  return { header, tables };
}
