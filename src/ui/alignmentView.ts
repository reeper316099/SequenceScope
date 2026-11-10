// Three-line alignment display (A, match line, B) with ruler, wrapped to the available width. Letters are always
// shown; colour (colour-blind-safe palette via CSS classes) is only a second cue.
import type { Alphabet, PairwiseAlignment } from '../shared/types';
import { clear, el } from './dom';
import { residueClass } from './residueClass';

export interface AlignmentViewData {
  all: readonly PairwiseAlignment[];
  capped: boolean;
  /** The match line of every alignment in `all` (same order), computed by the aligner. */
  matchLines: readonly string[];
  alphabet: Alphabet;
  idA: string;
  idB: string;
}

export interface AlignmentView {
  root: HTMLElement;
  setData(d: AlignmentViewData | null): void;
  current(): PairwiseAlignment | null;
  toPng(): string | null;
}

const LABEL_W = 14; // characters reserved for "A  1234" style labels on each side

/** Builds the alignment viewer. `onPick` is called when the user flips to another co-optimal alignment. */
export function createAlignmentView(onPick: (aln: PairwiseAlignment) => void): AlignmentView {
  const root = el('div', 'alnview');
  const nav = el('div', 'row aln-nav');
  const prev = el('button', 'btn btn-small', '◀', { type: 'button', 'aria-label': 'Previous co-optimal alignment' });
  const next = el('button', 'btn btn-small', '▶', { type: 'button', 'aria-label': 'Next co-optimal alignment' });
  const navText = el('span', 'hint', '', { 'aria-live': 'polite' });
  nav.append(prev, next, navText);
  const body = el('div', 'aln-body mono', undefined, { role: 'region', 'aria-label': 'Alignment', tabindex: 0 });
  const legend = el('div', 'aln-legend');
  const empty = el('p', 'hint', 'The alignment appears here.');
  const progressNote = el('p', 'hint', '', { 'aria-live': 'polite' });
  root.append(nav, body, progressNote, legend, empty);

  let data: AlignmentViewData | null = null;
  let index = 0;
  let renderToken = 0;

  /** Characters per line that fit in the current width. */
  const perLine = (): number => {
    const probe = el('span', 'res', 'M');
    body.append(probe);
    const cw = probe.getBoundingClientRect().width || 9;
    probe.remove();
    const avail = body.clientWidth - 24 - LABEL_W * cw * 2;
    return Math.max(20, Math.min(120, Math.floor(avail / cw / 10) * 10));
  };

  const legendFor = (alphabet: Alphabet): void => {
    clear(legend);
    const items: [string, string][] = alphabet === 'protein'
      ? [['r-hydrophobic', 'hydrophobic (AVLIMFW)'], ['r-polar', 'polar (STNQY)'], ['r-positive', 'positive (KRH)'], ['r-negative', 'negative (DE)'], ['r-special', 'special (CGP)']]
      : [['r-A', 'A'], ['r-C', 'C'], ['r-G', 'G'], ['r-T', alphabet === 'rna' ? 'U' : 'T']];
    legend.append(el('span', 'hint', 'Colours (letters are always shown): '));
    for (const [cls, text] of items) legend.append(el('span', `res chip ${cls}`, text));
    legend.append(el('span', 'hint', '  Match line: | identical · : positive score · . score 0 · blank otherwise.'));
  };

  const render = (): void => {
    renderToken++; // cancels any batch of an older render still in progress
    clear(body);
    const aln = data?.all[index];
    empty.hidden = data !== null && aln !== undefined;
    nav.hidden = !data || data.all.length < 2;
    if (!data || !aln) { clear(legend); return; }
    navText.textContent = `Alignment ${index + 1} of ${data.all.length}${data.capped ? '+ (enumeration cap reached; more co-optimal alignments exist)' : ''} · all have the same optimal score`;
    prev.disabled = index === 0;
    next.disabled = index === data.all.length - 1;
    legendFor(data.alphabet);
    if (aln.rowA.length === 0) { body.append(el('p', 'hint', 'No positive-scoring local alignment exists for these sequences and scores (best local score is 0).')); return; }
    const cols = perLine();
    const mline = data.matchLines[index] ?? '';
    const alphabet = data.alphabet;
    const total = Math.ceil(aln.rowA.length / cols);
    const myRender = renderToken;
    let ia = aln.startA; let ib = aln.startB;
    let s = 0;
    /** Renders a few blocks, then yields to the browser so very long alignments never freeze the UI. */
    const batch = (): void => {
      if (myRender !== renderToken) return; // a newer render replaced this one
      const stop = Math.min(aln.rowA.length, s + 12 * cols);
      for (; s < stop; s += cols) {
        const block = el('div', 'aln-block');
        const slice = (row: string): string => row.slice(s, s + cols);
        const a = slice(aln.rowA); const b = slice(aln.rowB); const m = slice(mline);
        const startA = ia + 1; const startB = ib + 1;
        for (const ch of a) if (ch !== '-') ia++;
        for (const ch of b) if (ch !== '-') ib++;
        const ruler = el('div', 'aln-line ruler');
        ruler.append(el('span', 'aln-label', '', {}));
        const rulerChars = Array.from({ length: a.length }, () => ' ');
        for (let k = 0; k < a.length; k++) {
          const col = s + k + 1;
          if (col % 10 === 0) { const t = String(col); for (let q = 0; q < t.length; q++) { const pos = k - (t.length - 1) + q; if (pos >= 0) rulerChars[pos] = t.charAt(q); } }
        }
        ruler.append(el('span', 'aln-seq', rulerChars.join('')));
        const line = (label: string, text: string, end: string, residues: boolean): HTMLElement => {
          const d = el('div', 'aln-line');
          d.append(el('span', 'aln-label', label));
          const seq = el('span', 'aln-seq');
          for (const ch of text) seq.append(el('span', residues ? `res ${residueClass(ch, alphabet)}` : 'res', ch === ' ' ? ' ' : ch));
          d.append(seq, el('span', 'aln-end', end));
          return d;
        };
        block.append(ruler,
          line(`A ${String(startA).padStart(5)}`, a, String(ia), true),
          line('', m, '', false),
          line(`B ${String(startB).padStart(5)}`, b, String(ib), true));
        body.append(block);
      }
      if (s < aln.rowA.length) { progressNote.textContent = `Rendering… ${Math.round((s / aln.rowA.length) * 100)} % of ${total} blocks`; setTimeout(batch, 0); }
      else progressNote.textContent = '';
    };
    batch();
  };

  prev.addEventListener('click', () => { if (data && index > 0) { index--; render(); const a = data.all[index]; if (a) onPick(a); } });
  next.addEventListener('click', () => { if (data && index < data.all.length - 1) { index++; render(); const a = data.all[index]; if (a) onPick(a); } });
  new ResizeObserver(() => { if (body.isConnected && body.clientWidth > 0) render(); }).observe(body);

  return {
    root,
    setData(d) { data = d; index = 0; render(); },
    current: () => data?.all[index] ?? null,
    toPng() {
      const aln = data?.all[index];
      if (!data || !aln || aln.rowA.length === 0) return null;
      const cw = 10; const lh = 18; const cols = 80; const labelW = 90;
      const blocks = Math.ceil(aln.rowA.length / cols);
      const c = document.createElement('canvas');
      c.width = labelW + cols * cw + 70; c.height = blocks * lh * 4 + 20;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.font = '13px ui-monospace, Menlo, monospace'; ctx.textBaseline = 'middle';
      const mline = data.matchLines[index] ?? '';
      for (let b = 0; b < blocks; b++) {
        const y0 = 10 + b * lh * 4;
        [[aln.rowA, 'A'], [mline, ''], [aln.rowB, 'B']].forEach(([row, label], r) => {
          ctx.fillStyle = '#1d1730'; ctx.textAlign = 'left';
          ctx.fillText(label ?? '', 6, y0 + r * lh + lh / 2);
          for (let k = 0; k < cols; k++) {
            const ch = (row ?? '').charAt(b * cols + k);
            if (ch === '') break;
            ctx.fillStyle = '#1d1730'; ctx.textAlign = 'center';
            ctx.fillText(ch, labelW + k * cw + cw / 2, y0 + r * lh + lh / 2);
          }
        });
      }
      return c.toDataURL('image/png');
    },
  };
}
