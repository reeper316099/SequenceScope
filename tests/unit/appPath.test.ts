// Security unit tests: app:// path resolution must never escape its two roots.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAppPath } from '../../electron/appPath';
import { isAllowedExternalUrl } from '../../electron/allowlist';

const R = path.resolve('/srv/app/renderer');
const E = path.resolve('/srv/app/examples');

describe('resolveAppPath', () => {
  it('serves index.html for / and normal files', () => {
    expect(resolveAppPath('/', R, E)).toBe(path.join(R, 'index.html'));
    expect(resolveAppPath('/assets/a.js', R, E)).toBe(path.join(R, 'assets', 'a.js'));
  });
  it('maps /examples/ to the examples root', () => {
    expect(resolveAppPath('/examples/x/sequences.fasta', R, E)).toBe(path.join(E, 'x', 'sequences.fasta'));
  });
  it.each(['/../secret', '/%2e%2e/secret', '/assets/../../secret', '/examples/../../secret', '/examples/%2e%2e/%2e%2e/etc/passwd', '/a%00b', '/a\\..\\b', '/%zz'])(
    'rejects traversal/odd input %s', (p) => { expect(resolveAppPath(p, R, E)).toBeNull(); });
});

describe('isAllowedExternalUrl', () => {
  it('allows exact allowlisted https hosts', () => { expect(isAllowedExternalUrl('https://github.com/reeper316099/SequenceScope')).toBe(true); });
  it.each(['http://github.com/x', 'https://evil.com', 'https://github.com.evil.com', 'https://user:pw@github.com/', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url', 'https://sub.github.com'])(
    'rejects %s', (u) => { expect(isAllowedExternalUrl(u)).toBe(false); });
});
