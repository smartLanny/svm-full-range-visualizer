import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    // src/: the SVM workbench. db/ and pipeline/: the screen database (data/README.md).
    include: ['src/**/*.test.ts', 'pipeline/**/*.test.ts', 'db/**/*.test.ts'],
    environment: 'node',
  },
});
