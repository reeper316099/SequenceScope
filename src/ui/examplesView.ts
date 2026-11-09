// Examples view: lists the bundled sets with their provenance and loads pairs into the Align view.
import { callout, card } from './cards';
import { clear, el } from './dom';
import { loadExampleIndex, loadExampleSet, recordText, shortName } from './examples';
import type { AppView } from './view';

/** Builds the Examples view; `openInAlign` switches to the Align view with the two texts loaded. */
export function createExamplesView(openInAlign: (a: string, b: string) => void, openInDistances: (setId: string, aligned: boolean) => void, openInMsa: (setId: string) => void): AppView {
  const root = el('div', 'view view-examples');
  let loaded = false;
  const build = async (): Promise<void> => {
    if (loaded) return;
    clear(root);
    try {
      const index = await loadExampleIndex();
      for (const s of index.sets) {
        const set = await loadExampleSet(s.id);
        const m = set.meta;
        const c = card(m.title, `${m.molecule} · ${m.records.length} records · retrieved ${m.retrieved}`);
        c.body.append(el('p', undefined, m.purpose), el('p', 'hint', m.notes));
        const table = el('table', 'matrix-table', undefined, { 'aria-label': `Records in ${m.title}` });
        const head = el('tr'); for (const h of ['Accession', 'Name', 'Length']) head.append(el('th', undefined, h));
        table.append(head);
        set.records.forEach((r, k) => { const tr = el('tr'); tr.append(el('td', undefined, m.records[k]?.accession ?? r.id), el('td', undefined, shortName(r)), el('td', undefined, String(r.residues.length))); table.append(tr); });
        const scroll = el('div', 'matrix-table-wrap'); scroll.append(table);
        c.body.append(scroll);
        const aSel = el('select', undefined, undefined, { 'aria-label': `Sequence A from ${m.title}` });
        const bSel = el('select', undefined, undefined, { 'aria-label': `Sequence B from ${m.title}` });
        set.records.forEach((r, k) => { aSel.append(el('option', undefined, `${m.records[k]?.accession ?? r.id}: ${shortName(r)}`, { value: String(k) })); bSel.append(el('option', undefined, `${m.records[k]?.accession ?? r.id}: ${shortName(r)}`, { value: String(k) })); });
        bSel.value = String(Math.min(1, set.records.length - 1));
        const go = el('button', 'btn btn-primary', 'Align this pair →', { type: 'button' });
        go.addEventListener('click', () => { const ra = set.records[Number(aSel.value)]; const rb = set.records[Number(bSel.value)]; if (ra && rb) openInAlign(recordText(ra), recordText(rb)); });
        const row = el('div', 'row'); row.append(aSel, bSel, go);
        c.body.append(row);
        if (set.records.length >= 3) {
          const dRow = el('div', 'row');
          const toM = el('button', 'btn', 'Align the whole set (MSA) →', { type: 'button' });
          toM.addEventListener('click', () => openInMsa(s.id));
          dRow.append(toM);
          const toD = el('button', 'btn', 'Open the whole set in Distances →', { type: 'button' });
          toD.addEventListener('click', () => openInDistances(s.id, false));
          dRow.append(toD);
          if (s.aligned) {
            const toDA = el('button', 'btn', 'Open the MAFFT-aligned copy in Distances →', { type: 'button' });
            toDA.addEventListener('click', () => openInDistances(s.id, true));
            dRow.append(toDA);
          }
          c.body.append(dRow);
        }
        c.body.append(callout('info', `License: ${m.license.name}. “${m.license.quote}” Citation: ${m.citation}${m.aligned ? ` Pre-aligned copy produced with ${m.aligned.tool} ${m.aligned.version} (derived data, used from Milestone B).` : ''}`));
        root.append(c.root);
      }
      loaded = true;
    } catch (e) {
      root.append(callout('error', e instanceof Error ? e.message : 'Could not load the examples.'));
    }
  };
  void build();
  return { id: 'examples', title: 'Examples', root, onShow: () => void build() };
}
