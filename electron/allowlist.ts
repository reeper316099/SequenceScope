// Hostnames openExternal may open (https only). Keep this list tiny; every entry is a deliberate decision.
export const EXTERNAL_HOST_ALLOWLIST: readonly string[] = ['github.com', 'www.ncbi.nlm.nih.gov', 'www.uniprot.org'];

/** Returns true only for https URLs whose hostname is exactly on the allowlist (no subdomain tricks, no credentials). */
export function isAllowedExternalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    EXTERNAL_HOST_ALLOWLIST.includes(url.hostname)
  );
}
