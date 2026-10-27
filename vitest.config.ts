import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@eating/plugin-core': fileURLToPath(new URL('./packages/plugin-core/src/index.ts', import.meta.url)),
      '@eating/plugin-sdk': fileURLToPath(new URL('./packages/plugin-sdk/src/index.ts', import.meta.url)),
      '@eating/ui-sdk': fileURLToPath(new URL('./packages/ui-sdk/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'plugins/**/*.test.ts'],
    environment: 'node',
  },
})
