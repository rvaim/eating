import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      '@eating/plugin-core': fileURLToPath(new URL('../../packages/plugin-core/src/index.ts', import.meta.url)),
      '@eating/plugin-sdk': fileURLToPath(new URL('../../packages/plugin-sdk/src/index.ts', import.meta.url)),
      '@eating/ui-sdk': fileURLToPath(new URL('../../packages/ui-sdk/src/index.ts', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.EATING_HOST_PORT ?? '5181'}` },
      '/plugins': { target: `http://127.0.0.1:${process.env.EATING_HOST_PORT ?? '5181'}` },
      '/_eating/runtime': { target: `http://127.0.0.1:${process.env.EATING_HOST_PORT ?? '5181'}` },
    },
    fs: { allow: [repositoryRoot] },
  },
  preview: { host: '127.0.0.1', port: 4180, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL('../../dist', import.meta.url)),
    emptyOutDir: true,
  },
})
