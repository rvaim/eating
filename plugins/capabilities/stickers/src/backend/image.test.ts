import { describe, expect, it } from 'vitest'
import { decodeStickerImage } from './image'
import { fixtureImage, fixturePng } from './test-fixtures'
import { STICKER_LIMITS } from '../types'

describe('sticker image input validation', () => {
  it('accepts generated PNG, GIF and canonical image bytes', () => {
    expect(decodeStickerImage(fixtureImage())).toEqual({ mimeType: 'image/png', bytes: fixturePng() })
    const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    expect(decodeStickerImage({ mimeType: 'image/gif', data: gif })).toEqual({ mimeType: 'image/gif', bytes: Buffer.from(gif, 'base64') })
  })
  it.each([null, {}, { ...fixtureImage(), mimeType: 'image/jpeg' }, { ...fixtureImage(), data: '' }, { ...fixtureImage(), data: fixtureImage().data + '\n' }, { mimeType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') }, { mimeType: 'image/png', data: Buffer.from('not an image').toString('base64') }, { ...fixtureImage(), data: 'file:///etc/passwd' }])('rejects malformed images, MIME mismatch and noncanonical data: %j', input => {
    expect(() => decodeStickerImage(input)).toThrowError(expect.objectContaining({ code: 'STICKER_INVALID_IMAGE' }))
  })
  it('rejects encoded content above the hard five MiB bound', () => {
    expect(() => decodeStickerImage({ mimeType: 'image/png', data: Buffer.alloc(STICKER_LIMITS.imageBytes + 1).toString('base64') })).toThrowError(expect.objectContaining({ code: 'STICKER_INVALID_IMAGE' }))
  })
})
