# Contributing to SequenceScope

Thanks for helping. SequenceScope is a teaching tool, so correctness and clarity matter more than features.

## Ground rules
- **Every algorithm is written from scratch** in `src/bio/`. Please don't add bioinformatics libraries.
- **Never invent data.** Example sequences are downloaded by accession, checksummed and licensed (see [DATA-SOURCES.md](DATA-SOURCES.md)). A new example needs an accession, a checksum and a license.
- **No network at runtime.** The app must make zero outbound requests; the e2e suite checks this.
- **Randomness is seeded.** Use the PRNG in `src/bio/rng.ts`, never `Math.random()`.
- **Explain what a number does not mean.** New results in the UI need an honest-science note like the existing ones.
- Strict TypeScript, typed errors (`BioError`), and the Electron security settings in `electron/main.ts` stay as they are.

## Setup
Node ≥ 22.13 and npm.

```bash
npm ci
npm run dev
```

## Before you open a pull request
```bash
npm run lint
npm run typecheck
npm test            # unit + property tests
npm run test:e2e    # builds, then drives the real Electron app
```
CI runs the same checks on Ubuntu. New algorithm code needs tests: a hand-checkable case, a property test, and (where a reference exists) a comparison with Biopython or SciPy. See [ALGORITHMS.md](ALGORITHMS.md) for conventions such as the gap-cost formula and tie order.

## Good places to start
Look for issues labelled [`good first issue`](https://github.com/reeper316099/SequenceScope/labels/good%20first%20issue) or [`help wanted`](https://github.com/reeper316099/SequenceScope/labels/help%20wanted). If you want to work on something bigger, open an issue first so we can agree on the approach.

## Bugs and questions
- Bugs and feature requests: use the issue templates.
- Questions and ideas: use [Discussions](https://github.com/reeper316099/SequenceScope/discussions).
- Security problems: please don't open a public issue; use GitHub's "Report a vulnerability" button on the Security tab.

By contributing you agree that your contribution is released under the MIT license.
