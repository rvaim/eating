export type ReportedModelCapabilities = {
  readonly imageInput: boolean | null
  readonly toolCalling: boolean | null
  readonly reasoning: boolean | null
  readonly inputModalities: string[] | null
  readonly outputModalities: string[] | null
  readonly contextWindow: number | null
  readonly maxOutputTokens: number | null
}
export interface ModelInformation { readonly id: string; readonly name?: string; readonly capabilities?: ReportedModelCapabilities }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const modalities = (value: unknown): string[] | null => Array.isArray(value) && value.length > 0 && value.length <= 4 && value.every(entry => typeof entry === 'string' && ['text', 'image', 'audio', 'video'].includes(entry)) && new Set(value).size === value.length ? [...value] : null
const boolean = (value: unknown) => typeof value === 'boolean' ? value : null
const positive = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000 ? value : null
function consensus<T>(values: readonly (T | null)[]): T | null { const known = values.filter(value => value !== null); return known.length && known.every(value => JSON.stringify(value) === JSON.stringify(known[0])) ? known[0]! : null }

/** Provider metadata only. No model-name heuristics and no execution probe. */
export function reportedModelCapabilities(entry: Record<string, unknown>): ReportedModelCapabilities | undefined {
  const modal = object(entry.modalities) ? entry.modalities : {}, architecture = object(entry.architecture) ? entry.architecture : {}, capabilities = object(entry.capabilities) ? entry.capabilities : {}
  const input = consensus([modalities(modal.input), modalities(architecture.input_modalities), modalities(entry.input_modalities), modalities(entry.input)])
  const output = consensus([modalities(modal.output), modalities(architecture.output_modalities), modalities(entry.output_modalities)])
  const parameters = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : []
  const result: ReportedModelCapabilities = {
    imageInput: consensus([input ? input.includes('image') : null, boolean(entry.supports_vision), boolean(entry.supports_image_input), boolean(capabilities.vision), boolean(capabilities.image_input)]),
    toolCalling: consensus([boolean(entry.tool_call), boolean(entry.supports_tool_calls), boolean(capabilities.tool_calling), parameters.includes('tools') ? true : null]),
    reasoning: consensus([boolean(entry.reasoning), boolean(capabilities.reasoning), parameters.includes('reasoning') ? true : null]),
    inputModalities: input, outputModalities: output,
    contextWindow: consensus([positive(entry.context_window), positive(entry.context_length)]),
    maxOutputTokens: positive(entry.max_output_tokens),
  }
  return Object.values(result).some(value => value !== null) ? result : undefined
}
export function validReportedCapabilities(value: unknown): value is ReportedModelCapabilities {
  if (!object(value) || Object.keys(value).length !== 7 || ['imageInput', 'toolCalling', 'reasoning'].some(key => value[key] !== null && typeof value[key] !== 'boolean')) return false
  if (['inputModalities', 'outputModalities'].some(key => value[key] !== null && modalities(value[key]) === null)) return false
  return ['contextWindow', 'maxOutputTokens'].every(key => value[key] === null || positive(value[key]) !== null)
}
