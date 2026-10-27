import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Annotation, Compartment, EditorSelection, EditorState, Facet, Prec, RangeSetBuilder, StateField, Transaction } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, drawSelection, keymap, lineNumbers, tooltips } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { acceptCompletion, autocompletion, closeCompletion, completionKeymap, completionStatus, pickedCompletion, startCompletion } from '@codemirror/autocomplete'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands'
import { linter, setDiagnostics } from '@codemirror/lint'
import { MAX_TEMPLATE_BODY_LENGTH, TEMPLATE_VARIABLES, analyzeTemplate } from '@eating/plugin-sdk'
import type { TemplateScope, TemplateVariable } from '@eating/plugin-sdk'
import { formatNumber, translate, useI18n } from '@eating/ui-sdk'
import type { Locale } from '@eating/ui-sdk'
import { variableDescriptionKeys } from '../i18n/authoring'
import './TemplateEditor.css'

export interface TemplateEditorProps {
  readonly docKey: string
  readonly scope: TemplateScope
  readonly value: string
  readonly onChange: (value: string) => void
  readonly disabled?: boolean
  readonly ariaLabel?: string
  readonly variables?: readonly TemplateVariable[]
}

type TemplateAnalysis = ReturnType<typeof analyzeTemplate>
type TemplateDiagnostic = TemplateAnalysis['diagnostics'][number]
interface TemplateConfiguration {
  readonly scope: TemplateScope
  readonly variables: readonly TemplateVariable[]
  readonly ariaLabel: string
  readonly locale: Locale
}
interface Inspection {
  readonly analysis: TemplateAnalysis
  readonly decorations: DecorationSet
}
interface MountedEditor {
  readonly view: EditorView
  readonly configuration: Compartment
  readonly createState: () => EditorState
  docKey: string
  scope: TemplateScope
  variables: readonly TemplateVariable[]
  disabled: boolean
  ariaLabel: string
  locale: Locale
}

const externalChange = Annotation.define<boolean>()
const templateConfiguration = Facet.define<TemplateConfiguration, TemplateConfiguration>({
  combine: values => values[0]!,
})
const validVariable = Decoration.mark({ class: 'template-variable template-variable-valid' })
const invalidVariable = Decoration.mark({ class: 'template-variable template-variable-invalid' })
const editorText = (key: string, params?: Record<string, string | number | boolean | null | undefined>) => translate('authoring', key, params)
const visibleDiagnosticLimit = 8

function inspect(state: EditorState): Inspection {
  const analysis = analyzeTemplate(state.doc.toString(), state.facet(templateConfiguration).scope)
  const builder = new RangeSetBuilder<Decoration>()
  for (const token of analysis.tokens) {
    if (token.to > token.from) builder.add(token.from, token.to, token.valid ? validVariable : invalidVariable)
  }
  return { analysis, decorations: builder.finish() }
}

const inspection = StateField.define<Inspection>({
  create: inspect,
  update: (previous, transaction) => transaction.docChanged
    || transaction.startState.facet(templateConfiguration) !== transaction.state.facet(templateConfiguration)
    ? inspect(transaction.state) : previous,
  provide: field => EditorView.decorations.from(field, value => value.decorations),
})

function diagnosticMessage(diagnostic: TemplateDiagnostic, docLength: number, name = ''): string {
  if (docLength > MAX_TEMPLATE_BODY_LENGTH) return editorText('error.bodyLength', { limit: formatNumber(MAX_TEMPLATE_BODY_LENGTH) })
  return editorText(`editor.diagnostic.${diagnostic.code}`, { name })
}

function lintDiagnostics(state: EditorState) {
  const { analysis } = state.field(inspection)
  const names = new Map(analysis.tokens.map(token => [token.from, token.name]))
  return analysis.diagnostics.map(diagnostic => ({
    from: diagnostic.from,
    to: diagnostic.to,
    severity: 'error' as const,
    source: editorText('editor.source'),
    message: diagnosticMessage(diagnostic, state.doc.length, names.get(diagnostic.from)),
  }))
}

/** This only locates a completion replacement; the public SDK decides validity. */
function completionRange(state: EditorState, pos: number) {
  const tokens = state.field(inspection).analysis.tokens
  let low = 0
  let high = tokens.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (tokens[middle]!.from < pos) low = middle + 1
    else high = middle
  }
  const token = tokens[low - 1]
  if (!token || pos < token.from + 2 || pos > (token.closed ? token.to - 2 : token.to)) return null
  const from = token.from + 2
  if (/[{}\s]/u.test(state.sliceDoc(from, pos))) return null
  // A closed token is replaced in full, even when the caret is in its name.
  // An unfinished marker must leave any following ordinary prose intact.
  let to = token.to
  if (!token.closed) {
    const tail = /^[^{}\s]*/u.exec(state.sliceDoc(pos, token.to))![0]
    to = pos + tail.length
    if (state.sliceDoc(to, to + 2) === '}}') to += 2
    else if (state.sliceDoc(to, to + 1) === '}') to += 1
  }
  return { markerFrom: token.from, from, to }
}

function availableVariables(scope: TemplateScope, variables: readonly TemplateVariable[]) {
  // Supplied catalog descriptions can change; unsupported names cannot become
  // valid variables merely by arriving in a catalog prop.
  const supported = new Set(TEMPLATE_VARIABLES.filter(variable => variable.scopes.includes(scope)).map(variable => variable.name))
  const names = new Set<string>()
  return variables.filter(variable => {
    if (!variable.scopes.includes(scope) || !supported.has(variable.name) || names.has(variable.name)) return false
    names.add(variable.name)
    return true
  })
}

function applyVariable(view: EditorView, completion: Completion, from: number, to: number) {
  if (view.state.readOnly || view.composing || view.compositionStarted) return
  const range = completionRange(view.state, view.state.selection.main.head)
  const insert = `{{${completion.label}}}`
  const replacementFrom = range?.markerFrom ?? from
  const replacementTo = range?.to ?? to
  view.dispatch({
    changes: { from: replacementFrom, to: replacementTo, insert },
    selection: EditorSelection.cursor(replacementFrom + insert.length),
    annotations: [pickedCompletion.of(completion), Transaction.userEvent.of('input.complete'), isolateHistory.of('full')],
    scrollIntoView: true,
  })
  view.focus()
}

function completionSource(variables: readonly TemplateVariable[]) {
  const options: readonly Completion[] = variables.map(variable => ({
    label: variable.name,
    displayLabel: `{{${variable.name}}}`,
    detail: editorText(variableDescriptionKeys[variable.name] ?? 'variable.unknown'),
    type: 'variable',
    apply: applyVariable,
  }))
  return (context: CompletionContext): CompletionResult | null => {
    if (context.state.readOnly || context.view?.composing || context.view?.compositionStarted || !options.length) return null
    const range = completionRange(context.state, context.pos)
    if (range) return {
      from: range.from,
      to: context.pos,
      options,
      validFor: /^[^{}\s]*$/u,
    }
    if (!context.explicit) return null
    const selection = context.state.selection.main
    return { from: selection.from, to: selection.to, options, filter: false }
  }
}

const resumeAfterComposition = ViewPlugin.fromClass(class {
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(readonly view: EditorView) {}
  resume() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      const view = this.view
      if (view.hasFocus && !view.state.readOnly && !view.composing && !view.compositionStarted
        && completionRange(view.state, view.state.selection.main.head)) startCompletion(view)
    }, 30)
  }
  destroy() { clearTimeout(this.timer) }
}, {
  eventObservers: { compositionend() { this.resume() } },
})

function configurationExtensions(props: TemplateEditorProps & { readonly locale: Locale }): Extension {
  const variables = props.variables ?? TEMPLATE_VARIABLES
  return [
    templateConfiguration.of({ scope: props.scope, variables, ariaLabel: props.ariaLabel ?? editorText('body.prompt'), locale: props.locale }),
    EditorState.readOnly.of(Boolean(props.disabled)),
    EditorView.editable.of(!props.disabled),
    autocompletion({
      override: [completionSource(availableVariables(props.scope, variables))],
      activateOnTyping: true,
      activateOnTypingDelay: 60,
      defaultKeymap: false,
      selectOnOpen: true,
      interactionDelay: 0,
      icons: false,
      tooltipClass: () => 'template-editor-completion',
      optionClass: () => 'template-editor-completion-option',
      filterStrict: true,
    }),
    EditorState.phrases.of({
      Completions: editorText('editor.phrase.completions'),
      Diagnostics: editorText('editor.phrase.diagnostics'),
      'No diagnostics': editorText('editor.noErrors'),
      close: editorText('editor.phrase.close'),
    }),
    linter(view => lintDiagnostics(view.state), {
      delay: 120,
      needsRefresh: update => update.startState.facet(templateConfiguration) !== update.state.facet(templateConfiguration),
    }),
  ]
}

export function TemplateEditor(props: TemplateEditorProps) {
  const { locale, t, formatNumber } = useI18n('authoring')
  const { docKey, scope, value, disabled = false, variables = TEMPLATE_VARIABLES } = props
  const ariaLabel = props.ariaLabel ?? t('body.prompt')
  const host = useRef<HTMLDivElement>(null)
  const mounted = useRef<MountedEditor | null>(null)
  const latest = useRef({ ...props, ariaLabel, locale })
  latest.current = { ...props, ariaLabel, locale }
  const editorId = useId()
  const hintId = useId()
  const diagnosticsId = useId()
  const [analysis, setAnalysis] = useState(() => analyzeTemplate(value, scope))
  const catalog = availableVariables(scope, variables)
  const names = new Map(analysis.tokens.map(token => [token.from, token.name]))

  useLayoutEffect(() => {
    if (!host.current) return
    const popupParent = document.createElement('div')
    popupParent.className = 'template-editor-popups'
    document.body.appendChild(popupParent)
    const configuration = new Compartment()
    const createState = () => EditorState.create({
      doc: latest.current.value,
      extensions: [
        configuration.of(configurationExtensions(latest.current)),
        inspection,
        history(),
        lineNumbers(),
        drawSelection(),
        EditorView.lineWrapping,
        tooltips({ parent: popupParent, position: 'fixed' }),
        resumeAfterComposition,
        // Native editing commands respect readOnly. This also protects against
        // accidental document dispatches from a disabled toolbar or completion.
        EditorState.changeFilter.of(transaction => !transaction.startState.readOnly || transaction.annotation(externalChange) === true),
        Prec.highest(keymap.of([
          ...completionKeymap.map(binding => ({
            ...binding,
            run: (view: EditorView) => !view.composing && !view.compositionStarted && (binding.run?.(view) ?? false),
          })),
          { key: 'Tab', run: view => !view.composing && !view.compositionStarted && acceptCompletion(view) },
        ])),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.contentAttributes.of(view => ({
          id: editorId,
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': view.state.facet(templateConfiguration).ariaLabel,
          'aria-readonly': String(view.state.readOnly),
          'aria-disabled': String(view.state.readOnly),
          'aria-invalid': String(!view.state.field(inspection).analysis.valid),
          'aria-describedby': `${hintId} ${diagnosticsId}`,
          'aria-errormessage': view.state.field(inspection).analysis.valid ? '' : diagnosticsId,
          tabindex: '0',
          spellcheck: 'false',
        })),
        EditorView.updateListener.of(update => {
          const next = update.state.field(inspection).analysis
          if (next !== update.startState.field(inspection).analysis) setAnalysis(next)
          if (update.docChanged && update.transactions.some(transaction => transaction.docChanged && !transaction.annotation(externalChange))) {
            latest.current.onChange(update.state.doc.toString())
          }
        }),
      ],
    })
    const view = new EditorView({ state: createState(), parent: host.current })
    mounted.current = { view, configuration, createState, docKey: latest.current.docKey, scope: latest.current.scope,
      variables: latest.current.variables ?? TEMPLATE_VARIABLES, disabled: Boolean(latest.current.disabled), ariaLabel: latest.current.ariaLabel, locale: latest.current.locale }
    setAnalysis(view.state.field(inspection).analysis)
    return () => {
      mounted.current = null
      view.destroy()
      popupParent.remove()
    }
  }, [editorId, hintId, diagnosticsId])

  useLayoutEffect(() => {
    const editor = mounted.current
    if (!editor) return
    const { view } = editor
    if (editor.docKey !== docKey) {
      // Reuse the view, but a new state owns its own selection, history, and
      // tooltip lifecycle. Undo can never restore another document's text.
      view.setState(editor.createState())
      editor.docKey = docKey
      setAnalysis(view.state.field(inspection).analysis)
    } else {
      const localeChanged = editor.locale !== locale
      if (editor.scope !== scope || editor.variables !== variables || editor.disabled !== disabled || editor.ariaLabel !== ariaLabel || localeChanged) {
        const reopenCompletion = localeChanged && completionStatus(view.state) !== null
        closeCompletion(view)
        view.dispatch({ effects: editor.configuration.reconfigure(configurationExtensions(latest.current)) })
        if (localeChanged) {
          // Refresh diagnostics immediately, including any open lint tooltip.
          // Reconfiguration leaves the document, selection, and undo history intact.
          view.dispatch(setDiagnostics(view.state, lintDiagnostics(view.state)))
          if (reopenCompletion && view.hasFocus && !disabled && !view.composing && !view.compositionStarted) startCompletion(view)
        }
      }
      if (view.state.doc.toString() !== value) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: value },
          annotations: [externalChange.of(true), Transaction.addToHistory.of(false)],
        })
      }
    }
    editor.scope = scope
    editor.variables = variables
    editor.disabled = disabled
    editor.ariaLabel = ariaLabel
    editor.locale = locale
  }, [docKey, scope, variables, disabled, ariaLabel, value, locale])

  const insertVariable = () => {
    const view = mounted.current?.view
    if (!view || latest.current.disabled || view.state.readOnly || view.composing || view.compositionStarted) return
    view.focus()
    startCompletion(view)
  }
  const locateDiagnostic = (diagnostic: TemplateDiagnostic) => {
    const view = mounted.current?.view
    if (!view) return
    view.dispatch({ selection: EditorSelection.range(Math.min(diagnostic.from, view.state.doc.length), Math.min(diagnostic.to, view.state.doc.length)), scrollIntoView: true })
    view.focus()
  }

  return (
    <div className={`template-editor${disabled ? ' is-disabled' : ''}${analysis.valid ? '' : ' has-errors'}`}>
      <div className="template-editor-toolbar">
        <button type="button" className="button button-secondary template-editor-insert" disabled={disabled || !catalog.length}
          aria-controls={editorId} aria-haspopup="listbox" onMouseDown={event => event.preventDefault()} onClick={insertVariable}>
          {t('editor.insert')}
        </button>
        <span className="template-editor-scope">{t('editor.scopeCount', { scope: t(`scope.${scope}`), count: catalog.length, formattedCount: formatNumber(catalog.length) })}</span>
      </div>
      <div ref={host} className="template-editor-host" />
      <p id={hintId} className="template-editor-hint">{t('editor.hint', { opening: '{{' })}</p>
      <div id={diagnosticsId} className="template-editor-diagnostics" aria-label={t('editor.diagnosticsLabel')}>
        <p className="template-editor-diagnostic-count" role="status">
          {analysis.valid ? t('editor.noErrors') : t('editor.errorCount', { count: analysis.diagnostics.length, formattedCount: formatNumber(analysis.diagnostics.length) })}
        </p>
        {analysis.diagnostics.length > 0 && (
          <ul className="template-editor-error-list" aria-label={t('editor.errorList')}>
            {analysis.diagnostics.slice(0, visibleDiagnosticLimit).map((diagnostic, index) => (
              <li key={`${diagnostic.from}:${diagnostic.to}:${diagnostic.code}`}>
                <button type="button" onClick={() => locateDiagnostic(diagnostic)} aria-label={t('editor.locateError', { number: formatNumber(index + 1), message: diagnosticMessage(diagnostic, value.length, names.get(diagnostic.from)) })}>
                  {t('editor.errorItem', { number: formatNumber(index + 1), message: diagnosticMessage(diagnostic, value.length, names.get(diagnostic.from)) })}
                </button>
              </li>
            ))}
          </ul>
        )}
        {analysis.diagnostics.length > visibleDiagnosticLimit && <p className="template-editor-more-errors">{t('editor.moreErrors', { limit: formatNumber(visibleDiagnosticLimit) })}</p>}
      </div>
    </div>
  )
}
