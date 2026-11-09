// Learn view (Milestone A part): what an alignment is, scoring, the recurrences (MathML) with CURRENT values filled
// in, an editable worked mini-example, global vs local, linear vs affine gaps, and what traceback does.
import { fillMatrix, tracebackFirst } from '../bio/pairwise';
import { compileScoring } from '../bio/scoring';
import type { AlignMode, ScoringSpec } from '../shared/types';
import { callout, card } from './cards';
import { clear, el, mml } from './dom';
import { pathCells } from './matrixGeometry';
import { treeLessonCards } from './learnTrees';
import { msaLessonCards } from './learnMsa';
import { analyzeSequenceText } from './model';
import type { AppView } from './view';

const mi = (t: string): Element => mml('mi', t);
const mo = (t: string): Element => mml('mo', t);
const mn = (t: string): Element => mml('mn', t);
const row = (...c: Element[]): Element => mml('mrow', undefined, ...c);
const msub = (b: Element, s: Element): Element => mml('msub', undefined, b, s);

/** Turns "i-1" / "j" / "i-1,j-1" into MathML tokens. */
function tokens(src: string): Element[] {
  const out: Element[] = [];
  for (const ch of src) out.push(/[0-9]/.test(ch) ? mn(ch) : ch === '-' ? mo('−') : ch === ',' ? mo(',') : mi(ch));
  return out;
}
/** A DP value with subscripts, e.g. cell('H', 'i-1,j'). */
const cell = (name: string, idx: string): Element => msub(mi(name), row(...tokens(idx)));
const sFun = (): Element => row(mi('s'), mo('('), msub(mi('a'), mi('i')), mo(','), msub(mi('b'), mi('j')), mo(')'));
const maxOf = (...parts: Element[]): Element => {
  const inner: Element[] = [];
  parts.forEach((p, k) => { if (k > 0) inner.push(mo(',')); inner.push(p); });
  return row(mi('max'), mo('('), ...inner, mo(')'));
};
const eq = (lhs: Element, rhs: Element): Element => {
  const m = mml('math', undefined, row(lhs, mo('='), rhs));
  m.setAttribute('display', 'block');
  return m;
};
const term = (...c: Element[]): Element => row(...c);
/** A prose block holding one paragraph. */
function prose(text: string): HTMLElement {
  const d = el('div', 'prose');
  d.append(el('p', undefined, text));
  return d;
}

/** Builds the Learn view; `getContext` supplies the scoring currently chosen in the Align view. */
export function createLearnView(getContext: () => { scoring: ScoringSpec; mode: AlignMode }): AppView {
  const root = el('div', 'view view-learn');
  const dynamic = el('div', 'view');
  root.append(dynamic);

  /** Rebuilds everything (called each time the view is shown so the current values are fresh). */
  const build = (): void => {
    clear(dynamic);
    const ctx = getContext();
    const g = ctx.scoring.gaps;
    const sub = ctx.scoring.substitution;
    const gapNum = g.kind === 'linear' ? g.gap : g.open;
    const subText = sub.kind === 'simple' ? `match = ${sub.match}, mismatch = ${sub.mismatch}` : `the ${sub.name} matrix`;

    const c1 = card('What is a sequence alignment?', 'Lining up two sequences so that matching letters sit in the same column.');
    const p1 = el('div', 'prose');
    p1.append(
      el('p', undefined, 'DNA, RNA, and proteins are strings of letters. If two strings descend from a common ancestor, mutations (changed letters, inserted or deleted letters) have made them differ. An alignment writes one string above the other, using a gap symbol “-” where a letter was inserted or deleted, so that columns that came from the same ancestral position line up.'),
      el('p', 'mono', 'A:  G C A T G - C G\nB:  G - A T T A C A'),
      el('p', undefined, 'An alignment is a hypothesis about evolution, not a fact: many different alignments are possible, so we score them and look for the best one.'),
    );
    c1.body.append(p1);

    const c2 = card('Scoring: how do we decide which alignment is “best”?', `Your current setup: ${ctx.mode} alignment, ${subText}, ${g.kind === 'linear' ? `linear gap penalty ${g.gap}` : `affine gap open ${g.open} / extend ${g.extend}`}.`);
    c2.body.append(prose('Each column earns points: a substitution score s(a, b) when two letters are paired (positive for a match, negative for a mismatch, or looked up in a matrix such as BLOSUM62 that says how often two amino acids replace each other in real proteins) and a penalty for gaps. The alignment score is the sum over all columns. The best alignment is the one with the highest total.'));

    const c3 = card('The recurrence (dynamic programming)', 'Instead of trying every alignment, fill a table H. Cell H(i, j) is the best score for aligning the first i letters of A with the first j letters of B.');
    const lin = el('div', 'prose');
    lin.append(el('h3', undefined, ctx.mode === 'global' ? 'Global, linear gaps (Needleman–Wunsch)' : 'Local, linear gaps (Smith–Waterman)'));
    const parts = [term(cell('H', 'i-1,j-1'), mo('+'), sFun()), term(cell('H', 'i-1,j'), mo('−'), mi('g')), term(cell('H', 'i,j-1'), mo('−'), mi('g'))];
    lin.append(eq(cell('H', 'i,j'), maxOf(...(ctx.mode === 'local' ? [mn('0'), ...parts] : parts))));
    lin.append(el('p', undefined, `Here s(a_i, b_j) is the substitution score of the two letters (${subText}) and g is the gap penalty. ${g.kind === 'affine' ? `Your current setting is affine (see below); for this linear form, g is shown as your gap-open value, ${gapNum}:` : `With your current gap setting g = ${gapNum}:`}`));
    const numeric = [term(cell('H', 'i-1,j-1'), mo('+'), sFun()), term(cell('H', 'i-1,j'), mo('−'), mn(String(gapNum))), term(cell('H', 'i,j-1'), mo('−'), mn(String(gapNum)))];
    lin.append(eq(cell('H', 'i,j'), maxOf(...(ctx.mode === 'local' ? [mn('0'), ...numeric] : numeric))));
    lin.append(el('p', undefined, ctx.mode === 'global'
      ? 'Border: H(i, 0) = −i·g and H(0, j) = −j·g, because aligning i letters against nothing costs i gaps. The answer is the bottom-right cell.'
      : 'The extra 0 means “start a new alignment here” (scores never go below 0). Border cells are 0. The answer is the largest cell anywhere, and the traceback stops at a 0.'));
    if (g.kind === 'affine') {
      lin.append(el('h3', undefined, `Affine gaps (Gotoh) with your open = ${g.open}, extend = ${g.extend}`));
      lin.append(el('p', undefined, `Opening a gap costs more than extending it, so the table keeps three scores per cell: M (the two letters are paired), X (a_i sits against a gap), Y (b_j sits against a gap). A gap of length k costs open + (k − 1) × extend.`));
      lin.append(
        eq(cell('M', 'i,j'), row(maxOf(cell('M', 'i-1,j-1'), cell('X', 'i-1,j-1'), cell('Y', 'i-1,j-1')), mo('+'), sFun())),
        eq(cell('X', 'i,j'), maxOf(term(cell('M', 'i-1,j'), mo('−'), mn(String(g.open))), term(cell('Y', 'i-1,j'), mo('−'), mn(String(g.open))), term(cell('X', 'i-1,j'), mo('−'), mn(String(g.extend))))),
        eq(cell('Y', 'i,j'), maxOf(term(cell('M', 'i,j-1'), mo('−'), mn(String(g.open))), term(cell('X', 'i,j-1'), mo('−'), mn(String(g.open))), term(cell('Y', 'i,j-1'), mo('−'), mn(String(g.extend))))),
      );
    }
    c3.body.append(lin);

    // --- editable worked mini-example ---
    const c4 = card('Try it: a tiny worked example you can edit', 'Uses simple scores and linear gaps so every number is easy to check by hand.');
    const aIn = el('input', undefined, undefined, { type: 'text', value: 'GCATGCG', 'aria-label': 'Mini example sequence A', maxlength: 14 });
    const bIn = el('input', undefined, undefined, { type: 'text', value: 'GATTACA', 'aria-label': 'Mini example sequence B', maxlength: 14 });
    const mIn = el('input', undefined, undefined, { type: 'number', value: 1, 'aria-label': 'Mini example match score' });
    const xIn = el('input', undefined, undefined, { type: 'number', value: -1, 'aria-label': 'Mini example mismatch score' });
    const gIn = el('input', undefined, undefined, { type: 'number', value: 1, min: 0, 'aria-label': 'Mini example gap penalty' });
    const mode = el('select', undefined, undefined, { 'aria-label': 'Mini example mode' });
    mode.append(el('option', undefined, 'Global', { value: 'global' }), el('option', undefined, 'Local', { value: 'local' }));
    mode.value = ctx.mode;
    const lab = (t: string, c: HTMLElement): HTMLElement => { const l = el('label', 'field narrow'); l.append(el('span', 'field-label', t), c); return l; };
    const controls = el('div', 'row'); controls.append(lab('Sequence A', aIn), lab('Sequence B', bIn), lab('Match', mIn), lab('Mismatch', xIn), lab('Gap penalty', gIn), lab('Mode', mode));
    const out = el('div', 'mini-out');
    const redraw = (): void => {
      clear(out);
      const A = analyzeSequenceText(aIn.value, 'dna'); const B = analyzeSequenceText(bIn.value, 'dna');
      const bad = [A, B].find((x) => x.hasError || x.empty);
      if (bad) { out.append(callout('warn', 'Enter two short DNA sequences (letters A, C, G, T; up to 14 each).')); return; }
      try {
        const sc = compileScoring({ substitution: { kind: 'simple', match: Number(mIn.value), mismatch: Number(xIn.value) }, gaps: { kind: 'linear', gap: Number(gIn.value) } }, 'dna');
        const dp = fillMatrix(A.residues, B.residues, mode.value === 'local' ? 'local' : 'global', sc);
        const aln = tracebackFirst(dp);
        const onPath = new Set(aln.rowA.length === 0 ? [] : pathCells(aln).map(([i, j]) => `${i},${j}`));
        if (dp.kind !== 'linear') return;
        const table = el('table', 'matrix-table', undefined, { 'aria-label': 'Worked example score matrix' });
        const head = el('tr'); head.append(el('th'), el('th', undefined, '—'));
        for (const ch of B.residues) head.append(el('th', undefined, ch));
        table.append(head);
        for (let i = 0; i < dp.rows; i++) {
          const tr = el('tr'); tr.append(el('th', undefined, i === 0 ? '—' : A.residues.charAt(i - 1)));
          for (let j = 0; j < dp.cols; j++) tr.append(el('td', onPath.has(`${i},${j}`) ? 'on-path' : undefined, String(dp.H[i * dp.cols + j])));
          table.append(tr);
        }
        const text = el('div', 'prose');
        text.append(el('p', undefined, `Score: ${aln.score}. Amber cells are the traceback path: from the ${mode.value === 'local' ? 'highest cell' : 'bottom-right cell'} follow the move that produced each value (diagonal = pair two letters, up/left = a gap) back to the ${mode.value === 'local' ? 'cell where the score is 0' : 'top-left corner'}.`), el('p', 'mono', `${aln.rowA || '(no positive-scoring region)'}\n${aln.rowB}`));
        const grid = el('div', 'mini-grid');
        grid.append(table, text);
        out.append(grid);
      } catch (e) {
        out.append(callout('error', e instanceof Error ? e.message : 'Could not compute the example.'));
      }
    };
    for (const c of [aIn, bIn, mIn, xIn, gIn, mode]) c.addEventListener('input', redraw);
    c4.body.append(controls, out);
    redraw();

    const c5 = card('Global vs local, linear vs affine', 'Two choices that change what “best” means.');
    const gapDemo = el('table', 'matrix-table', undefined, { 'aria-label': 'Gap cost by length' });
    const hr = el('tr'); hr.append(el('th', undefined, 'Gap length'), ...[1, 2, 3, 4, 5, 6, 8, 10].map((k) => el('th', undefined, String(k))));
    gapDemo.append(hr);
    const linRow = el('tr'); linRow.append(el('th', undefined, `Linear (g = ${gapNum})`), ...[1, 2, 3, 4, 5, 6, 8, 10].map((k) => el('td', undefined, String(k * gapNum))));
    const open = g.kind === 'affine' ? g.open : 11; const ext = g.kind === 'affine' ? g.extend : 1;
    const affRow = el('tr'); affRow.append(el('th', undefined, `Affine (open ${open}, extend ${ext})`), ...[1, 2, 3, 4, 5, 6, 8, 10].map((k) => el('td', undefined, String(open + (k - 1) * ext))));
    gapDemo.append(linRow, affRow);
    const p5 = el('div', 'prose');
    p5.append(
      el('p', undefined, 'Global alignment (Needleman–Wunsch) forces both whole sequences into the alignment, so it suits sequences of similar length that are related along their whole length. Local alignment (Smith–Waterman) reports only the best-matching region, so it can find a shared domain inside otherwise unrelated sequences; its score is never below 0.'),
      el('p', undefined, 'With linear gaps every gap position costs the same, so one long gap costs as much as many short ones. In biology one insertion or deletion event often removes several letters at once, so affine gaps charge a large price to open a gap and a small price to extend it. The table shows how the cost grows with gap length.'),
    );
    c5.body.append(p5, gapDemo);

    const c6 = card('What does the traceback do?');
    c6.body.append(prose('The filled table only holds scores. To recover the alignment itself, start at the answer cell and repeatedly ask “which neighbour did this value come from?”. Each choice is one alignment column: diagonal = two letters paired, up = a letter of A against a gap, left = a letter of B against a gap. When two choices tie, the app prefers diagonal, then up, then left, so the result is always the same; the Alignment card can also list all tied (co-optimal) alignments. Because the table stores only the best score for each pair of prefixes, this takes time proportional to (length of A) × (length of B) instead of trying every possible alignment.'));
    c6.body.append(callout('warn', 'A high alignment score or identity percentage does not by itself prove two sequences are related. Use the shuffle check in the Align view, and remember that real searches (BLAST) use proper statistics.'));

    dynamic.append(c1.root, c2.root, c3.root, c4.root, c5.root, c6.root, ...treeLessonCards(), ...msaLessonCards());
  };

  build();
  return { id: 'learn', title: 'Learn', root, onShow: build };
}
