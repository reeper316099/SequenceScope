// Project files, text exports, and colour contrast.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { alignmentToClustal, alignmentToFasta, matrixToCsv } from '../../src/io/export';
import { parseProject, PROJECT_FORMAT_VERSION, serializeProject } from '../../src/io/project';
import type { ProjectFile } from '../../src/io/project';
import { contrastRatio, parseHex } from '../../src/ui/matrixGeometry';
import type { PairwiseAlignment } from '../../src/shared/types';

const project: ProjectFile = {
  app: 'SequenceScope', formatVersion: PROJECT_FORMAT_VERSION, appVersion: '0.1.0', savedAt: '2026-11-08T00:00:00.000Z',
  align: { textA: '>a\nACGT', textB: '>b\nACGA', alphabet: 'auto', mode: 'local', scoring: { substitution: { kind: 'simple', match: 2, mismatch: -3 }, gaps: { kind: 'affine', open: 5, extend: 2 } }, seed: 12345, shuffles: 200 },
};

describe('project files', () => {
  it('round-trips, keeping the seed', () => {
    const r = parseProject(serializeProject(project));
    expect(r).toEqual({ ok: true, project });
  });
  it('corrupted JSON, wrong JSON, newer version, and damaged content give friendly messages', () => {
    const bad = parseProject('{"app": "SequenceScope", "formatVers');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('not valid JSON');
    const wrong = parseProject('{"hello": 1}');
    expect(!wrong.ok && wrong.message).toContain('not a SequenceScope project');
    const newer = parseProject(JSON.stringify({ ...project, formatVersion: PROJECT_FORMAT_VERSION + 1 }));
    expect(!newer.ok && newer.message).toContain('newer version');
    const damaged = parseProject(JSON.stringify({ ...project, align: { ...project.align, seed: -5, shuffles: 99999 } }));
    expect(!damaged.ok && damaged.message).toContain('damaged');
  });
  it('rejects non-integer scoring and unknown gap kinds', () => {
    expect(parseProject(JSON.stringify({ ...project, align: { ...project.align, scoring: { substitution: { kind: 'simple', match: 1.5, mismatch: 0 }, gaps: { kind: 'linear', gap: 1 } } } })).ok).toBe(false);
    expect(parseProject(JSON.stringify({ ...project, align: { ...project.align, scoring: { substitution: { kind: 'matrix', name: 'X' }, gaps: { kind: 'wobbly', gap: 1 } } } })).ok).toBe(false);
  });
});

describe('exports', () => {
  const aln: PairwiseAlignment = { mode: 'global', score: 1, rowA: 'AC-GT', rowB: 'ACAG-', startA: 0, endA: 4, startB: 0, endB: 4 };
  it('FASTA export wraps and keeps gaps', () => {
    expect(alignmentToFasta(aln, 'x', 'y')).toBe('>x\nAC-GT\n>y\nACAG-\n');
    const long = alignmentToFasta({ ...aln, rowA: 'A'.repeat(130), rowB: 'C'.repeat(130) }, 'x', 'y').split('\n');
    expect(long[1]).toHaveLength(60);
    expect(long[3]).toHaveLength(10);
  });
  it('CLUSTAL-style export marks identical columns', () => {
    const t = alignmentToClustal(aln, 'seqA', 'seqB');
    expect(t).toContain('not produced by Clustal');
    expect(t).toContain('seqA            AC-GT');
    expect(t).toContain(' '.repeat(16) + '** * ');
  });
  it('matrix CSV has a header row and one row per residue of A plus the border', () => {
    const lines = matrixToCsv('AC', 'G', (i, j) => i * 10 + j).trim().split('\n');
    expect(lines).toEqual([',,G', ',0,1', 'A,10,11', 'C,20,21']);
  });
});

describe('colour contrast (WCAG AA 4.5:1) for text on residue backgrounds and main surfaces', () => {
  const css = readFileSync('src/styles/tokens.css', 'utf8');
  /** Extracts the CSS custom properties of one theme block. */
  const block = (selector: string): Record<string, string> => {
    const start = css.indexOf(selector);
    const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
    return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()]));
  };
  const light = block(':root {');
  const dark = { ...light, ...block(":root[data-theme='dark']") };
  for (const [name, t] of [['light', light], ['dark', dark]] as const) {
    it(`${name}: residue letters are readable on every residue colour`, () => {
      for (const k of ['A', 'C', 'G', 'T', 'hydrophobic', 'polar', 'positive', 'negative', 'special', 'other']) {
        expect(contrastRatio(parseHex(t['--res-text'] ?? ''), parseHex(t[`--res-${k}`] ?? ''))).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${name}: body text, muted text, and the primary button text pass`, () => {
      expect(contrastRatio(parseHex(t['--text'] ?? ''), parseHex(t['--bg'] ?? ''))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(parseHex(t['--text'] ?? ''), parseHex(t['--surface'] ?? ''))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(parseHex(t['--text-muted'] ?? ''), parseHex(t['--surface'] ?? ''))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(parseHex(t['--text-muted'] ?? ''), parseHex(t['--surface-2'] ?? ''))).toBeGreaterThanOrEqual(4.5);
      const btnText = name === 'light' ? '#ffffff' : '#130f1f';
      expect(contrastRatio(parseHex(btnText), parseHex(t['--primary'] ?? ''))).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('multiple-alignment exports', () => {
  const ids = ['alpha', 'b'];
  const rows = ['AC-GT', 'ACAGT'];
  it('FASTA keeps input order and gaps; CLUSTAL-style marks fully identical columns with *', async () => {
    const { msaToClustal, msaToFasta } = await import('../../src/io/export');
    expect(msaToFasta(ids, rows)).toBe('>alpha\nAC-GT\n>b\nACAGT\n');
    const t = msaToClustal(ids, rows);
    expect(t).toContain('own progressive aligner');
    expect(t).toContain('alpha      AC-GT');
    expect(t).toContain(' '.repeat(11) + '** **');
  });
});
