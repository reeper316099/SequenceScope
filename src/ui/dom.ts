// Tiny DOM helpers. All text goes through textContent (never innerHTML), so the strict CSP and XSS safety stay simple.

type Attrs = Record<string, string | number | boolean | undefined>;

/** Creates an element with optional class, text, and attributes. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string, attrs?: Attrs): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined && className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : String(v));
  return node;
}

const MATHML = 'http://www.w3.org/1998/Math/MathML';

/** Creates a MathML element (used by the Learn view; MathML renders natively in Chromium). */
export function mml(tag: string, text?: string, ...children: Element[]): Element {
  const node = document.createElementNS(MATHML, tag);
  if (text !== undefined) node.textContent = text;
  for (const c of children) node.append(c);
  return node;
}

/** Removes all children of a node. */
export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Debounces a function (used for live validation and auto-run). */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (t !== undefined) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Builds a labelled form field (label + control) with an optional hint line. */
export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = el('label', 'field');
  wrap.append(el('span', 'field-label', label), control);
  if (hint !== undefined) wrap.append(el('span', 'field-hint', hint));
  return wrap;
}

/** True when the user asked the OS for reduced motion. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** True if the event target is a place where typing text should not trigger shortcuts. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || (target.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'range'].includes((target as HTMLInputElement).type)) || target.isContentEditable;
}
