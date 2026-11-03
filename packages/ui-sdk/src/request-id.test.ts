import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequestId } from './request-id'

const secureCrypto = globalThis.crypto
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('secure frontend request IDs', () => {
  it('exports the helper through the public UI SDK', async () => {
    expect((await import('./index')).createRequestId).toBe(createRequestId)
  })

  it('requests a fresh 16-byte Uint8Array from the real cryptographic source each time', () => {
    const getRandomValues = vi.spyOn(secureCrypto, 'getRandomValues')
    const first = createRequestId(), second = createRequestId()
    expect(first).toHaveLength(36)
    expect(second).toHaveLength(36)
    expect(first).toMatch(uuidV4)
    expect(second).toMatch(uuidV4)
    expect(getRandomValues).toHaveBeenCalledTimes(2)
    const buffers = getRandomValues.mock.calls.map(([buffer]) => buffer)
    for (const buffer of buffers) {
      expect(buffer).toBeInstanceOf(Uint8Array)
      expect(buffer?.byteLength).toBe(16)
    }
    expect(buffers[0]).not.toBe(buffers[1])
    expect(getRandomValues.mock.contexts).toEqual([secureCrypto, secureCrypto])
  })

  it('sets the version and variant bits while preserving all other 122 random bits', () => {
    const source = new Uint8Array(16)
    const getRandomValues = vi.fn((bytes: Uint8Array) => { bytes.set(source); return bytes })
    vi.stubGlobal('crypto', { getRandomValues })
    for (let value = 0; value < 256; value++) {
      source.set(Array.from({ length: 16 }, (_, index) => (value + index) & 0xff))
      const id = createRequestId()
      expect(id).toHaveLength(36)
      expect(id).toMatch(uuidV4)
      const decoded = Uint8Array.from(id.replaceAll('-', '').match(/../g)!, hex => Number.parseInt(hex, 16))
      expect(decoded).toHaveLength(16)
      expect(decoded[6]! >>> 4).toBe(4)
      expect(decoded[8]! >>> 6).toBe(2)
      for (let index = 0; index < 16; index++) {
        const randomMask = index === 6 ? 0x0f : index === 8 ? 0x3f : 0xff
        expect(decoded[index]! & randomMask).toBe(source[index]! & randomMask)
      }
    }
    expect(getRandomValues).toHaveBeenCalledTimes(256)
  })

  it('uses getRandomValues even when randomUUID exists and rejects weaker sources', () => {
    const randomUUID = vi.fn(() => { throw new Error('randomUUID must not be called') })
    const getRandomValues = vi.fn((bytes: Uint8Array<ArrayBuffer>) => secureCrypto.getRandomValues(bytes))
    vi.stubGlobal('crypto', { randomUUID, getRandomValues })
    const weakRandom = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('weak random source') })
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock source') })
    expect(createRequestId()).toMatch(uuidV4)
    expect(getRandomValues).toHaveBeenCalledOnce()
    expect(randomUUID).not.toHaveBeenCalled()
    expect(weakRandom).not.toHaveBeenCalled()
    expect(clock).not.toHaveBeenCalled()
  })

  it('does not even read randomUUID in an HTTP-like crypto environment', () => {
    const readRandomUUID = vi.fn(() => { throw new Error('secure-context property read') })
    vi.stubGlobal('crypto', { getRandomValues: secureCrypto.getRandomValues.bind(secureCrypto), get randomUUID() { return readRandomUUID() } })
    expect(createRequestId()).toMatch(uuidV4)
    expect(readRandomUUID).not.toHaveBeenCalled()
  })

  it.each([undefined, null, {}, { getRandomValues: undefined }, { getRandomValues: 'invalid' }])('fails closed when the cryptographic source is unavailable: %j', crypto => {
    vi.stubGlobal('crypto', crypto)
    expect(createRequestId).toThrow('Secure request IDs require crypto.getRandomValues')
  })

  it('propagates cryptographic source failures instead of returning partially filled IDs', () => {
    const failure = new Error('cryptographic source unavailable')
    const getRandomValues = vi.fn((bytes: Uint8Array) => { bytes[0] = 0xff; throw failure })
    vi.stubGlobal('crypto', { getRandomValues })
    expect(createRequestId).toThrow(failure)
    expect(getRandomValues).toHaveBeenCalledOnce()
  })
})
