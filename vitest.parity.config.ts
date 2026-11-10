import { defineConfig } from 'vitest/config';

// Only used by `npm run parity:generate`: runs the fixture generator (tools/ts-parity/gen.test.ts), which is deliberately
// outside the normal `npm test` include list because it rewrites files under tests/fixtures/parity/.
export default defineConfig({ test: { include: ['tools/ts-parity/**/*.test.ts'], testTimeout: 120_000 } });
