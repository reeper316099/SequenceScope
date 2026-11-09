// Views that belong to later milestones: honest about not being built yet (no fake content).
import { callout, card } from './cards';
import { el } from './dom';
import type { AppView } from './view';

/** A view that explains what a later milestone will provide. */
export function createComingSoonView(id: string, title: string, milestone: string, description: string): AppView {
  const root = el('div', 'view');
  const c = card(title, milestone);
  c.body.append(callout('info', `${milestone}: not built yet. ${description}`));
  root.append(c.root);
  return { id, title, root };
}
