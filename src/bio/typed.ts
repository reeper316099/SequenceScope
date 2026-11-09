// Typed-array readers. With `noUncheckedIndexedAccess`, `arr[i]` is `number | undefined`; in the DP loops every
// index is inside the array by construction (loop bounds come from the array dimensions), so these helpers
// assert `number` in ONE place instead of sprinkling assertions through the recurrences.

/** Reads an Int32Array element (index in range by construction of the caller's loop bounds). */
export function i32(a: Int32Array, k: number): number {
  return a[k] as number; // safe: callers loop within the allocated (rows x cols) range
}

/** Reads a Uint8Array element (index in range by construction). */
export function u8(a: Uint8Array, k: number): number {
  return a[k] as number; // safe: see i32
}

/** Reads a Uint16Array element (index in range by construction). */
export function u16(a: Uint16Array, k: number): number {
  return a[k] as number; // safe: see i32
}

/** Reads an Int8Array element (index in range by construction). */
export function i8(a: Int8Array, k: number): number {
  return a[k] as number; // safe: see i32
}
