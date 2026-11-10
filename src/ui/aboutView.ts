// About / Limitations: conventions, citations, data sources and licenses, validation summary, caps, honest limits.
import { getMatrix, limits, listMatrices } from '../backend/api';
import { callout, card } from './cards';
import { INTERACTIVE_CELL_CAP } from './matrixCanvas';
import { clear, el } from './dom';
import { loadExampleIndex, loadExampleSet } from './examples';
import type { AppView } from './view';

/** A paragraph. */
const p = (t: string): HTMLElement => el('p', undefined, t);
/** A bullet list. */
function ul(items: string[]): HTMLElement {
  const u = el('ul');
  for (const i of items) u.append(el('li', undefined, i));
  return u;
}

/** Builds the About view. */
export function createAboutView(): AppView {
  const root = el('div', 'view view-about');
  const build = (): void => {
    clear(root);
    const info = card('SequenceScope', 'An educational lab for comparing biological sequences. Not a research tool.');
    const ver = el('dl', 'kv');
    info.body.append(ver);
    void window.sequenceScope.getAppInfo().then((a) => {
      ver.append(el('dt', undefined, 'Version'), el('dd', undefined, a.version), el('dt', undefined, 'Electron / Chromium'), el('dd', undefined, `${a.electron} / ${a.chrome}`), el('dt', undefined, 'Platform'), el('dd', undefined, a.platform));
    });
    info.body.append(callout('warn', 'Educational use only. SequenceScope does not replace BLAST, MAFFT, Clustal Omega, MUSCLE, or maximum-likelihood/Bayesian phylogenetics programs (IQ-TREE, RAxML, MrBayes). The app makes no network requests; all computation happens on your computer.'));

    const alg = card('Algorithms and conventions');
    alg.body.append(ul([
      'Pairwise alignment: Needleman–Wunsch (global) and Smith–Waterman (local), written from scratch; no bioinformatics libraries.',
      'Linear gaps: a gap of length k costs k × gap. Affine gaps (Gotoh): a gap of length k costs open + (k − 1) × extend; this matches Biopython’s PairwiseAligner convention. Open = extend is identical to linear.',
      'End gaps are charged in global mode. Local alignments never go below 0 and are reported without a zero-scoring prefix.',
      'Ties in the traceback are broken in a fixed order (diagonal, up, left); the Alignment card can enumerate co-optimal alignments up to a cap of 1000.',
      'Ambiguity codes: DNA/RNA codes other than A, C, G, T/U score 0 and are never identities; protein B, Z, X and * use the matrix; J, U, O are treated as X.',
      'All randomness uses a seeded generator (sfc32). The seed is shown and saved in project files, so runs can be reproduced. Math.random is never used.',
      'Full details and checks: ALGORITHMS.md in the repository.',
    ]));

    const mats = card('Substitution matrices');
    for (const name of listMatrices()) { const m = getMatrix(name); mats.body.append(p(`${name}: ${m.citation} Source: ${m.source} (SHA-256 ${m.sha256.slice(0, 16)}…)`)); }
    mats.body.append(callout('info', 'The matrix files carry no explicit license text. They are numeric tables distributed publicly by NCBI inside its BLAST software and by Biopython; redistribution terms were not formally confirmed (see DATA-SOURCES.md).'));

    const data = card('Bundled example data', 'Downloaded from the real databases by accession; nothing was typed from memory.');
    data.body.append(p('Loading sources…'));
    void (async () => {
      try {
        const index = await loadExampleIndex();
        data.body.replaceChildren();
        for (const s of index.sets) {
          const set = await loadExampleSet(s.id);
          const m = set.meta;
          const box = el('div', 'prose');
          box.append(el('h3', undefined, m.title), p(`${m.records.length} records from ${m.records[0]?.database ?? 'database'}; retrieved ${m.retrieved}. ${m.purpose}`), p(`Accessions: ${m.records.map((r) => r.accession).join(', ')}`), p(`License: ${m.license.name}. “${m.license.quote}” (${m.license.source_url}, checked ${m.license.license_checked})${m.license.caveat ? ` Caveat: ${m.license.caveat}` : ''}`), p(`Citation: ${m.citation}`), p(`FASTA SHA-256: ${m.fasta_sha256}`));
          data.body.append(box);
        }
      } catch (e) {
        data.body.replaceChildren(callout('error', e instanceof Error ? e.message : 'Could not load example metadata.'));
      }
    })();

    const val = card('Validation summary (this build)', 'What was tested and how. Current totals are in the repository README.');
    val.body.append(ul([
      'Pairwise alignment: the dynamic-programming score equals the best score over every possible alignment on tiny inputs (global and local, linear and affine gaps, DNA and protein); 10 properties (re-scoring, symmetry, self-alignment, determinism, …) hold on 200 random inputs each.',
      'Biopython 1.86: 44 stored reference alignments match exactly, and a fresh run of 6 new random cases through this app’s own exports matched with a maximum score difference of 0.',
      'Trees: UPGMA recovers 200 random ultrametric trees and neighbor-joining 200 random additive trees exactly; neighbor-joining equals Biopython’s on all reference matrices; UPGMA equals SciPy’s average linkage. (Biopython’s own “UPGMA” averages without weights, which is WPGMA.)',
      'Bootstrap: the same seed gives identical supports, whether split across 1, 2, 3 or 7 workers; a perfect alignment gives 100 %.',
      'Progressive alignment: always a valid alignment; for 3 tiny sequences it reached the exhaustive optimum in 61 % of cases (never above it); it agrees with MAFFT on 100 % and 98.75 % of aligned residue pairs on the two bundled sets.',
      'Worked examples from public web sources (Rosalind, Wikipedia) reproduce the stated answers.',
    ]));

    const caps = card('Limits and why');
    caps.body.append(ul([
      `Pairwise alignment is limited to ${limits().maxDpCells.toLocaleString('en-US')} matrix cells (two sequences of 5,000 residues) so the tables fit in memory (about 125 MB linear, 350 MB affine).`,
      `The matrix is drawn cell by cell and can be stepped through up to ${INTERACTIVE_CELL_CAP.toLocaleString('en-US')} cells (about 500 × 500); larger matrices show a zoomable overview.`,
      'The shuffle test is limited to 5000 shuffles and about two billion cell updates per run so it finishes in seconds.',
      'Scores are whole numbers; match/mismatch within ±1000, gap penalties 0–10000.',
      'A raw score is not significance and percent identity depends on the alignment and its length. The shuffle p-value is a heuristic, not a BLAST E-value.',
    ]));

    root.append(info.root, alg.root, mats.root, data.root, val.root, caps.root);
  };
  build();
  return { id: 'about', title: 'About', root, onShow: build };
}
