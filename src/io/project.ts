// Project files (JSON). Everything read from disk is validated with zod; corrupted or newer files give friendly errors.
import { z } from 'zod';

export const PROJECT_FORMAT_VERSION = 1;
const MAX_TEXT = 12 * 1024 * 1024;

const gapSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('linear'), gap: z.number().int().min(0).max(10000) }),
  z.object({ kind: z.literal('affine'), open: z.number().int().min(0).max(10000), extend: z.number().int().min(0).max(10000) }),
]);
const substitutionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('simple'), match: z.number().int().min(-1000).max(1000), mismatch: z.number().int().min(-1000).max(1000) }),
  z.object({ kind: z.literal('matrix'), name: z.string().min(1).max(40) }),
]);

export const projectSchema = z.object({
  app: z.literal('SequenceScope'),
  formatVersion: z.number().int().min(1),
  appVersion: z.string().max(40),
  savedAt: z.string().max(40),
  align: z.object({
    textA: z.string().max(MAX_TEXT),
    textB: z.string().max(MAX_TEXT),
    alphabet: z.enum(['auto', 'dna', 'rna', 'protein']),
    mode: z.enum(['global', 'local']),
    scoring: z.object({ substitution: substitutionSchema, gaps: gapSchema }),
    seed: z.number().int().min(0).max(4294967295),
    shuffles: z.number().int().min(1).max(5000),
  }),
});
export type ProjectFile = z.infer<typeof projectSchema>;

export type ProjectParseResult = { ok: true; project: ProjectFile } | { ok: false; message: string };

/** Parses and validates project text; returns a friendly message instead of throwing. */
export function parseProject(text: string): ProjectParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: 'This file is not valid JSON, so it cannot be a SequenceScope project (it may be corrupted or truncated).' };
  }
  const head = z.object({ app: z.literal('SequenceScope'), formatVersion: z.number().int() }).safeParse(raw);
  if (!head.success) return { ok: false, message: 'This JSON file is not a SequenceScope project (missing "app" and "formatVersion").' };
  if (head.data.formatVersion > PROJECT_FORMAT_VERSION) {
    return { ok: false, message: `This project was saved by a newer version of SequenceScope (file format ${head.data.formatVersion}; this app understands up to ${PROJECT_FORMAT_VERSION}). Please update the app.` };
  }
  const parsed = projectSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { ok: false, message: `The project file is damaged or incomplete. First problems: ${first}` };
  }
  return { ok: true, project: parsed.data };
}

/** Serialises a project to pretty JSON text. */
export function serializeProject(project: ProjectFile): string {
  return JSON.stringify(project, null, 2) + '\n';
}
