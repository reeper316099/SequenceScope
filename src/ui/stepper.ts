// Step-through controller: play / pause / step forward / step back / speed / jump. It only counts steps; the Align
// view turns a step number into "which cell is filled / which traceback cell is shown".
//   steps 0 .. interior          : fill the matrix one interior cell at a time (row-major, left to right, top to bottom)
//   steps interior+1 .. +pathLen : walk the traceback from the end cell back to the start
import { el, prefersReducedMotion } from './dom';

export interface StepState {
  step: number;
  total: number;
  filled: number;
  pathShown: number;
  phase: 'start' | 'fill' | 'traceback' | 'done';
}

export interface Stepper {
  root: HTMLElement;
  /** Configure for a new matrix; `disabledReason` (if set) explains why stepping is unavailable. */
  configure(interior: number, pathLen: number, disabledReason?: string): void;
  getState(): StepState;
  toggle(): void;
  stepBy(delta: number): void;
  jumpToEnd(): void;
  reset(): void;
}

/** Builds the stepper UI. `onChange` runs on every step change. */
export function createStepper(onChange: (s: StepState) => void): Stepper {
  const root = el('div', 'stepper', undefined, { role: 'group', 'aria-label': 'Step through the algorithm', tabindex: 0 });
  const reduced = prefersReducedMotion();
  const btn = (label: string, aria: string): HTMLButtonElement => el('button', 'btn btn-small', label, { type: 'button', 'aria-label': aria, title: aria });
  const toStart = btn('⏮', 'Back to the start');
  const back = btn('◀', 'Step back (Left arrow)');
  const play = btn('▶ Play', 'Play or pause (Space)');
  const fwd = btn('▶', 'Step forward (Right arrow)');
  const toEnd = btn('⏭', 'Jump to the end');
  const speed = el('input', undefined, undefined, { type: 'range', min: 0, max: 100, value: 40, 'aria-label': 'Speed in cells per second' });
  const speedLabel = el('span', 'mono hint');
  const scrub = el('input', 'scrub', undefined, { type: 'range', min: 0, max: 0, value: 0, 'aria-label': 'Position in the algorithm' });
  const status = el('p', 'stepper-status', undefined, { 'aria-live': 'polite' });
  const reason = el('p', 'hint');
  const bar = el('div', 'row');
  bar.append(toStart, back, play, fwd, toEnd, speed, speedLabel);
  root.append(bar, scrub, status, reason);

  let interior = 0;
  let pathLen = 0;
  let step = 0;
  let playing = false;
  let raf = 0;
  let last = 0;
  let acc = 0;
  let enabled = false;

  /** Cells per second from the slider (1 .. 2000, logarithmic). */
  const cellsPerSecond = (): number => Math.round(10 ** (Number(speed.value) / 100 * 3.3));
  const total = (): number => interior + pathLen;
  const state = (): StepState => ({
    step, total: total(),
    filled: Math.min(step, interior),
    pathShown: Math.max(0, step - interior),
    phase: step === 0 ? 'start' : step < interior ? 'fill' : step < total() ? 'traceback' : 'done',
  });
  const refresh = (): void => {
    const s = state();
    scrub.max = String(total());
    scrub.value = String(step);
    play.textContent = playing ? '⏸ Pause' : '▶ Play';
    speedLabel.textContent = `${cellsPerSecond()} cells/s`;
    status.textContent = !enabled ? '' : s.phase === 'start' ? `Ready: ${interior.toLocaleString('en-US')} cells to fill, then ${pathLen} traceback steps.`
      : s.phase === 'fill' ? `Filling the matrix: cell ${s.filled.toLocaleString('en-US')} of ${interior.toLocaleString('en-US')}`
        : s.phase === 'traceback' ? `Traceback: step ${s.pathShown} of ${pathLen}`
          : 'Done: the traceback path is the alignment.';
    for (const b of [toStart, back, play, fwd, toEnd, speed, scrub]) b.disabled = !enabled;
    play.hidden = speed.hidden = speedLabel.hidden = reduced;
    onChange(s);
  };
  const stop = (): void => { playing = false; cancelAnimationFrame(raf); };
  const stepBy = (d: number): void => {
    if (!enabled) return;
    step = Math.max(0, Math.min(total(), step + d));
    if (step >= total()) stop();
    refresh();
  };
  const frame = (t: number): void => {
    if (!playing) return;
    acc += ((t - last) / 1000) * cellsPerSecond();
    last = t;
    const whole = Math.floor(acc);
    if (whole > 0) { acc -= whole; stepBy(whole); }
    if (playing) raf = requestAnimationFrame(frame);
  };
  const toggle = (): void => {
    if (!enabled || reduced) return;
    if (playing) { stop(); refresh(); return; }
    if (step >= total()) step = 0;
    playing = true; last = performance.now(); acc = 0;
    raf = requestAnimationFrame(frame);
    refresh();
  };
  toStart.addEventListener('click', () => { stop(); step = 0; refresh(); });
  toEnd.addEventListener('click', () => { stop(); step = total(); refresh(); });
  back.addEventListener('click', () => { stop(); stepBy(-1); });
  fwd.addEventListener('click', () => { stop(); stepBy(1); });
  play.addEventListener('click', toggle);
  speed.addEventListener('input', refresh);
  scrub.addEventListener('input', () => { stop(); step = Number(scrub.value); refresh(); });
  root.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLButtonElement && e.key === ' ') return; // let a focused button handle its own Space
    if (e.key === ' ') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stop(); stepBy(e.shiftKey ? 10 : 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); stop(); stepBy(e.shiftKey ? -10 : -1); }
    else if (e.key === 'Home') { e.preventDefault(); stop(); step = 0; refresh(); }
    else if (e.key === 'End') { e.preventDefault(); stop(); step = total(); refresh(); }
  });

  return {
    root,
    configure(i, p, disabledReason) {
      stop();
      interior = i; pathLen = p; step = 0;
      enabled = disabledReason === undefined && i + p > 0;
      reason.textContent = disabledReason ?? (reduced ? 'Reduced motion is on: use the step buttons (no animation).' : '');
      refresh();
    },
    getState: state,
    toggle,
    stepBy: (d) => { stop(); stepBy(d); },
    jumpToEnd() { stop(); if (enabled) { step = total(); refresh(); } },
    reset() { stop(); step = 0; refresh(); },
  };
}
