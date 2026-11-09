// zod schemas for anything that crosses a trust boundary. Types are inferred from the schemas (z.infer).
import { z } from 'zod';

/** Runtime check for openFile arguments (the renderer is untrusted from main's point of view). */
export const openFileRequestSchema = z.enum(['fasta', 'newick', 'project']);

/** Runtime check for saveFile arguments; the filename may not contain path separators. */
export const saveFileRequestSchema = z.object({
  suggestedName: z.string().min(1).max(200).regex(/^[^/\\:*?"<>|\0]+$/, 'file name may not contain path characters'),
  extensions: z.array(z.string().regex(/^[a-z0-9]{1,8}$/i)).min(1).max(6),
  content: z.string().max(50 * 1024 * 1024),
  encoding: z.enum(['utf8', 'base64']),
});

/** Runtime check for openExternal arguments. */
export const openExternalRequestSchema = z.string().min(1).max(2048);

/** Persisted window geometry (main process reads this from disk, so it is validated). */
export const windowStateSchema = z.object({
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  width: z.number().int().min(1100).max(10000),
  height: z.number().int().min(720).max(10000),
  maximized: z.boolean().optional(),
});
export type WindowState = z.infer<typeof windowStateSchema>;

// ---- Bundled example sets (examples/index.json and examples/<set>/metadata.json) ----

export const exampleIndexSchema = z.object({
  sets: z.array(z.object({ id: z.string(), title: z.string(), molecule: z.enum(['dna', 'protein']), records: z.number().int(), aligned: z.boolean() })),
});
export type ExampleIndex = z.infer<typeof exampleIndexSchema>;

export const exampleMetaSchema = z.object({
  id: z.string(),
  title: z.string(),
  molecule: z.enum(['dna', 'protein']),
  purpose: z.string(),
  retrieved: z.string(),
  fasta_file: z.string(),
  fasta_sha256: z.string(),
  license: z.object({ name: z.string(), quote: z.string(), source_url: z.string(), license_checked: z.string(), caveat: z.string().optional() }),
  citation: z.string(),
  notes: z.string(),
  records: z.array(z.object({ accession: z.string(), header: z.string(), length: z.number().int(), database: z.string() }).passthrough()),
  aligned: z.object({ file: z.string(), tool: z.string(), version: z.string(), command: z.string(), tool_license: z.string(), sha256: z.string(), note: z.string() }).optional(),
});
export type ExampleMeta = z.infer<typeof exampleMetaSchema>;
