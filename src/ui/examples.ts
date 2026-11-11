// Loads the bundled example sets through app:// (or the dev server). Everything is validated with zod.
import { exampleIndexSchema, exampleMetaSchema } from '../shared/schemas';
import type { ExampleIndex, ExampleMeta } from '../shared/schemas';
import { parseFastaAsync } from '../backend/api';
import type { Sequence } from '../shared/types';

export interface LoadedSet {
  meta: ExampleMeta;
  records: Sequence[];
}

/** Fetches and validates a JSON file from /examples. */
async function getJson(path: string): Promise<unknown> {
  const r = await fetch(`/examples/${path}`);
  if (!r.ok) throw new Error(`Could not load ${path} (HTTP ${r.status}).`);
  return r.json() as Promise<unknown>;
}

/** Loads the list of bundled sets. */
export async function loadExampleIndex(): Promise<ExampleIndex> {
  return exampleIndexSchema.parse(await getJson('index.json'));
}

/** Loads one set (metadata + records). */
export async function loadExampleSet(id: string): Promise<LoadedSet> {
  const meta = exampleMetaSchema.parse(await getJson(`${id}/metadata.json`));
  const r = await fetch(`/examples/${id}/${meta.fasta_file}`);
  if (!r.ok) throw new Error(`Could not load the sequences of ${id}.`);
  const parsed = await parseFastaAsync(await r.text(), { alphabet: meta.molecule });
  if (parsed.issues.some((i) => i.severity === 'error')) throw new Error(`The bundled example ${id} failed validation: ${parsed.issues.map((i) => i.message).join(' ')}`);
  return { meta, records: parsed.records };
}

export interface ExamplePair {
  label: string;
  setId: string;
  a: number;
  b: number;
}

/** Curated pairs: every 2-record set plus a few pairs picked from the larger sets. */
export const EXTRA_PAIRS: readonly { setId: string; a: number; b: number }[] = [
  { setId: 'globin_alpha_primates_near_identical', a: 0, b: 1 },
  { setId: 'globin_alpha_vertebrates', a: 0, b: 12 },
  { setId: 'mito_cytb_mammals', a: 0, b: 1 },
  { setId: 'mito_cytb_mammals', a: 0, b: 7 },
];

/** Short display name for a record (the part of the header after the accession). */
export function shortName(r: Sequence): string {
  const rest = r.description === '' ? r.id : r.description;
  return (rest.length > 44 ? `${rest.slice(0, 42)}…` : rest);
}

/** Builds the text to put into a sequence box for one record (FASTA, so the name travels with it). */
export function recordText(r: Sequence): string {
  return `>${r.id} ${r.description}\n${r.residues}`.trim();
}

/** Raw FASTA text of a bundled set (aligned = the MAFFT-aligned copy, only for sets that have one). */
export async function loadExampleText(id: string, aligned: boolean): Promise<string> {
  const r = await fetch(`/examples/${id}/${aligned ? 'aligned.fasta' : 'sequences.fasta'}`);
  if (!r.ok) throw new Error(`Could not load ${aligned ? 'the aligned copy of ' : ''}${id}.`);
  return r.text();
}
