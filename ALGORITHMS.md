# ALGORITHMS.md — recurrences, conventions, and how each was checked

Status: **Phase 3 (pairwise core implemented and tested).** Everything marked ✔ was checked by running code on 2026-11-08; items marked ◻ are
decisions that get their tests in later phases. Nothing here is "from memory without a check".

## 0. Notation
Sequences `a = a₁…a_m`, `b = b₁…b_n`. `s(x,y)` = substitution score. `H[i][j]` = best score of an alignment of
`a₁…a_i` with `b₁…b_j`. Penalties are entered in the UI as **positive** numbers and stored as negative scores.

## 1. Linear gaps (Needleman–Wunsch / Smith–Waterman)
Gap of length k costs `k·g`.

- Global: `H[i][j] = max( H[i-1][j-1] + s(a_i,b_j),  H[i-1][j] − g,  H[i][j-1] − g )`, `H[i][0] = −i·g`, `H[0][j] = −j·g`. Answer `H[m][n]`. ✔ standard result; will be proven exact by brute force (Phase 3).
- Local: same recurrence with a fourth option `0`: `H[i][j] = max(0, …)`, first row/column = 0. Answer = max over **all** cells; traceback stops at a cell with value 0. Requires `s` to have a negative expected score, otherwise the local alignment degenerates to the whole sequence. ✔ condition stated.

## 2. Affine gaps (Gotoh) — convention
**A gap of length k costs `open + (k−1)·extend`** (the first gap column pays `open`, each further one pays `extend`).
✔ Verified empirically against Biopython 1.86: gaps of length 1, 2, 3 with open=−10, extend=−1 scored −10, −11, −12.
Biopython also penalises **end gaps** in global mode exactly like internal gaps; we do the same. In local mode there are no end gaps.

Three states: `M` (a_i aligned to b_j), `X` (a_i against a gap), `Y` (b_j against a gap).
```
M[i][j] = max(M,X,Y)[i-1][j-1] + s(a_i,b_j)
X[i][j] = max( max(M,Y)[i-1][j] − open,  X[i-1][j] − extend )
Y[i][j] = max( max(M,X)[i][j-1] − open,  Y[i][j-1] − extend )
```
- **Direct gap-to-gap switch** (X↔Y, gap in one row immediately followed by a gap in the other): allowed and pays a fresh `open` (the formulas above include `Y` in the X-open term). ✔ Biopython's scores matched our independent re-scorer on all 23 global reference cases, which uses exactly this rule.
- `open = extend` ⇒ cost `k·open` ⇒ identical to linear gaps with `g = open`. Will be a property test.
- Local affine: add `0` to the `M` option only (an alignment can only start in `M`); answer = max of `M` over all cells.

## 3. Traceback, ties, co-optimal alignments
- **Preference order (deterministic):** diagonal, then up (gap in b), then left (gap in a). For affine, when leaving a state prefer `M`, then `X`, then `Y`. Local start cell: first maximum in row-major order.
- Optional enumeration of all co-optimal alignments by iterative DFS over all tied predecessors, **hard cap 1000** (`alignAll`; the first one always equals `align`) (the reference generator uses the same cap and records when it was hit). Local enumeration also enumerates tied start cells.
- Biopython's tie-breaking differs → cross-check compares **scores exactly** and checks our alignment is *valid* (re-scores to the reported score; gap-free rows equal the input, or the aligned substring for local). Strings are compared only when the optimum is unique (✔ 21 of 44 reference cases have a unique optimum).

## 4. Ambiguity codes and special characters
- Protein: `B, Z, X, *` are scored from the matrix (BLOSUM files define them). `J, U, O` have no matrix entry → treated as `X`. ◻
- DNA/RNA: IUPAC codes other than `ACGT(U)` score **0** against anything (neutral), including identical ambiguity codes. They are counted separately in the stats and never counted as identity. ◻
- ✔ **Difference from Biopython:** with plain match/mismatch scores Biopython treats `N` as a literal letter (`N` vs `N` = match, `N` vs `A` = mismatch). So reference cases use only unambiguous residues.
- Invalid characters are reported with positions, never dropped silently.

## 5. Facts needing conditions (corrections to the project brief)
1. *"Self-alignment global score = sum of diagonal scores"* is only guaranteed if `s(x,x) > 0` and `s(x,y) ≤ (s(x,x)+s(y,y))/2` for all pairs. ✔ Checked: holds for all 20 amino acids in BLOSUM45/62/80; for DNA it holds when `match > 0 ≥ mismatch`. The property test only runs for matrices that pass this check.
2. *"Adding a constant to gap penalties never improves the score"* is true when the constant is non-negative and added to the **penalty** (open and extend both become costlier). Precisely: the optimum is non-increasing in each penalty.
3. *Local score ≥ global score* holds for any scoring (a global alignment is one candidate local alignment) **provided** end gaps are penalised in global mode, which is our convention.
4. *Shuffle z-score:* local-alignment scores follow an extreme-value (Gumbel-like) distribution, not a normal one. The **empirical p-value is the primary number**; the z-score is shown as a rough guide with that caveat.
5. TypeScript 7.0.x is the npm "latest", but typescript-eslint 8.72.1 declares `typescript >=4.8.4 <6.1.0`; we pin **TypeScript 6.0.3**.

## 6. Distances
- p-distance: `p = D / L` where `L` = compared sites. **Gap policy (user option):** *pairwise deletion* (default: skip columns where either sequence has a gap) or *gaps as differences*. If `L = 0` → distance "undefined (no comparable sites)", never NaN.
- Jukes–Cantor (DNA): `d = −¾ ln(1 − 4p/3)`, defined for `p < ¾`. ✔ Round trip with `p = ¾(1 − e^{−4d/3})` checked numerically for d = 0.1, 0.5, 2.0. Assumes equal base frequencies and equal substitution rates.
- Poisson correction (protein): `d = −ln(1 − p)`, defined for `p < 1`. Approximation (equal rates over sites).
- `p` at/above the limit → state **"saturated"** (typed value, displayed explicitly, excluded from tree building with a clear error or user choice). ◻

## 7. UPGMA
Repeat: merge the closest pair of clusters `i, j` (distance `d`); new node height `d/2`; branch length to each child = `d/2 − height(child)`; `d(u,k) = (|i|·d(i,k) + |j|·d(j,k)) / (|i|+|j|)`. Output is ultrametric. Ties: lowest `(i,j)` by input order. ✔ Biopython UPGMA gave ultrametric results on the 6 reference matrices; exact-recovery test comes in Phase 5.

## 8. Neighbor-joining
With `n` taxa and `r_i = Σ_k d(i,k)`:
- `Q(i,j) = (n−2)·d(i,j) − r_i − r_j`; join the minimum.
- Branch `i → u`: `d(i,j)/2 + (r_i − r_j) / (2(n−2))`; `j → u` is `d(i,j) − that`.
- `d(u,k) = (d(i,k) + d(j,k) − d(i,j)) / 2`.
- ✔ Hand-checked on the exact additive 5-taxon fixture (`additive_5`): min‑Q pair is (A,B) (Q = −54) and the formula returns the true branch length 2.0 for A.
- **End condition:** when 3 taxa remain, join them in a star with branch lengths `x_i = (d(i,j) + d(i,k) − d(j,k)) / 2`.
- Ties: smallest Q, then lowest `(i,j)`. Order invariance is only claimed for matrices without ties.
- **Negative branch lengths can occur** (✔ seen in `noisy_7`: −0.084). Shown as-is with a visible warning; never clamped.

## 9. Midpoint rooting, splits, Robinson–Foulds
- Midpoint: take the leaf pair with the largest path length `D` (ties: lexicographic leaf names), put the root on that path at distance `D/2` from one end. ◻
- Split = bipartition of leaf set by removing one edge; only **non-trivial** splits (both sides ≥ 2 leaves) count.
- **Unrooted RF = |S₁ Δ S₂|** (symmetric difference of non-trivial splits). Some tools report half of this; the UI states which one it uses. ◻

## 10. Bootstrap (aligned input only)
Resample alignment **columns** with replacement (same number), recompute distances with the same model, rebuild the tree, count how often each reference-tree split appears. Support = `count / replicates · 100`. It measures **stability**, not probability of truth. It needs columns, which pairwise distances alone don't have. Reproducibility: replicate `r` uses its own PRNG stream derived from `(seed, r)`, so results don't depend on worker count. A replicate in which some pair has no comparable sites is recorded and counted, not hidden. ◻

## 11. Progressive MSA (simplified Feng–Doolittle / ClustalW style)
Pairwise distances → guide tree (UPGMA or NJ) → align in tree order with profile–profile DP. Column score = mean of `s(x,y)` over residue–residue pairs between the two columns (gap-containing pairs contribute 0); gap penalties applied per profile column, unscaled. "Once a gap, always a gap." Heuristic: no optimality guarantee; the real fraction of tiny cases where it reaches the brute-force optimum will be reported. ◻

## 12. Shuffle significance
Shuffle one sequence N times (composition preserved, seeded PRNG), re-align, then **p = (1 + #{shuffled ≥ real}) / (N + 1)** (never 0). Heuristic; the null (composition-preserving shuffle) ignores low-complexity/repeats.

## 13. PRNG
`sfc32` or `xoshiro128**` (32-bit state words, integer-only so results are identical on every platform), seeded via `splitmix32`. Known-answer test of the first outputs for fixed seeds. No `Math.random()` anywhere (lint rule).

## 14. Implementation notes and measured facts (Phase 3)
- **Size cap:** `(m+1)*(n+1) <= 5001*5001 = 25,010,001` cells (two 5,000-residue sequences). Memory: linear 5 B/cell (~125 MB), affine 14 B/cell (~350 MB). Larger requests throw `BioError('too-large')` before anything is allocated.
- **Integer scoring only** (match/mismatch in [-1000, 1000], gap penalties in [0, 10000]) so scores fit `Int32Array` exactly; "minus infinity" is -1e9 and every stored value is clamped so it cannot overflow.
- **Local alignments are reported in minimal form** (no zero-scoring prefix; traceback stops at a zero cell). Enumeration also lists alignments ending at every tied maximum cell. On 20 Biopython local reference cases with positive score, our co-optimal count equals Biopython's in 18; in 2 (case021, case027) we enumerate MORE (ties that extend to the sequence ends at the same score; each independently re-scores to the optimal score). Scores are equal in all 20.
- **Global co-optimal counts:** equal to Biopython's in all 21 reference cases where neither side hit the 1000 cap; unique-optimum rows are string-identical in all 9 such cases.
- **Speed (plain Node/V8, 2026-11-08, M-series Mac):** protein 5000x5000 with traceback: linear 260 ms, affine 599 ms (448 MB RSS); 2000x2000 affine 97 ms; 1000 shuffles of a 300x300 local affine score-only alignment: 1.4 s. (Under Vitest the same code is 4-7x slower because of its module transform; this is not representative of the app.)
- **Mutation check:** deliberately breaking the DP (affine extension cost; linear border initialisation) makes the brute-force test fail (7 and 5 failures); changing `pb <= 0` to `pb < 0` in the local start rule changes no score (equivalent mutant: only the pointer set differs).
