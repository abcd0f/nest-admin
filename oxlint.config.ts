import { defineConfig } from 'oxlint';

export default defineConfig({
  categories: {
    correctness: 'warn',
  },
  ignorePatterns: ['**/*.md', 'dist/**'],
  rules: {
    'eslint/no-unused-vars': 'error',
  },
});
