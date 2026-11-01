import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'
const root = fileURLToPath(new URL('../../../../../', import.meta.url))

describe('model capability development lifecycle', () => {
  it('reads automatically after StrictMode cancels and replays mount effects and keeps locale changes read-only', async () => {
    const bundle = await build({ absWorkingDir: root, stdin: { sourcefile: 'model-capability-lifecycle.tsx', resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'tsx', contents: `
      import { StrictMode, useRef, useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import { setLocale } from '@eating/ui-sdk'
      import './i18n'
      import { ModelCapabilitiesSettings } from './ModelCapabilities'
      setLocale('zh-CN')
      function Harness() {
        const actionLock = useRef(false), [busy, setBusy] = useState(false)
        const [active, setActive] = useState(true)
        window.capabilityHarness = { setLocale, setActive }
        return <div data-busy={busy}><ModelCapabilitiesSettings active={active} enabled configured runtimeActive={false} busy={false} actionLock={actionLock} onBusy={setBusy} routeKey="fixture" catalogKey="fixture-model" savedModel="fixture" draftModel="fixture" identityMatches models={null} /></div>
      }
      createRoot(document.getElementById('root')).render(<StrictMode><Harness /></StrictMode>)
    ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' }, alias: { '@eating/plugin-sdk': `${root}/packages/plugin-sdk/src/index.ts`, '@eating/ui-sdk': `${root}/packages/ui-sdk/src/index.ts` }, define: { 'process.env.NODE_ENV': '"development"' } })
    const browser = await chromium.launch({ headless: true })
    const calls: string[] = [], errors: string[] = []
    try {
      const page = await browser.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.route('http://capability-fixture.test/**', async route => {
        const path = new URL(route.request().url()).pathname
        if (path === '/api/bootstrap') { await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ csrfToken: 'fixture-only-csrf' }) }); return }
        if (path === '/api/plugins/dsh/manage') {
          const operation = route.request().postDataJSON().operation; calls.push(operation)
          const data = operation === 'get-model-capabilities' ? { schemaVersion: 1, revision: 0, imageInput: false } : { model: 'fixture', capabilities: { imageInput: true, toolCalling: true, reasoning: null, inputModalities: ['text', 'image'], outputModalities: ['text'], contextWindow: 1000000, maxOutputTokens: 128000 }, fetchedAt: '2026-11-01T08:00:00.000Z', imageInput: true, appliedImageInput: null }
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) }); return
        }
        await route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' })
      })
      await page.goto('http://capability-fixture.test/')
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
      await page.getByText('1,000,000 token', { exact: true }).waitFor({ timeout: 10000 })
      expect(calls.filter(operation => operation === 'read-model-information')).toHaveLength(1)
      expect(await page.locator('.dsh-model-supplement').count()).toBe(0)
      const before = [...calls]
      await page.evaluate('window.capabilityHarness.setLocale("en-US")')
      await page.getByRole('heading', { name: 'Model capabilities', exact: true }).waitFor()
      expect(calls).toEqual(before)
      await page.evaluate('window.capabilityHarness.setActive(false)')
      await page.evaluate('window.capabilityHarness.setActive(true)')
      await page.getByText('1,000,000 tokens', { exact: true }).waitFor()
      expect(errors).toEqual([])
    } finally { await browser.close() }
  }, 30000)
})
