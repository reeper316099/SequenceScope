## What and why

## Checklist
- [ ] `npm run lint` and `npm run typecheck` pass
- [ ] `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --all -- --check` pass (new algorithm code has tests)
- [ ] `npm test` passes, and `npm run test:bridge` passes if the UI changed
- [ ] No new network access, no new dependencies for bioinformatics
- [ ] New results in the UI include an honest-science note
