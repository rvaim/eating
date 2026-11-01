import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { reportedModelCapabilities } from '../model-information'
import { DshModelInformationFile } from './model-information'
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) { if (realpathSync(directory) !== directory || dirname(directory) !== realpathSync(tmpdir()) || !basename(directory).startsWith('eating-model-information-')) throw new Error('Unsafe fixture cleanup'); rmSync(directory, { recursive: true }) } })
function fixture() { const directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'eating-model-information-'))); directories.push(directory); return new DshModelInformationFile(directory) }
const identity = { endpoint: 'https://fixture.invalid/v1', apiKey: 'fixture-private-catalog-key', model: 'fixture-model' }

describe('provider model capability metadata', () => {
  it('reads explicit modalities and supported parameters without any model-name heuristics', () => {
    expect(reportedModelCapabilities({ id: 'arbitrary', modalities: { input: ['text', 'image'], output: ['text'] }, tool_call: true, reasoning: true, context_length: 1000000, context_window: 1000000, max_output_tokens: 128000, supported_parameters: ['tools', 'reasoning'] })).toEqual({ imageInput: true, toolCalling: true, reasoning: true, inputModalities: ['text', 'image'], outputModalities: ['text'], contextWindow: 1000000, maxOutputTokens: 128000 })
    expect(reportedModelCapabilities({ id: 'vision-super-reasoning-image' })).toBeUndefined()
  })
  it('preserves explicit false and marks contradictory or malformed declarations unknown', () => {
    const value = reportedModelCapabilities({ modalities: { input: ['text'] }, supports_vision: true, tool_call: false, reasoning: false, context_window: 1000, context_length: 2000, max_output_tokens: -1 })!
    expect(value.imageInput).toBeNull(); expect(value.contextWindow).toBeNull(); expect(value.maxOutputTokens).toBeNull()
    expect(value.toolCalling).toBe(false); expect(value.reasoning).toBe(false)
    expect(reportedModelCapabilities({ input: ['unrecognized-secret-token'], context_length: '1000000', tool_call: 'true' })).toBeUndefined()
  })
  it('binds stored facts to provider credentials and exact model, without writing secrets', () => {
    const file = fixture(), capabilities = reportedModelCapabilities({ modalities: { input: ['text', 'image'] } })!
    file.save(identity, [{ id: identity.model, capabilities }])
    expect(file.selected(identity).model?.capabilities?.imageInput).toBe(true)
    expect(file.selected({ ...identity, model: 'other-model' }).model).toBeNull()
    expect(file.selected({ ...identity, apiKey: 'other-private-key' }).model).toBeNull()
    expect(file.selected({ ...identity, endpoint: 'https://other.invalid/v1' }).model).toBeNull()
    expect(readFileSync(file.filePath, 'utf8')).not.toContain(identity.apiKey)
  })
  it('rejects a damaged cache without overwriting it or inferring omitted fields', () => {
    const file = fixture(), original = '{"schemaVersion":0,"models":[]}'
    writeFileSync(file.filePath, original)
    expect(() => file.selected(identity)).toThrow(expect.objectContaining({ code: 'MODEL_INFORMATION_CORRUPTED' }))
    expect(() => file.save(identity, [])).toThrow()
    expect(readFileSync(file.filePath, 'utf8')).toBe(original)
  })
})
