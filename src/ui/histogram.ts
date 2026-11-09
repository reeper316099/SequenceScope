// Pure histogram binning for the shuffle-score chart (unit-tested).
export interface Histogram {
  labels: string[];
  counts: number[];
  /** Index of the bin that contains the real score. */
  realBin: number;
  binWidth: number;
  min: number;
}

/** Bins integer scores into at most `maxBins` equal-width bins; the range always includes `realScore`. */
export function histogram(scores: ArrayLike<number>, realScore: number, maxBins = 30): Histogram {
  let min = realScore;
  let max = realScore;
  for (let k = 0; k < scores.length; k++) {
    const s = scores[k] as number; // safe: k < length
    if (s < min) min = s;
    if (s > max) max = s;
  }
  const binWidth = Math.max(1, Math.ceil((max - min + 1) / maxBins));
  const n = Math.floor((max - min) / binWidth) + 1;
  const counts = new Array<number>(n).fill(0);
  for (let k = 0; k < scores.length; k++) {
    const idx = Math.floor(((scores[k] as number) - min) / binWidth); // safe: k < length
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  const labels = counts.map((_, b) => (binWidth === 1 ? String(min + b) : `${min + b * binWidth}–${min + (b + 1) * binWidth - 1}`));
  return { labels, counts, realBin: Math.floor((realScore - min) / binWidth), binWidth, min };
}
