// Contract every top-level view implements so the router can mount it and forward menu actions.
import type { MenuAction } from '../shared/types';

export interface AppView {
  id: string;
  title: string;
  root: HTMLElement;
  /** Called every time the view becomes visible. */
  onShow?(): void;
  /** Handle a menu action; return true if the view consumed it. */
  handleAction?(action: MenuAction): boolean;
}
