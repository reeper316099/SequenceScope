// fast-check arbitraries for sequences over a given alphabet (fast-check 4: fc.string with a `unit`).
import fc from 'fast-check';

/** Random string over `letters` with length in [minLength, maxLength]. */
export function seqOf(letters: string, maxLength: number, minLength = 0): fc.Arbitrary<string> {
  return fc.string({ unit: fc.constantFrom(...letters), minLength, maxLength });
}
