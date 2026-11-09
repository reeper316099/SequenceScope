// Right-hand details panel: explains the selected / current DP cell with the real numbers filled in.
import type { CellInfo, Dp } from '../bio/pairwise';
import { cellInfo } from '../bio/pairwise';
import { clear, el } from './dom';

export interface DetailsPanel {
  root: HTMLElement;
  show(dp: Dp | null, cell: { i: number; j: number } | null, context?: string): void;
}

const minus = (n: number): string => (n < 0 ? `−${Math.abs(n)}` : String(n));
const fmt = (n: number): string => (n <= -500_000_000 ? '−∞' : minus(n));

/** Builds the panel; it starts with a short help text. */
export function createDetailsPanel(): DetailsPanel {
  const root = el('aside', 'details', undefined, { 'aria-label': 'Details' });
  const title = el('h2', undefined, 'Details');
  const body = el('div', 'details-body');
  root.append(title, body);

  const help = (): void => {
    clear(body);
    body.append(
      el('p', undefined, 'Click a cell of the score matrix (or move with the arrow keys while the matrix is focused) to see how its value was computed.'),
      el('p', 'hint', 'Tip: use the step-through controls to watch the matrix fill cell by cell, then the traceback that reads off the alignment.'),
    );
  };
  help();

  /** Writes one labelled line. */
  const line = (label: string, text: string, strong = false): HTMLElement => {
    const p = el('p', strong ? 'calc strong' : 'calc');
    p.append(el('span', 'calc-label', label), el('span', 'mono', text));
    return p;
  };

  const linear = (info: Extract<CellInfo, { kind: 'linear' }>, dp: Dp): void => {
    const g = dp.scoring.gapOpen;
    const a = dp.strA.charAt(info.i - 1); const b = dp.strB.charAt(info.j - 1);
    body.append(
      el('p', undefined, `Cell (i = ${info.i}, j = ${info.j}): compare a${info.i} = ${a} with b${info.j} = ${b}. The scoring scheme gives s = ${fmt(info.s)}.`),
      line('diagonal', `H[${info.i - 1}][${info.j - 1}] + s = ${fmt(info.diag - info.s)} + ${fmt(info.s)} = ${fmt(info.diag)}`),
      line('up (a' + info.i + ' against a gap)', `H[${info.i - 1}][${info.j}] − gap = ${fmt(info.up + g)} − ${g} = ${fmt(info.up)}`),
      line('left (b' + info.j + ' against a gap)', `H[${info.i}][${info.j - 1}] − gap = ${fmt(info.left + g)} − ${g} = ${fmt(info.left)}`),
    );
    if (dp.mode === 'local') body.append(line('zero (start fresh)', '0'));
    body.append(line(`H[${info.i}][${info.j}]`, `= max(${[info.diag, info.up, info.left, ...(dp.mode === 'local' ? [0] : [])].map(fmt).join(', ')}) = ${fmt(info.value)}`, true));
    body.append(el('p', 'hint', info.zeroFloor ? 'Every option was 0 or negative, so the cell is 0: a local alignment never has a negative running score, and the traceback stops here.' : `Move(s) that give the maximum: ${info.chosen.join(', ')}. When several tie, the traceback prefers diagonal, then up, then left.`));
  };

  const affine = (info: Extract<CellInfo, { kind: 'affine' }>, dp: Dp): void => {
    const open = dp.scoring.gapOpen; const ext = dp.scoring.gapExtend;
    const a = dp.strA.charAt(info.i - 1); const b = dp.strB.charAt(info.j - 1);
    body.append(el('p', undefined, `Cell (i = ${info.i}, j = ${info.j}): a${info.i} = ${a}, b${info.j} = ${b}, s = ${fmt(info.s)}. Three scores are kept: M (a${info.i} paired with b${info.j}), X (a${info.i} against a gap), Y (b${info.j} against a gap).`));
    body.append(line('M', `max(M ${fmt(info.M.fromM)}, X ${fmt(info.M.fromX)}, Y ${fmt(info.M.fromY)}${dp.mode === 'local' ? ', 0' : ''}) + ${fmt(info.s)} = ${fmt(info.M.value)}`, true), el('p', 'hint', `from: ${info.M.chosen.join(', ') || '—'}`));
    body.append(line('X', `max(open from M ${fmt(info.X.openFromM)}, extend X ${fmt(info.X.extendX)}, open from Y ${fmt(info.X.openFromY)}) = ${fmt(info.X.value)}`, true), el('p', 'hint', `from: ${info.X.chosen.join(', ') || '—'} (opening costs ${open}, extending costs ${ext})`));
    body.append(line('Y', `max(open from M ${fmt(info.Y.openFromM)}, open from X ${fmt(info.Y.openFromX)}, extend Y ${fmt(info.Y.extendY)}) = ${fmt(info.Y.value)}`, true), el('p', 'hint', `from: ${info.Y.chosen.join(', ') || '—'}`));
  };

  return {
    root,
    show(dp, cell, context) {
      clear(body);
      if (!dp || !cell) { help(); return; }
      if (context !== undefined) body.append(el('p', 'phase', context));
      const info = cellInfo(dp, cell.i, cell.j);
      if (info.kind === 'border') body.append(el('p', undefined, `Border cell (i = ${info.i}, j = ${info.j}), value ${fmt(info.value)}.`), el('p', 'hint', info.note));
      else if (info.kind === 'linear') linear(info, dp);
      else affine(info, dp);
    },
  };
}
