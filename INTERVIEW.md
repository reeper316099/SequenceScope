# Interview talking points (first person)

Short, plain-language answers I can give about this project. Numbers are from the repository's own test runs (see README → Validation).

1. **What dynamic programming is, and how the alignment matrix works.**
   Comparing every possible way to line up two sequences is far too many options. Dynamic programming notices that the best alignment of the first *i* letters of A with the first *j* letters of B can be built from three smaller best answers: pair the two letters (diagonal), or put a gap in one sequence (up or left). So I fill a table where each cell is the maximum of those three options plus the score of that move. The bottom-right cell is the best score, and following the choices backwards (traceback) writes out the alignment. It takes time proportional to length × length instead of exponential time. In my app you can watch that table fill and click any cell to see the three candidates.

2. **Global vs local, and affine gaps.**
   Global (Needleman–Wunsch) makes both whole sequences fit and charges end gaps; local (Smith–Waterman) adds a zero option so the score never goes below 0 and only the best-matching region is reported. Linear gaps charge the same for every gap position; affine gaps charge a big price to open a gap and a small one to extend it, because one insertion/deletion event usually removes several letters at once. That needs three tables (pair, gap in A, gap in B). My convention is "a gap of length k costs open + (k−1)×extend", which I confirmed matches Biopython by experiment, and open = extend reduces to the linear case.

3. **How I proved the aligner correct.**
   Three independent ways. (a) Brute force: for tiny sequences I enumerate every possible alignment and check the DP score equals the true maximum, for global and local, linear and affine, DNA and protein. I also deliberately broke the DP (wrong extension cost, wrong border) and confirmed the test failed. (b) Properties on random inputs with fast-check: re-scoring the alignment with a separate scorer gives the same score, swapping sequences keeps the score, local ≥ global, self-alignment is 100 % identical, open = extend equals linear, and so on. (c) Cross-checks: 44 stored Biopython cases match exactly, and a fresh run of 6 new random cases driven through my real UI and its exported files matched Biopython with a maximum score difference of 0.

4. **UPGMA vs neighbor-joining, and when each misleads.**
   UPGMA keeps merging the two closest clusters and gives every leaf the same distance to the root, so it only works if everything evolved at the same rate (a molecular clock). Neighbor-joining corrects each taxon's distance by how far it is from everyone else, so it does not need a clock, but it returns an unrooted tree and can give negative branch lengths. The Learn view has a live example: two fast-evolving lineages are the two most distant taxa, UPGMA pairs the two slow ones instead and gets the wrong tree, neighbor-joining recovers the right one. A fun finding: Biopython's function called "UPGMA" averages without weighting by cluster size, which is really WPGMA; mine matches SciPy's true average linkage.

5. **How I proved the tree builders correct.**
   Exact recovery. I generate random trees with known branch lengths (ultrametric ones for UPGMA, additive ones for NJ), compute the exact distance matrix from them, run my builder, and check I get the same topology and the same branch lengths back to 1e-9 — 200 random trees each. I also reproduced the step-by-step numbers of the Wikipedia worked examples, replayed the recorded steps to rebuild the tree, and compared with Biopython (NJ) and SciPy (UPGMA).

6. **What a bootstrap value does and does not mean.**
   I resample the alignment's columns with replacement, rebuild the tree, and count how often each branch comes back. A value of 92 means that branch appeared in 92 of 100 resampled datasets. It measures stability under resampling. It is not the probability that the branch is true — a systematically wrong alignment can give confident wrong branches. The app says this next to the numbers and marks values under 70.

7. **Why bootstrap needs an alignment.**
   The unit being resampled is a column of the alignment. Pairwise distances computed by aligning each pair separately have no shared columns, so there is nothing to resample. That is why the aligned-input route and the app's own multiple alignment are the only ways to bootstrap, and why the Trees view explains this instead of silently doing something else.

8. **Why distance corrections saturate.**
   Two sequences that diverged for a long time can change the same site several times, so the raw fraction of differing sites underestimates the real number of changes. Jukes–Cantor, d = −¾ ln(1 − 4p/3), corrects for that, but at p = ¾ (random DNA differs at 3 of 4 sites) the logarithm blows up. Beyond it the distance is undefined, so I show "saturated" instead of NaN or infinity and refuse to build a tree from it, with an explanation.

9. **Why heavy work runs in workers, and the security design.**
   Alignments, shuffles, bootstrap, distances and multiple alignment can take seconds, so they run in Web Workers with progress and Cancel and the UI never freezes; in the app I measured one remaining 244 ms main-thread task at the largest size. For security, the renderer has no Node access (context isolation, sandbox, strict CSP, no network), the preload exposes only five functions, files open through the native dialog with size and type checks in the main process, external links must be https and on an allowlist, and a custom `app://` protocol rejects path traversal. I tested these in end-to-end tests, including that a full click-through makes no network request.

10. **Tradeoffs and limitations I'd mention up front.**
    Distance methods are quick approximations; research uses maximum likelihood or Bayesian programs. My progressive aligner is a heuristic: on tiny 3-sequence cases it reached the exhaustive optimum 61 % of the time (never above), and results can change slightly with input order. Trees from pairwise-alignment distances are less reliable than trees from a good multiple alignment. Installers are unsigned. The matrix files have no explicit license text, which I documented rather than assumed. And I did not run Windows or Linux builds locally; those are verified only by CI.
