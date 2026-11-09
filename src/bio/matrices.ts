// Substitution matrices as typed data. Values are generated from the NCBI files in data/matrices/ by
// tools/gen-matrices.mjs (never typed by hand); see DATA-SOURCES.md for source, terms, and checksums.
import { BioError } from './errors';
import { RAW_MATRICES } from './matrices.data';

export interface RawMatrix {
  name: string;
  letters: string; // row/column order, e.g. "ARNDCQEGHILKMFPSTWYVBZX*"
  values: number[]; // flattened letters.length x letters.length
  sha256: string; // checksum of the source file
}

export interface SubstitutionMatrix {
  name: string;
  letters: string;
  sha256: string;
  citation: string;
  source: string;
  /** Score for two residue letters, or undefined if either is not in the matrix. */
  get(a: string, b: string): number | undefined;
}

export const MATRIX_CITATION =
  'Henikoff S, Henikoff JG (1992). Amino acid substitution matrices from protein blocks. Proc Natl Acad Sci USA 89(22):10915-10919. doi:10.1073/pnas.89.22.10915';
export const MATRIX_SOURCE = 'NCBI BLAST matrices (https://ftp.ncbi.nlm.nih.gov/blast/matrices/); file header: "Matrix made by matblas".';

/** Wraps a raw matrix with a char->score lookup. */
function build(raw: RawMatrix): SubstitutionMatrix {
  const n = raw.letters.length;
  if (raw.values.length !== n * n) throw new BioError('unknown-matrix', `${raw.name}: matrix is not square.`);
  return {
    name: raw.name,
    letters: raw.letters,
    sha256: raw.sha256,
    citation: MATRIX_CITATION,
    source: MATRIX_SOURCE,
    get(a, b) {
      const i = raw.letters.indexOf(a);
      const j = raw.letters.indexOf(b);
      if (i < 0 || j < 0) return undefined;
      return raw.values[i * n + j];
    },
  };
}

const REGISTRY = new Map<string, SubstitutionMatrix>(RAW_MATRICES.map((r) => [r.name, build(r)]));

/** Names of all bundled matrices, in display order. */
export function listMatrices(): string[] {
  return [...REGISTRY.keys()];
}

/** Looks up a bundled matrix by name or throws a typed error. */
export function getMatrix(name: string): SubstitutionMatrix {
  const m = REGISTRY.get(name);
  if (m === undefined) throw new BioError('unknown-matrix', `Unknown substitution matrix "${name}". Available: ${listMatrices().join(', ')}.`);
  return m;
}

/**
 * Checks the self-alignment condition (ALGORITHMS.md section 5): s(x,x) > 0 and s(x,y) <= (s(x,x)+s(y,y))/2
 * for all standard amino acids. When it holds, aligning a sequence with itself uses the diagonal.
 */
export function satisfiesSelfAlignmentCondition(m: SubstitutionMatrix, letters = 'ACDEFGHIKLMNPQRSTVWY'): boolean {
  for (const x of letters) {
    const sxx = m.get(x, x);
    if (sxx === undefined || sxx <= 0) return false;
    for (const y of letters) {
      const sxy = m.get(x, y);
      const syy = m.get(y, y);
      if (sxy === undefined || syy === undefined || sxy > (sxx + syy) / 2) return false;
    }
  }
  return true;
}
