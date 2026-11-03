import { describe, expect, it } from 'vitest'
import { checkedImageBytes, checkedImageResource, parseImageAssetUri } from './media'
import { createImageFixturePng } from '../../../tests/fixtures/image'

describe('public image media contract', () => {
  it('uses opaque references and validates exact bounded bytes independently from AI preview encoding', () => {
    const bytes = createImageFixturePng()
    expect(parseImageAssetUri('eating-asset://image-generation/opaque_asset')).toEqual({ pluginId: 'image-generation', assetId: 'opaque_asset' })
    expect(checkedImageBytes(bytes, 'image/png')).toEqual(new Uint8Array(bytes))
    expect(checkedImageResource({ mimeType: 'image/png', data: bytes.toString('base64') })).toEqual({ mimeType: 'image/png', data: bytes.toString('base64') })
    expect(parseImageAssetUri('file:///host/private.png')).toBeNull()
    expect(() => parseImageAssetUri('eating-asset://image-generation/../secret')).toThrow()
  })
  it('rejects raw paths, strings, wrong MIME, empty bytes and oversized buffers', () => {
    for (const value of ['/private/image.png', 'base64://YWJj', new Uint8Array(), new Uint8Array(5 * 1024 * 1024 + 1)]) expect(() => checkedImageBytes(value, 'image/png')).toThrow()
    expect(() => checkedImageBytes(createImageFixturePng(), 'image/jpeg')).toThrow()
  })
})
