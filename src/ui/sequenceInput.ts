// Sequence input box: textarea + drag-and-drop + native Open + live validation messages + cleaned-input preview.
import { MAX_OPEN_FILE_BYTES } from '../shared/types';
import { callout, toast } from './cards';
import { clear, el } from './dom';
import type { AnalyzedSequence } from './model';

export interface SequenceInput {
  root: HTMLElement;
  getText(): string;
  setText(text: string): void;
  showAnalysis(a: AnalyzedSequence): void;
}

/** Creates one labelled input box ("A" or "B"). `onInput` fires on every edit with the raw text. */
export function createSequenceInput(label: 'A' | 'B', onInput: (text: string) => void): SequenceInput {
  const root = el('div', 'seq-input');
  const head = el('div', 'seq-head');
  const title = el('h3', undefined, `Sequence ${label}`);
  const badge = el('span', 'badge', 'empty');
  const openBtn = el('button', 'btn btn-small', 'Open file…', { type: 'button' });
  head.append(title, badge, openBtn);

  const area = el('textarea', 'seq-area', undefined, { 'aria-label': `Sequence ${label}: paste residues or FASTA`, spellcheck: false, rows: 5, placeholder: 'Paste residues or FASTA here, or drop a FASTA file…' });
  const messages = el('div', 'seq-messages', undefined, { 'aria-live': 'polite' });
  const preview = el('details', 'seq-preview');
  preview.append(el('summary', undefined, 'Cleaned input preview'));
  const previewText = el('pre', 'mono');
  preview.append(previewText);
  root.append(head, area, messages, preview);

  area.addEventListener('input', () => onInput(area.value));

  openBtn.addEventListener('click', () => {
    void window.sequenceScope.openFile('fasta').then((r) => {
      if (r.ok) { area.value = r.text; onInput(area.value); toast(`Loaded ${r.name} into sequence ${label}.`); }
      else if (r.reason !== 'cancelled') toast(r.message);
    });
  });

  for (const ev of ['dragenter', 'dragover'] as const) root.addEventListener(ev, (e) => { e.preventDefault(); root.classList.add('drop'); });
  for (const ev of ['dragleave', 'drop'] as const) root.addEventListener(ev, () => root.classList.remove('drop'));
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    if (file.size > MAX_OPEN_FILE_BYTES) { toast(`${file.name} is larger than the ${MAX_OPEN_FILE_BYTES / 1048576} MB limit.`); return; }
    void file.text().then((t) => { area.value = t; onInput(t); toast(`Loaded ${file.name} into sequence ${label}.`); });
  });

  return {
    root,
    getText: () => area.value,
    setText: (t) => { area.value = t; },
    showAnalysis(a) {
      badge.textContent = a.empty ? 'empty' : `${a.residues.length.toLocaleString('en-US')} residues · ${a.alphabet}${a.detection?.confidence === 'low' ? ' (low confidence)' : ''}`;
      clear(messages);
      for (const issue of a.issues) messages.append(callout(issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warn' : 'info', issue.message));
      previewText.textContent = a.empty ? '(nothing yet)' : `${a.id}\n${a.residues.slice(0, 600)}${a.residues.length > 600 ? `… (+${a.residues.length - 600} more)` : ''}`;
    },
  };
}
