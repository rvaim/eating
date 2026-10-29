import { describe, expect, it } from 'vitest'
import type { JsonValue, PluginToolDefinition } from '@eating/plugin-sdk'
import { toolResult } from './tool-results'

const image = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString('base64')
const definition = (resultFormat: 'json' | 'content'): PluginToolDefinition => ({ name: 'test', title: 'test', description: 'test', readOnly: true, destructive: false, resultFormat, inputSchema: { type: 'object' } })
describe('explicit MCP content results', () => {
  it('preserves ordered text and image blocks without duplicating binary metadata', () => {
    const result = toolResult(definition('content'), { content: [{ type: 'text', text: 'before' }, { type: 'image', mimeType: 'image/png', data: image }, { type: 'text', text: 'after' }], structuredContent: { bytes: 12 } }, 'request')
    expect(result.content).toEqual([{ type: 'text', text: 'before' }, { type: 'image', mimeType: 'image/png', data: image }, { type: 'text', text: 'after' }])
    expect(result.structuredContent).toEqual({ bytes: 12, request_id: 'request' })
    expect(JSON.stringify(result.structuredContent)).not.toContain(image)
  })
  it('does not promote an ordinary JSON response merely because it resembles MCP', () => {
    const value = { content: [{ type: 'image', mimeType: 'image/png', data: image }] }
    expect(toolResult(definition('json'), value, 'r').content).toEqual([{ type: 'text', text: JSON.stringify(value) }])
  })
  it.each([
    null, {}, { content: [] }, { content: [{ type: 'resource_link', uri: 'file:///private' }] },
    { content: [{ type: 'image', mimeType: 'image/svg+xml', data: image }] },
    { content: [{ type: 'image', mimeType: 'image/jpeg', data: image }] },
    { content: [{ type: 'image', mimeType: 'image/png', data: image + '\n' }] },
    { content: [{ type: 'image', mimeType: 'image/png', data: 'c2VjcmV0' }] },
    { content: [{ type: 'text', text: 'x', extra: true }] },
    { content: [{ type: 'text', text: 'x' }], structuredContent: [] },
    { content: [{ type: 'text', text: 'x' }], arbitrary: true },
  ] as JsonValue[])('rejects malformed or undeclared content without reflecting payloads', value => {
    expect(() => toolResult(definition('content'), value, 'r')).toThrow('工具返回的内容格式无效或超过允许大小。')
  })
  it('rejects an image above the decoding budget before accepting the MCP result', () => {
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 1)
    Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes)
    expect(() => toolResult(definition('content'), { content: [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }] }, 'r')).toThrow()
  })
  it('keeps a malformed post-action result unknown rather than claiming it was not sent', () => {
    try { toolResult({ ...definition('content'), readOnly: false }, { content: [] }, 'r'); throw new Error('Expected refusal') }
    catch (error) { expect(error).toMatchObject({ code: 'INVALID_TOOL_RESULT', outcome: 'unknown' }) }
  })
  it('refuses absent result metadata instead of defaulting to an old format', () => {
    const tool = { ...definition('json'), resultFormat: undefined } as unknown as PluginToolDefinition
    expect(() => toolResult(tool, {}, 'r')).toThrow('工具未声明当前支持的结果格式。')
  })
})
