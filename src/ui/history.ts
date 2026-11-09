// Bounded undo/redo history of snapshots (used for inputs and parameters).
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private current: T;

  /** Starts with an initial snapshot; at most `limit` undo steps are kept. */
  constructor(initial: T, private readonly limit = 100) {
    this.current = initial;
  }

  /** Records a new state (clears the redo stack). Identical consecutive states are ignored. */
  push(next: T): void {
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.past.push(this.current);
    if (this.past.length > this.limit) this.past.shift();
    this.current = next;
    this.future = [];
  }

  /** Steps back; returns the state to show, or null if there is nothing to undo. */
  undo(): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(this.current);
    this.current = prev;
    return prev;
  }

  /** Steps forward again; returns null if there is nothing to redo. */
  redo(): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(this.current);
    this.current = next;
    return next;
  }

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  get size(): number { return this.past.length; }
}
