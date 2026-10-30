import { describe, expect, it } from 'vitest'
import { readModelCapabilities, readModels, readModelTest, readNativeWebLaunch, readNativeWebStatus } from './panel-data'

describe('Harness 面板响应校验', () => {

  it('独立能力必须已经读取完整当前版本，不用 false 补造失败读取', () => {
    expect(readModelCapabilities({ schemaVersion: 1, revision: 0, imageInput: false })).toEqual({ schemaVersion: 1, revision: 0, imageInput: false })
    for (const value of [{}, { schemaVersion: 1, revision: 1 }, { schemaVersion: 1, revision: -1, imageInput: false }, { schemaVersion: 1, revision: 1.5, imageInput: true }, { schemaVersion: 1, revision: 1, imageInput: 'false' }, { schemaVersion: 1, revision: 1, imageInput: true, apiKey: 'fixture' }]) expect(() => readModelCapabilities(value)).toThrow()
  })

  it('保留模型原始 ID，只接收声明字段并核对所测试的模型', () => {
    expect(readModels({ models: [{ id: 'provider/原模型', name: 'Owner name', apiKey: 'fixture-secret' }] })).toEqual([{ id: 'provider/原模型', name: 'Owner name' }])
    expect(readModelTest({ ok: true, model: 'provider/原模型', latencyMs: 45, output: 'private' }, 'provider/原模型')).toEqual({ ok: true, model: 'provider/原模型', latencyMs: 45 })
    expect(() => readModelTest({ ok: true, model: 'other', latencyMs: 45 }, 'expected')).toThrowError(expect.objectContaining({ code: 'INVALID_HOST_RESPONSE' }))
    expect(() => readModels({ models: [{ id: 'duplicate' }, { id: 'duplicate' }] })).toThrow()
    expect(() => readModels({ models: Array.from({ length: 2001 }, (_, index) => ({ id: String(index) })) })).toThrow()
  })

  it('原生 Web 就绪状态只接受严格 ready 布尔，不在状态里携带入口地址', () => {
    expect(readNativeWebStatus({ ready: true })).toEqual({ ready: true })
    expect(readNativeWebStatus({ ready: false })).toEqual({ ready: false })
    for (const value of [{}, { ready: 'true' }, { ready: 1 }, { ready: true, url: 'http://127.0.0.1:4318/' }, { ready: true, rootSessionId: 'main' }]) expect(() => readNativeWebStatus(value)).toThrowError(expect.objectContaining({ code: 'INVALID_HOST_RESPONSE' }))
  })

  it('原生 Web 入口只接受回环官方地址与严格字段，拒绝外部、脚本与额外鉴权字段', () => {
    const good = 'http://127.0.0.1:4318/session?token=fixture-only'
    expect(readNativeWebLaunch({ url: good, rootSessionId: 'main' })).toEqual({ url: good, rootSessionId: 'main' })
    for (const value of [
      {}, { url: good }, { url: good, rootSessionId: '' }, { url: good, rootSessionId: 'x'.repeat(161) },
      { url: 'https://127.0.0.1:4318/', rootSessionId: 'main' },
      { url: 'http://localhost:4318/', rootSessionId: 'main' },
      { url: 'http://127.0.0.1:65536/', rootSessionId: 'main' },
      { url: 'http://127.0.0.1:0/', rootSessionId: 'main' },
      { url: 'javascript:alert(1)', rootSessionId: 'main' },
      { url: good, rootSessionId: 'main', token: 'fixture-only' },
      { url: good, rootSessionId: 'main', readOnly: false },
      { url: `${good} extra`, rootSessionId: 'main' },
    ]) expect(() => readNativeWebLaunch(value)).toThrowError(expect.objectContaining({ code: 'INVALID_HOST_RESPONSE' }))
  })
})
