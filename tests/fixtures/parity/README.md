# Frozen TypeScript reference outputs

These JSON files are what the original TypeScript implementation (SequenceScope v0.1.0, the Electron app) produced for seeded and
hand-picked inputs: alignments, tables, distances, trees, Newick, MSA, shuffles, bootstrap, conservation, FASTA, matrices, number
formatting. The Rust tests in `crates/sequencescope-core/tests/ts_parity*.rs` replay the same inputs and require **exactly** the same
outputs (floating-point values are compared bit for bit, except logarithm-derived values, see `docs/rust-migration/CHECKPOINT-4.md`).

The TypeScript implementation and the generators that wrote these files were removed from the main line in Checkpoint 6c. They live at
the signed tag `ts-reference-v0.1.0`. To regenerate the files (for example after adding a case):

```bash
git worktree add ../sequencescope-ts-reference ts-reference-v0.1.0
cd ../sequencescope-ts-reference
npm ci
npm run parity:generate   # rewrites tests/fixtures/parity/*.json in that worktree
```

then copy the changed JSON files back and extend the Rust test that reads them. Do not edit these files by hand.
