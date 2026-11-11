// Statistics cards + the standing honesty note about what these numbers mean.
import type { PairwiseAlignment } from '../shared/types';
import type { AlignmentStats } from '../shared/types';
import { callout, statTile } from './cards';
import { clear, el } from './dom';

export interface StatsInput {
  aln: PairwiseAlignment;
  stats: AlignmentStats;
  usesMatrix: boolean;
  lenA: number;
  lenB: number;
  scoringText: string;
}

/** Fills `host` with the statistic tiles for one alignment. */
export function renderStats(host: HTMLElement, s: StatsInput | null): void {
  clear(host);
  if (!s) { host.append(el('p', 'hint', 'Statistics appear once an alignment has been computed.')); return; }
  const { aln, stats } = s;
  const tiles = el('div', 'stats');
  tiles.append(statTile('Score', String(aln.score), s.scoringText));
  tiles.append(statTile('Alignment length', String(stats.length), `${stats.alignedColumns} aligned columns, ${stats.gapColumns} gap columns`));
  tiles.append(statTile('Identity', stats.identityPct === null ? '—' : `${stats.identityPct.toFixed(1)} %`, `${stats.identities} identical / ${stats.length} alignment columns`));
  if (s.usesMatrix) tiles.append(statTile('Similarity', stats.similarityPct === null ? '—' : `${stats.similarityPct.toFixed(1)} %`, `${stats.identities + stats.positives} identical or positive-scoring / ${stats.length} columns`));
  tiles.append(statTile('Gaps', String(stats.gapColumns), `${stats.gapOpens} gap openings (${stats.gapsInA} in A, ${stats.gapsInB} in B)`));
  tiles.append(statTile('Aligned region', aln.mode === 'global' ? 'whole sequences' : stats.length === 0 ? 'none' : `A ${aln.startA + 1}–${aln.endA}, B ${aln.startB + 1}–${aln.endB}`, aln.mode === 'global' ? `A has ${s.lenA} residues, B has ${s.lenB}` : `of ${s.lenA} and ${s.lenB} residues`));
  host.append(tiles);
  host.append(callout('info', 'A raw alignment score is not statistical significance: it grows with sequence length and depends on the scoring you chose. Percent identity depends on the alignment and on its length (90 % over 10 residues says far less than 40 % over 400). Use the shuffle check below for a rough idea of how unusual the score is.'));
  if (stats.ambiguousColumns > 0) host.append(callout('warn', `${stats.ambiguousColumns} column(s) involve ambiguity codes (such as N or X). They score 0 and are never counted as identities.`));
}
