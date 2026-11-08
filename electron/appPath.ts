// Pure path logic for the app:// protocol, kept separate from Electron so it can be unit-tested.
import path from 'node:path';

/**
 * Maps an app:// URL pathname to a file inside `rendererRoot` or `examplesRoot`; returns null if it would
 * escape those folders (path traversal) or contains a NUL byte.
 */
export function resolveAppPath(pathname: string, rendererRoot: string, examplesRoot: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const isExample = decoded.startsWith('/examples/');
  const root = isExample ? examplesRoot : rendererRoot;
  const rel = isExample ? decoded.slice('/examples/'.length) : decoded === '/' ? 'index.html' : decoded.slice(1);
  const full = path.resolve(root, rel);
  return full.startsWith(path.resolve(root) + path.sep) ? full : null;
}
