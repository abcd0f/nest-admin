import { defineConfig } from 'oxlint';

export default defineConfig({
  categories: {
    correctness: 'warn',
  },
  ignorePatterns: ['**/*.md', '**/node_modules/**', 'dist/**'],
  rules: {
    'eslint/no-unused-vars': 'error',
  },
});
