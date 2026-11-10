// ESLint flat config: strict-ish TypeScript rules required by the project brief.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**', 'tools/.pylibs/**', 'coverage/**', 'target/**', 'src-tauri/**', 'tools/**', 'eslint.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.renderer.json', './tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // Reproducibility rule: all randomness must come from the seeded PRNG in src/bio/rng.ts.
      'no-restricted-properties': ['error', { object: 'Math', property: 'random', message: 'Use the seeded PRNG (src/bio/rng.ts).' }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
    },
  },
);
