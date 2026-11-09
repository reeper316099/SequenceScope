# ALGORITHMS.md — recurrences, conventions, and how each was checked

Status: **Milestone C core added (section 18).** Everything marked ✔ was checked by running code on 2026-11-08; items marked ◻ are
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

## 15. Distances, UPGMA, NJ, trees: implementation notes and verified facts (Milestone B)
- **Distance policy as built:** columns with a gap in BOTH sequences never count. Pairwise deletion skips a column with a gap in either; gaps-as-differences counts gap-vs-residue as a difference. Ambiguity codes (N, X, B, Z, ...) are skipped for that pair. A pair with no comparable sites is `undefined`; p at or above the JC (3/4) or Poisson (1) limit is `saturated`. Neither ever becomes NaN/Infinity; tree building refuses such matrices with a message naming the pairs.
- **Biopython cross-check of p-distance:** on the two MAFFT-aligned example sets our `gaps-as-differences` p equals Biopython's `identity` distance exactly (to 1e-9) once Biopython's convention is accounted for: it counts columns where both sequences have a gap as identical matches, we skip them. This is the only difference (largest raw difference 0.0032 in the globin set).
- **Biopython's `upgma()` is not UPGMA.** Its source averages the two old distances without cluster-size weights (`(dm[min_i,k] + dm[min_j,k]) / 2`), which is WPGMA. On every non-ultrametric reference matrix our UPGMA differs from Biopython's but equals SciPy's `linkage(method='average')` (true UPGMA, version recorded in `upgma_scipy.json`) in rooted clades and total length; an independent unweighted-average reference reproduces Biopython's trees exactly; on the ultrametric matrix all three agree. Tie-breaking also differs (Biopython takes the LAST minimal pair, we take the first).
- **NJ matches Biopython's neighbor-joining exactly** on all 6 reference matrices (same splits, total length within 1e-9, including the negative branch of the noisy matrices). Per-edge lengths are compared at 6e-6 only because Biopython's Newick text has 5 decimals.
- **Ties:** UPGMA and NJ take the first minimal pair in scan order (clusters in creation order: leaves in input order, merged clusters appended). On the Wikipedia NJ example the article's tie at step 2 (u-c vs d-e, Q = -28) resolves to u-c, as in the article.
- **Exact recovery (200 random trees each, 3-14 taxa; plus 40 taxa for NJ):** UPGMA recovers random ultrametric trees (same rooted clades, same branch lengths to 1e-9); NJ recovers random additive trees (RF = 0, same branch lengths to 1e-9).
- **Rooting:** a rooted-form root (2 children) is dissolved when re-rooting; the new root splits the chosen branch (default in the middle). Support values belong to branches, so both halves of a split branch carry the same value. Midpoint rooting ties are broken by the lexicographically smallest leaf pair; it assumes non-negative lengths.
- **Newick conventions as built:** unquoted underscores are kept; a numeric unquoted internal label is read as support; a quoted numeric label stays a label; only the first tree of a multi-tree file is used; nesting deeper than 3000 levels is refused.

## 16. Bootstrap as built
Replicate r draws its columns from its own stream `deriveSeed(seed, r)`; `bootstrapRange` computes any slice and `mergeBootstrap` adds slices, so supports are identical for 1, 2, 3 or 7 workers in any order (tested). Replicates whose resampled matrix has saturated or undefined pairs are counted as FAILED and as not containing any split (support is always count / total replicates); the number of failures is reported. Caps: 100 sequences, 50,000 columns, 1000 replicates, 5e9 column comparisons.

## 17. Caps (Milestone B)
100 sequences per set; pairwise-alignment distances limited to 1.5e9 cell updates in total (every pair aligned globally); bootstrap as above.

## 18. Progressive multiple alignment as built (Milestone C; section 11 made final)
- **Guide tree:** every pair is aligned globally (same scoring as the merges) and its p-distance (pairwise deletion) is taken; a pair with no comparable sites gets distance 1. UPGMA, or neighbor-joining rooted at its midpoint (only the branching order is used). Two sequences skip the tree; one is returned unchanged.
- **Profile-profile merge:** Gotoh affine DP over columns. Column score = (sum of s(a,b) over residue pairs a in the first column, b in the second) / (|A||B|); pairs with a gap contribute 0. Gap open/extend are charged per profile column, unscaled, with the same convention and tie order as the pairwise aligner, so merging two single sequences reproduces the pairwise global alignment exactly (rows and score; tested on 200 random pairs). End gaps are charged.
- **"Once a gap, always a gap":** a merge only inserts all-gap columns into the two profiles. Tested two ways: after any two-profile merge, deleting the inserted columns returns each input profile exactly (200 random profile pairs), and for every merge step in a 5-sequence run (40 seeded sets) the sub-alignment recorded at that step is exactly what remains in the final alignment once all-gap columns are removed.
- **Score:** the reported sum-of-pairs score is computed independently of the DP: every pair of rows is projected (columns where both have a gap are removed) and scored with the column-by-column scorer.
- **Measured guarantees and non-guarantees (seeded tests, 2026-11-08):**
  - Validity always holds: gap-free rows equal the inputs, rows have equal length, no all-gap column (property tests, DNA and protein).
  - On 200 seeded related sets the sum-of-pairs score was never below that of the trivially padded alignment (0 misses).
  - **Order sensitivity:** permuting the input order gave the same sum-of-pairs score in 110 of 150 sets (73.3 %); the largest difference was 18.7 % of the maximum attainable score. Order independence is therefore NOT claimed; only validity, and exact symmetry for two sequences.
  - **Versus the brute-force optimum** (every possible alignment of 3 sequences of 2-4 residues, match +2, mismatch -2, gap 3/1): the progressive score never exceeded the optimum and reached it in 92 of 150 cases (61.3 %). A pinned 3-sequence example (ACTA, GATC, GCGTG) scores -14 progressive versus -10 optimal.
  - **Versus MAFFT 7.526** (derived alignments stored in `examples/`): 100.00 % of MAFFT's aligned residue pairs are also aligned by our alignment on the 13 alpha-globins, and 98.75 % on the 10 CYTB sequences. This agreement is high because these sets are closely related and gap-poor; it says nothing about hard cases.
- **Speed and caps (plain Node, M-series Mac):** up to 50 sequences of up to 3,000 residues; the total pairwise work cap (1.5e9 cell updates) is the binding limit. Measured protein runs: 10 x 300 in 0.1 s, 20 x 500 in 0.9 s, 30 x 1000 in 7.6 s (566 MB peak RSS), 50 x 1000 in 20.3 s, 30 x 1500 in 17.1 s (934 MB). 50 x 1500 is refused with a typed error.
- **Conservation:** per-column identity (most common residue / all sequences), Shannon entropy over non-gap residues, conservation = (1 - H/Hmax) x (1 - gaps/n), and a consensus rule ('-' if more than half are gaps; else the most common residue, ties alphabetical, uppercase if identity >= 0.5, otherwise '.').
