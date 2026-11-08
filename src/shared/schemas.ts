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
