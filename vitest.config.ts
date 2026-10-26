import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@eating/plugin-core': fileURLToPath(new URL('./packages/plugin-core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/web/src/**/*.test.ts'],
    environment: 'node',
  },
})
