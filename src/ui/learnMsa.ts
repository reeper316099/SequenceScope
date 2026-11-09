// Learn view, Milestone C part: how progressive alignment works (guide tree -> profile alignment), why order matters,
// "once a gap, always a gap", and where the heuristic can go wrong (a live example against the exhaustive optimum).
import { bruteForceOptimumSP, progressiveAlign, sumOfPairsScore } from '../bio/msa';
import { writeNewick } from '../bio/newick';
import { compileScoring } from '../bio/scoring';
import type { Sequence } from '../shared/types';
import { callout, card } from './cards';
import { el } from './dom';

const dnaScoring = compileScoring({ substitution: { kind: 'simple', match: 2, mismatch: -2 }, gaps: { kind: 'affine', open: 3, extend: 1 } }, 'dna');
const seq = (id: string, residues: string): Sequence => ({ id, description: '', alphabet: 'dna', residues });
const prose = (...paras: string[]): HTMLElement => { const d = el('div', 'prose'); for (const p of paras) d.append(el('p', undefined, p)); return d; };
const block = (ids: readonly string[], rows: readonly string[]): HTMLElement => el('pre', 'mono', ids.map((id, k) => `${id.padEnd(6)} ${rows[k] ?? ''}`).join('\n'));

/** An example where the progressive result is worse than the exhaustive optimum (found by search; pinned by a unit test). */
export const MISS_EXAMPLE = ['ACTA', 'GATC', 'GCGTG'] as const;

/** The Milestone C Learn cards. */
export function msaLessonCards(): HTMLElement[] {
  const demo = ['ACGTTGCAAT', 'ACGTTGCTAT', 'ACGTGCAAT', 'ACTTTGCAAA'].map((r, k) => seq(`s${k + 1}`, r));
  const run = progressiveAlign(demo, dnaScoring, 'upgma');

  const c1 = card('How progressive alignment works', 'Guide tree first, then group-against-group alignments.');
  c1.body.append(prose(
    'Aligning many sequences at once optimally is far too expensive (the cost grows exponentially with the number of sequences). Progressive alignment is a shortcut with three steps. (1) Align every pair of sequences and measure how different each pair is. (2) Use those distances to build a guide tree, so the most similar sequences are neighbours. (3) Walk up the tree: align the two closest sequences first; then treat the result as a single “profile” (a block of aligned rows, summarised column by column) and align it against the next sequence or profile, and so on up to the root.',
    'When two profiles are aligned, the score of putting column x of the first opposite column y of the second is the average substitution score over all pairs of residues (one from each column); gaps cost the same as in a pairwise alignment. The merge uses the same dynamic programming as pairwise alignment, just over columns instead of residues.',
  ));
  if (run) {
    c1.body.append(el('h3', undefined, 'A live example (four short DNA sequences)'), el('p', 'hint mono', `Guide tree: ${writeNewick(run.guideTree, { includeSupport: false, includeLengths: false })}`));
    run.steps.forEach((s, k) => c1.body.append(el('p', 'hint', `Merge ${k + 1}: ${s.leftIds.join(', ')}  +  ${s.rightIds.join(', ')}   (merge score ${Number(s.score.toFixed(3))})`), block(s.ids, s.rows)));
    c1.body.append(el('p', 'hint', `Final alignment (sum-of-pairs score ${run.sumOfPairs}):`), block(run.ids, run.rows));
  }

  const c2 = card('Why order matters', 'The guide tree decides which mistakes are possible.');
  c2.body.append(prose(
    'Closely related sequences are easy to align correctly, so aligning them first gives a solid core that later merges build on. Distant sequences are aligned last, with the help of the information already in the profiles. But the order is only as good as the guide tree, which comes from rough pairwise distances. In the tests for this app, shuffling the input order of 150 random related sets gave the same sum-of-pairs score in 73 % of the sets and a different score in the rest (by up to about 19 % of the best possible score in the worst case). So the result is comparable, not identical, and no order-independence is claimed (two sequences are the exception: their optimal score is symmetric).',
  ));

  const c3 = card('“Once a gap, always a gap”', 'Why early decisions are frozen.');
  c3.body.append(prose('When two groups are aligned, the only thing the algorithm may do is insert new all-gap columns into either group. It never moves a residue or removes a gap that an earlier step created. This keeps the algorithm fast and the earlier, more reliable alignments intact, but it also means that if an early merge put a gap in a poor place, no later step can repair it, even if the information from other sequences would have shown the better placement.'));
  if (run && run.steps[0]) {
    const first = run.steps[0];
    const idx = first.ids.map((id) => run.ids.indexOf(id));
    c3.body.append(el('p', 'hint', `The first merge (${first.ids.join(' + ')}) as it was made:`), block(first.ids, first.rows), el('p', 'hint', 'The same sequences in the final alignment, with the all-gap columns that later merges inserted removed. They are identical:'), block(first.ids, idx.map((i) => {
      const row = run.rows[i] ?? '';
      const keep = [...row].map((_, c) => idx.some((j) => (run.rows[j] ?? '')[c] !== '-'));
      return [...row].filter((_, c) => keep[c]).join('');
    })));
  }

  const c4 = card('Where the heuristic can go wrong', 'A live comparison with the exhaustive best alignment.');
  const rows = [...MISS_EXAMPLE];
  const prog = progressiveAlign(rows.map((r, k) => seq(`s${k + 1}`, r)), dnaScoring, 'upgma');
  const best = bruteForceOptimumSP(rows, dnaScoring);
  if (prog) {
    c4.body.append(
      prose(`Three tiny sequences (${rows.join(', ')}) with match +2, mismatch −2, gap open 3 and extend 1. Because they are so short, the app can try every possible alignment and find the true best sum-of-pairs score.`),
      el('p', 'hint', `Progressive alignment: score ${prog.sumOfPairs}`), block(prog.ids, prog.rows),
      el('p', 'hint', `Best possible alignment found by trying all of them: score ${sumOfPairsScore(best.rows, dnaScoring)}`), block(prog.ids, best.rows),
      callout('warn', 'The progressive result is worse. Its first merge fixed a pairwise alignment of two sequences without knowing the third, and the later merge could not undo it. In this app’s own test on 150 random 3-sequence sets, the progressive alignment reached the exhaustive optimum in 61 % of the cases; in the rest it was worse. Real aligners reduce (but do not remove) this problem by iterating and refining.'),
    );
  }
  return [c1.root, c2.root, c3.root, c4.root];
}
