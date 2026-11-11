// Scoring panel: mode, gap model, substitution scores or matrix, presets, and plain-English explanations.
import type { Alphabet, AlignMode, GapModel, ScoringSpec } from '../shared/types';
import { getMatrix, listMatrices } from '../backend/api';
import { el } from './dom';
import { PRESETS, gapCostText } from './model';

export interface ScoringState {
  mode: AlignMode;
  scoring: ScoringSpec;
}

export interface ScoringPanel {
  root: HTMLElement;
  setState(s: ScoringState, alphabet: Alphabet | 'unknown'): void;
  getState(): ScoringState;
}

/** Builds the panel. `onChange` is called with a valid state whenever the user edits a control. */
export function createScoringPanel(initial: ScoringState, onChange: (s: ScoringState) => void, opts: { hideMode?: boolean } = {}): ScoringPanel {
  let state: ScoringState = initial;
  let alphabet: Alphabet | 'unknown' = 'unknown';
  const root = el('div', 'scoring');

  const presetSel = el('select', undefined, undefined, { 'aria-label': 'Scoring preset' });
  presetSel.append(el('option', undefined, 'Custom', { value: 'custom' }));
  for (const p of PRESETS) presetSel.append(el('option', undefined, p.label, { value: p.id }));
  const presetNote = el('p', 'hint');

  const modeSel = el('select', undefined, undefined, { 'aria-label': 'Alignment mode' });
  modeSel.append(el('option', undefined, 'Global (Needleman–Wunsch): align the whole of both sequences', { value: 'global' }), el('option', undefined, 'Local (Smith–Waterman): find the best-matching region', { value: 'local' }));
  const modeNote = el('p', 'hint');

  const gapKind = el('select', undefined, undefined, { 'aria-label': 'Gap model' });
  gapKind.append(el('option', undefined, 'Linear: every gap position costs the same', { value: 'linear' }), el('option', undefined, 'Affine: opening a gap costs more than extending it', { value: 'affine' }));
  const num = (label: string, aria: string): { input: HTMLInputElement; wrap: HTMLElement } => {
    const input = el('input', undefined, undefined, { type: 'number', step: 1, 'aria-label': aria });
    const wrap = el('label', 'field narrow');
    wrap.append(el('span', 'field-label', label), input);
    return { input, wrap };
  };
  const gap = num('Gap penalty', 'Linear gap penalty');
  const open = num('Gap open', 'Affine gap opening penalty');
  const ext = num('Gap extend', 'Affine gap extension penalty');
  const match = num('Match score', 'Match score');
  const mismatch = num('Mismatch score', 'Mismatch score');
  const gapNote = el('p', 'hint');
  const err = el('p', 'field-error', undefined, { role: 'alert' });

  const subKind = el('select', undefined, undefined, { 'aria-label': 'Substitution scoring' });
  subKind.append(el('option', undefined, 'Match / mismatch scores', { value: 'simple' }));
  for (const m of listMatrices()) subKind.append(el('option', undefined, `${m} (protein)`, { value: m }));
  const matrixDetails = el('details', 'matrix-details');
  const matrixSummary = el('summary', undefined, 'View substitution matrix');
  const matrixBody = el('div');
  matrixDetails.append(matrixSummary, matrixBody);

  const row = (...kids: HTMLElement[]): HTMLElement => { const r = el('div', 'row'); r.append(...kids); return r; };
  const lab = (t: string, c: HTMLElement): HTMLElement => { const l = el('label', 'field'); l.append(el('span', 'field-label', t), c); return l; };
  const gapRow = row(gap.wrap, open.wrap, ext.wrap);
  const simpleRow = row(match.wrap, mismatch.wrap);
  root.append(
    lab('Preset', presetSel), presetNote,
    ...(opts.hideMode === true ? [] : [lab('Mode', modeSel), modeNote]),
    lab('Substitution scores', subKind), simpleRow, matrixDetails,
    lab('Gap model', gapKind), gapRow, gapNote, err,
  );

  /** Renders the current substitution matrix as a small table with its citation. */
  const renderMatrix = (name: string): void => {
    matrixBody.replaceChildren();
    const m = getMatrix(name);
    const table = el('table', 'matrix-table');
    const head = el('tr');
    head.append(el('th'));
    for (const c of m.letters) head.append(el('th', undefined, c));
    table.append(head);
    for (const r of m.letters) {
      const tr = el('tr');
      tr.append(el('th', undefined, r));
      for (const c of m.letters) tr.append(el('td', undefined, String(m.get(r, c))));
      table.append(tr);
    }
    matrixBody.append(table, el('p', 'hint', m.citation), el('p', 'hint', `Source: ${m.source} SHA-256 of source file: ${m.sha256.slice(0, 16)}…`));
  };

  const readInt = (input: HTMLInputElement, label: string, min: number, max: number): number | string => {
    const v = Number(input.value);
    if (input.value.trim() === '' || !Number.isInteger(v)) return `${label} must be a whole number.`;
    if (v < min || v > max) return `${label} must be between ${min} and ${max}.`;
    return v;
  };

  /** Reads all controls into a state, or shows an error and returns null. */
  const read = (): ScoringState | null => {
    const errors: string[] = [];
    const take = (input: HTMLInputElement, label: string, min: number, max: number): number => {
      const r = readInt(input, label, min, max);
      if (typeof r === 'string') { errors.push(r); return 0; }
      return r;
    };
    let gaps: GapModel;
    if (gapKind.value === 'linear') gaps = { kind: 'linear', gap: take(gap.input, 'Gap penalty', 0, 10000) };
    else gaps = { kind: 'affine', open: take(open.input, 'Gap open', 0, 10000), extend: take(ext.input, 'Gap extend', 0, 10000) };
    let substitution: ScoringSpec['substitution'];
    if (subKind.value === 'simple') substitution = { kind: 'simple', match: take(match.input, 'Match score', -1000, 1000), mismatch: take(mismatch.input, 'Mismatch score', -1000, 1000) };
    else substitution = { kind: 'matrix', name: subKind.value };
    err.textContent = errors.join(' ');
    return errors.length > 0 ? null : { mode: modeSel.value === 'local' ? 'local' : 'global', scoring: { substitution, gaps } };
  };

  /** Pushes `state` into the controls and refreshes the explanatory text. */
  const show = (): void => {
    const s = state.scoring;
    modeSel.value = state.mode;
    modeNote.textContent = state.mode === 'global'
      ? 'Global: every residue of both sequences is aligned; end gaps are charged. Best when the sequences are similar over their whole length.'
      : 'Local: only the best-scoring region is reported and the score never drops below 0. Best for finding a shared domain inside longer sequences.';
    gapKind.value = s.gaps.kind;
    gap.input.value = String(s.gaps.kind === 'linear' ? s.gaps.gap : 5);
    open.input.value = String(s.gaps.kind === 'affine' ? s.gaps.open : (s.gaps.kind === 'linear' ? s.gaps.gap : 5));
    ext.input.value = String(s.gaps.kind === 'affine' ? s.gaps.extend : 1);
    gap.wrap.hidden = s.gaps.kind !== 'linear';
    open.wrap.hidden = ext.wrap.hidden = s.gaps.kind !== 'affine';
    gapNote.textContent = gapCostText(s.gaps);
    subKind.value = s.substitution.kind === 'simple' ? 'simple' : s.substitution.name;
    if (s.substitution.kind === 'simple') { match.input.value = String(s.substitution.match); mismatch.input.value = String(s.substitution.mismatch); }
    simpleRow.hidden = s.substitution.kind !== 'simple';
    matrixDetails.hidden = s.substitution.kind !== 'matrix';
    if (s.substitution.kind === 'matrix') renderMatrix(s.substitution.name);
    // Matrices are protein-only: disable them while the sequences are nucleotides.
    for (const o of Array.from(subKind.options)) o.disabled = o.value !== 'simple' && (alphabet === 'dna' || alphabet === 'rna');
    const preset = PRESETS.find((p) => JSON.stringify(p.scoring) === JSON.stringify(s));
    presetSel.value = preset?.id ?? 'custom';
    presetNote.textContent = preset?.description ?? 'Custom scoring: you changed the numbers yourself.';
    err.textContent = '';
  };

  const changed = (): void => {
    const next = read();
    if (next === null) return;
    state = next;
    show();
    onChange(state);
  };
  for (const c of [modeSel, gapKind, subKind]) c.addEventListener('change', changed);
  for (const i of [gap.input, open.input, ext.input, match.input, mismatch.input]) i.addEventListener('input', () => { const next = read(); if (next) { state = next; gapNote.textContent = gapCostText(state.scoring.gaps); onChange(state); } });
  presetSel.addEventListener('change', () => {
    const p = PRESETS.find((x) => x.id === presetSel.value);
    if (!p) return;
    state = { mode: state.mode, scoring: p.scoring };
    show();
    onChange(state);
  });

  show();
  return {
    root,
    setState(s, a) { state = s; alphabet = a; show(); },
    getState: () => state,
  };
}
