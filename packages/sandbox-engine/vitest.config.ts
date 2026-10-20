import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60000, // Container execution and compilation need sufficient test timeout
    globals: true,
  },
});
