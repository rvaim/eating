import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
interface EditorSnapshot { readonly body: string; readonly selection: unknown; readonly history: number }

const initialBody = 'Original author text {{当前时间}} {{消息内容}} {{future}}'

async function editorBundle(): Promise<string> {
  const result = await build({
    absWorkingDir: root,
    stdin: {
      sourcefile: 'template-editor-i18n-harness.tsx',
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'tsx',
      contents: `
        import { useState } from 'react'
        import { createRoot } from 'react-dom/client'
        import { EditorView } from '@codemirror/view'
        import { Transaction } from '@codemirror/state'
        import { undo, undoDepth } from '@codemirror/commands'
        import { TEMPLATE_VARIABLES } from '@eating/plugin-sdk'
        import { setLocale } from '@eating/ui-sdk'
        import { TemplateEditor } from './TemplateEditor'
        const variables = [...TEMPLATE_VARIABLES.map(variable => ({ ...variable, description: 'BACKEND_DESCRIPTION_MUST_NOT_RENDER' })),
          { name: 'future', description: 'UNSUPPORTED_VARIABLE', scopes: ['main'], origin: 'runtime' }]
        setLocale('zh-CN')
        const view = () => EditorView.findFromDOM(document.querySelector('.cm-content'))
        function Harness() {
          const [value, setValue] = useState(${JSON.stringify(initialBody)})
          const [docKey, setDocKey] = useState('first')
          window.editorHarness = {
            setLocale,
            snapshot: () => ({ body: view().state.doc.toString(), selection: view().state.selection.toJSON(), history: undoDepth(view().state) }),
            append: text => {
              const editor = view()
              editor.dispatch({ changes: { from: editor.state.doc.length, insert: text }, selection: { anchor: editor.state.doc.length + text.length }, annotations: Transaction.userEvent.of('input.type') })
            },
            undo: () => undo(view()),
            nextDocument: () => { setValue('Second document {{当前时间}}'); setDocKey('second') },
          }
          return <TemplateEditor docKey={docKey} value={value} scope="main" onChange={setValue} variables={variables} />
        }
        createRoot(document.getElementById('root')).render(<Harness />)
      `,
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    alias: {
      '@eating/plugin-sdk': `${root}/packages/plugin-sdk/src/index.ts`,
      '@eating/ui-sdk': `${root}/packages/ui-sdk/src/index.ts`,
    },
    define: { 'process.env.NODE_ENV': '"test"' },
  })
  return result.outputFiles[0]!.text
}

describe('模板编辑器语言切换', () => {
  it('实际组件保留正文、选择和撤销历史，同时更新补全与诊断且隔离跨文档撤销', async () => {
    const script = await editorBundle()
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const snapshot = () => page.evaluate<EditorSnapshot>('window.editorHarness.snapshot()')
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.setContent('<html><body><div id="root"></div></body></html>')
      await page.addScriptTag({ content: script })
      await page.getByRole('textbox', { name: '提示词内容', exact: true }).waitFor()
      await page.evaluate('window.editorHarness.append(" :: edited")')
      const before = await snapshot()
      expect(before.body).toBe(`${initialBody} :: edited`)
      expect(before.history).toBeGreaterThan(0)
      await page.evaluate('window.editorHarness.setLocale("en-US")')
      await page.getByRole('textbox', { name: 'Prompt content', exact: true }).waitFor()
      expect(await snapshot()).toEqual(before)
      expect(await page.locator('.template-editor-diagnostics').innerText()).toContain('not available in this template')
      expect(await page.locator('.template-editor-diagnostics').innerText()).toContain('Unknown variable “future”')
      expect(await page.locator('.template-editor-scope').innerText()).toContain('2 available variables')
      await page.getByRole('button', { name: 'Insert variable', exact: true }).click()
      await page.getByRole('listbox', { name: 'Available variables', exact: true }).waitFor()
      expect(await page.locator('.cm-completionDetail').allTextContents()).toContain('The current time when messages are processed.')
      expect(await page.locator('.template-editor-popups').innerText()).not.toContain('BACKEND_DESCRIPTION_MUST_NOT_RENDER')
      expect(await page.locator('.template-editor-popups').innerText()).not.toContain('UNSUPPORTED_VARIABLE')
      await page.evaluate('window.editorHarness.setLocale("zh-CN")')
      await page.getByRole('listbox', { name: '可用变量', exact: true }).waitFor()
      expect(await page.locator('.cm-completionDetail').allTextContents()).toContain('处理消息时的当前时间。')
      expect(await snapshot()).toEqual(before)
      await page.keyboard.press('Escape')
      await page.locator('.template-variable-invalid').first().hover()
      await page.locator('.cm-tooltip-lint').waitFor()
      expect(await page.locator('.cm-tooltip-lint').innerText()).toContain('不适用于当前模板')
      await page.evaluate('window.editorHarness.setLocale("en-US")')
      await page.locator('.cm-tooltip-lint').waitFor({ state: 'hidden' })
      await page.mouse.move(0, 0)
      await page.locator('.template-variable-invalid').first().hover()
      await page.locator('.cm-tooltip-lint').waitFor()
      expect(await page.locator('.cm-tooltip-lint').innerText()).toContain('not available in this template')
      expect(await snapshot()).toEqual(before)
      expect(await page.evaluate('window.editorHarness.undo()')).toBe(true)
      expect((await snapshot()).body).toBe(initialBody)
      await page.evaluate('window.editorHarness.nextDocument()')
      await page.waitForFunction('window.editorHarness.snapshot().body === "Second document {{当前时间}}"')
      expect((await snapshot()).history).toBe(0)
      expect(await page.evaluate('window.editorHarness.undo()')).toBe(false)
      expect(errors).toEqual([])
    } finally { await browser.close() }
  }, 20000)
})
