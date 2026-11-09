// Shared state between the Distances and Trees views: the current sequence set, settings, and the distance matrix.
import type { Alphabet, AlphabetChoice, DistanceMatrix, DistanceModel, GapPolicy } from '../shared/types';
import type { AnalyzedSet, SetMode } from './sequenceSet';

export interface DataState {
  text: string;
  alphabetChoice: AlphabetChoice;
  modeChoice: SetMode | 'auto';
  analysis: AnalyzedSet | null;
  model: DistanceModel;
  gapPolicy: GapPolicy;
  presetId: string; // alignment scoring preset (unaligned route)
  matrix: DistanceMatrix | null;
  /** Alphabet used for the matrix (so views can pick models/labels). */
  alphabet: Alphabet | null;
  /** Aligned rows used for the matrix, when the input was an alignment (needed for bootstrap). */
  alignedRows: string[] | null;
}

type Listener = (s: DataState) => void;

export class DataStore {
  state: DataState = { text: '', alphabetChoice: 'auto', modeChoice: 'auto', analysis: null, model: 'p', gapPolicy: 'pairwise-deletion', presetId: 'dna-affine', matrix: null, alphabet: null, alignedRows: null };
  private listeners: Listener[] = [];

  /** Merges a partial state and notifies subscribers. */
  update(patch: Partial<DataState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  /** Registers a listener (called after every update). */
  subscribe(fn: Listener): void {
    this.listeners.push(fn);
  }
}
