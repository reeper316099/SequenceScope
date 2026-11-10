// Learn view, Milestone B part: distance corrections and saturation (interactive plot), UPGMA vs neighbor-joining
// (a live example where the molecular-clock assumption misleads UPGMA), how to read a tree, and what bootstrap means.
import { buildTreesFromRowsAsync, compareTreesAsync, correctDistancesAsync, leafDistancesAsync, parseNewickAsync, writeNewickMany } from '../backend/api';
import { callout, card } from './cards';
import { el } from './dom';
import { createTreeViewer } from './treeView';
import { token } from './theme';

const NS = 'http://www.w3.org/2000/svg';
const mk = (tag: string, attrs: Record<string, string | number>, text?: string): SVGElement => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); if (text !== undefined) e.textContent = text; return e; };
const prose = (...paras: string[]): HTMLElement => { const d = el('div', 'prose'); for (const p of paras) d.append(el('p', undefined, p)); return d; };

/** The interactive p-versus-d plot with the saturation limits. */
function correctionPlot(): HTMLElement {
  const box = el('div', 'curve-box');
  const slider = el('input', undefined, undefined, { type: 'range', min: 0, max: 100, value: 40, 'aria-label': 'Observed proportion of differing sites, p, in percent', step: 1 });
  const readout = el('p', 'mono', '', { 'aria-live': 'polite' });
  const W = 560, H = 320, L = 46, B = 36, T = 14, R = 16, YMAX = 3;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Plot of corrected distance d against observed p. The Jukes–Cantor curve rises to infinity at p = 0.75 and the Poisson curve at p = 1.');
  svg.setAttribute('font-family', 'system-ui, sans-serif');
  const GRID = 400; // curve samples at p = i / 400; the slider's p = k / 100 is sample 4k (the same double)
  const grid = Array.from({ length: GRID + 1 }, (_, i) => i / GRID);
  let jcCurve: (number | null)[] = []; let poCurve: (number | null)[] = [];
  const x = (p: number): number => L + p * (W - L - R); const y = (d: number): number => H - B - (Math.min(d, YMAX) / YMAX) * (H - B - T);
  const draw = (): void => {
    svg.replaceChildren();
    const text = token('--text'); const muted = token('--text-muted'); const primary = token('--primary'); const secondary = token('--secondary'); const accent = token('--accent'); const bad = token('--bad'); const border = token('--border');
    svg.append(mk('rect', { x: 0, y: 0, width: W, height: H, fill: token('--surface') }));
    svg.append(mk('line', { x1: L, y1: H - B, x2: W - R, y2: H - B, stroke: text }), mk('line', { x1: L, y1: T, x2: L, y2: H - B, stroke: text }));
    for (const t of [0, 0.25, 0.5, 0.75, 1]) { svg.append(mk('line', { x1: x(t), y1: H - B, x2: x(t), y2: H - B + 4, stroke: text }), mk('text', { x: x(t), y: H - B + 16, 'text-anchor': 'middle', 'font-size': 11, fill: text }, String(t))); }
    for (const t of [0, 1, 2, 3]) { svg.append(mk('line', { x1: L - 4, y1: y(t), x2: L, y2: y(t), stroke: text }), mk('text', { x: L - 8, y: y(t) + 4, 'text-anchor': 'end', 'font-size': 11, fill: text }, String(t)), mk('line', { x1: L, y1: y(t), x2: W - R, y2: y(t), stroke: border, 'stroke-width': 0.5 })); }
    svg.append(mk('text', { x: (L + W - R) / 2, y: H - 4, 'text-anchor': 'middle', 'font-size': 12, fill: text }, 'observed p (proportion of differing sites)'));
    svg.append(mk('text', { x: 12, y: T + 8, 'font-size': 12, fill: text }, 'd'));
    for (const [lim, label, col] of [[0.75, 'JC limit 0.75', primary], [1, 'Poisson limit 1', secondary]] as const) {
      svg.append(mk('line', { x1: x(lim), y1: T, x2: x(lim), y2: H - B, stroke: col, 'stroke-dasharray': '5 4', 'stroke-width': 1.5 }), mk('text', { x: x(lim) - 4, y: T + 12 + (lim === 1 ? 14 : 0), 'text-anchor': 'end', 'font-size': 11, fill: col }, label));
    }
    const curve = (f: (i: number) => number | null, col: string, dash?: string): void => {
      let dpath = ''; let pen = false;
      for (let i = 0; i <= GRID; i++) { const p = i / GRID; const v = f(i); if (v === null || v === undefined || v > YMAX) { pen = false; continue; } dpath += `${pen ? 'L' : 'M'} ${x(p)} ${y(v)} `; pen = true; }
      const attrs: Record<string, string | number> = { d: dpath, fill: 'none', stroke: col, 'stroke-width': 2.2 };
      if (dash) attrs['stroke-dasharray'] = dash;
      svg.append(mk('path', attrs));
    };
    curve((i) => i / GRID, muted, '2 3'); curve((i) => jcCurve[i] ?? null, primary); curve((i) => poCurve[i] ?? null, secondary);
    const p = Number(slider.value) / 100;
    const jc = jcCurve[Number(slider.value) * 4] ?? null; const po = poCurve[Number(slider.value) * 4] ?? null;
    svg.append(mk('line', { x1: x(p), y1: T, x2: x(p), y2: H - B, stroke: accent, 'stroke-width': 2 }));
    if (jc !== null) svg.append(mk('circle', { cx: x(p), cy: y(jc), r: 4.5, fill: primary }));
    if (po !== null) svg.append(mk('circle', { cx: x(p), cy: y(po), r: 4.5, fill: secondary }));
    svg.append(mk('text', { x: L + 8, y: T + 26, 'font-size': 11, fill: muted }, '┈ p-distance (no correction)'), mk('text', { x: L + 8, y: T + 40, 'font-size': 11, fill: primary }, '── Jukes–Cantor (DNA)'), mk('text', { x: L + 8, y: T + 54, 'font-size': 11, fill: secondary }, '── Poisson (protein)'));
    void bad;
    readout.textContent = `p = ${p.toFixed(2)}   JC d = ${jc === null ? 'saturated / undefined' : jc.toFixed(4)}   Poisson d = ${po === null ? 'saturated / undefined' : po.toFixed(4)}`;
  };
  slider.addEventListener('input', draw);
  const lab = el('label', 'field'); lab.append(el('span', 'field-label', 'Move the observed p'), slider);
  box.append(lab, readout, svg);
  draw();
  void Promise.all([correctDistancesAsync('jc', grid), correctDistancesAsync('poisson', grid)]).then(([jc, po]) => { jcCurve = jc; poCurve = po; draw(); });
  new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return box;
}

/** The clock example: truth, UPGMA, and NJ side by side with RF distances computed live. */
function clockExample(): HTMLElement {
  const box = el('div', 'clock-example');
  void fillClockExample(box); // the numbers come from the calculation engine a moment later
  return box;
}

/** Computes the clock example (true tree, its distances, UPGMA and NJ results, Robinson-Foulds distances) and fills `box`. */
async function fillClockExample(box: HTMLElement): Promise<void> {
  const truth = (await parseNewickAsync('((A:3,B:0.5):0.25,(C:3,D:0.5):0.25);')).tree;
  const { names, dist } = await leafDistancesAsync(truth);
  const built = await buildTreesFromRowsAsync(names, dist);
  const u = built.upgma.tree; const nj = built.nj.tree;
  const rfU = (await compareTreesAsync(truth, u)).rf.distance; const rfN = (await compareTreesAsync(truth, nj)).rf.distance;
  const texts = await writeNewickMany([truth, u, nj], { includeSupport: false });
  const table = el('table', 'matrix-table', undefined, { 'aria-label': 'Distances of the clock example' });
  const head = el('tr'); head.append(el('th'), ...names.map((n) => el('th', undefined, n))); table.append(head);
  names.forEach((n, i) => { const tr = el('tr'); tr.append(el('th', undefined, n), ...(dist[i] as number[]).map((v) => el('td', undefined, String(v)))); table.append(tr); });
  const views = el('div', 'pair');
  for (const [k, [label, t, rf]] of ([['True tree', truth, 0], ['UPGMA result', u, rfU], ['Neighbor-joining result', nj, rfN]] as const).entries()) {
    const col = el('div'); col.append(el('h4', undefined, `${label}${label === 'True tree' ? '' : ` — Robinson–Foulds distance to the truth: ${rf}`}`));
    const v = createTreeViewer(label); v.setTree(t); col.append(v.root, el('p', 'hint mono', texts[k] ?? ''));
    views.append(col);
  }
  box.append(prose('Here the true tree has two fast-evolving lineages, A and C (long branches of length 3), and two slow ones, B and D (0.5). The distances below were computed exactly from that tree, so a correct method should recover it.'), table, views,
    callout(rfU > 0 ? 'warn' : 'info', rfU > 0
      ? `UPGMA pairs the two closest taxa, B and D (distance ${dist[names.indexOf('B')]?.[names.indexOf('D')] ?? ''}), because it assumes every lineage changed at the same rate, so a short distance must mean recent common ancestry. Here the short distance only reflects the slow lineages, so UPGMA gets the wrong grouping (RF = ${rfU}). Neighbor-joining corrects for each taxon’s overall divergence and recovers the true tree (RF = ${rfN}).`
      : 'UPGMA and the true tree agree here.'));
}

/** The Milestone B Learn cards. */
export function treeLessonCards(): HTMLElement[] {
  const c1 = card('Distance corrections and saturation', 'Why 30 % observed difference does not mean 30 % of the changes.');
  c1.body.append(
    prose('Two sequences that diverged for a long time may have changed at the same site twice (A→G→A looks like no change) or from A to G to T (counted as one difference). So the raw proportion of differing sites p underestimates the real number of changes. The Jukes–Cantor model (DNA) and the Poisson correction (protein) estimate the true distance d from p. The curves bend upward and reach infinity at a finite p: p = 3/4 for DNA (random sequences differ at 3 of 4 sites, so p can never exceed that on average) and p = 1 for protein. Near the limit, tiny changes in p change d enormously, and at or beyond it d is undefined. SequenceScope shows such pairs as “saturated” and never prints NaN or infinity.'),
    correctionPlot(),
    callout('warn', 'Saturated distances mean the sequences are too diverged for this correction to say anything. Tree methods cannot use them: try the p-distance, a different gap policy, or fewer distant sequences.'),
  );
  const c2 = card('UPGMA vs neighbor-joining: when the molecular clock misleads', 'A live example computed with the code in this app.');
  c2.body.append(clockExample());
  const c3 = card('How to read a tree', 'Tips, nodes, branches, clades, and rooting.');
  c3.body.append(prose(
    'Tips (leaves) are the sequences you started with. Internal nodes are inferred common ancestors. A branch connects two nodes; in a phylogram its length is proportional to the amount of change (the scale bar shows the unit), in a cladogram only the branching pattern matters. A clade is a node together with everything below it.',
    'A rooted tree has a direction in time: the root is the common ancestor of everything. An unrooted tree shows only how taxa relate, not which way time runs; neighbor-joining returns an unrooted tree (drawn with a three-way split at the centre). You can root it afterwards using an outgroup (a taxon known to be outside the others) or the midpoint of the longest path. Rooting changes the picture, not the unrooted relationships: the Robinson–Foulds comparison ignores the root.',
    'Rotating a node swaps its two children on the page. It changes nothing about relationships, so do not read meaning into which branch is on top.',
  ));
  const c4 = card('What bootstrap values mean', 'And what they do not.');
  c4.body.append(
    prose('Bootstrap = rebuild the tree many times from randomly resampled alignment columns and count how often each branch reappears. A value of 92 means 92 of 100 resampled datasets contained that branch. It tells you how much the result depends on which columns happened to be in your alignment. It is NOT the probability that the branch is true: if the alignment is wrong or the method is biased, a branch can be wrong and still be stable. Bootstrap needs an alignment because the columns are what get resampled; distances from separately aligned pairs have no columns.'),
    callout('info', 'In the Trees view, values under 70 are marked with * and drawn in red. The seed and number of replicates are shown with the result, so the run can be repeated exactly.'),
  );
  return [c1.root, c2.root, c3.root, c4.root];
}
