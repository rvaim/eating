import { afterEach, describe, expect, it } from 'vitest'
import { getLocale, setLocale } from '@eating/ui-sdk'
import { readStickerList, readStickerPreview, readStickerTags, tagsFromText, imageBlob, localImage } from './data'
import { stickerTranslations, st } from './i18n'
import { fixtureImage, fixturePng } from '../backend/test-fixtures'

const original = getLocale()
afterEach(() => setLocale(original))
const assetId = 'a'.repeat(64)
const item = { assetId, description: '外部描述 {{变量}}', tags: ['原样标签'], mimeType: 'image/png', bytes: fixturePng().length, createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' }

describe('sticker panel boundaries and translations', () => {
  it('has matched bilingual resources and preserves user descriptions verbatim', () => {
    expect(Object.keys(stickerTranslations['zh-CN']).sort()).toEqual(Object.keys(stickerTranslations['en-US']).sort())
    for (const [key, zh] of Object.entries(stickerTranslations['zh-CN'])) {
      const en = stickerTranslations['en-US'][key as keyof typeof stickerTranslations['zh-CN']]
      expect(en.trim()).not.toBe('')
      expect(en).not.toMatch(/\p{Script=Han}/u)
      expect([...en.matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]).sort()).toEqual([...zh.matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]).sort())
    }
    setLocale('en-US'); expect(st('editor.add')).toBe('Add sticker')
    expect(readStickerPreview({ item, revision: 2, image: fixtureImage() }).item.description).toBe(item.description)
  })
  it('rejects malformed pagination, metadata and image responses', () => {
    const value = { revision: 1, items: [item], offset: 0, limit: 20, total: 1, hasMore: false, nextOffset: null }
    expect(readStickerList(value)).toEqual(value)
    for (const bad of [{ ...value, items: [{ ...item, assetId: '../file' }] }, { ...value, hasMore: true }, { ...value, limit: 100 }, { ...value, nextOffset: 1 }]) expect(() => readStickerList(bad)).toThrow()
    expect(readStickerTags({ revision: 1, tags: [{ tag: 'hello', count: 1 }] })).toEqual({ revision: 1, tags: [{ tag: 'hello', count: 1 }] })
    expect(() => readStickerTags({ revision: 1, tags: [{ tag: 'hello', count: -1 }] })).toThrow()
    expect(() => readStickerPreview({ item, revision: 1, image: { mimeType: 'image/svg+xml', data: 'aaaa' } })).toThrow()
  })
  it('parses newline-separated tags without splitting commas or spaces inside a tag', () => {
    expect(tagsFromText(' 开心 \n开心\nHELLO\nhello\nwith space\nwith,comma\n')).toEqual(['开心', 'HELLO', 'with space', 'with,comma'])
    expect(() => tagsFromText('x'.repeat(33))).toThrow()
    expect(() => tagsFromText(Array(33).fill('tag').join('\n'))).toThrow()
  })
  it('creates a bounded Blob from the selected image without returning a data URL', async () => {
    const blob = imageBlob(fixtureImage())
    expect(blob.type).toBe('image/png')
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(fixturePng())
    expect(() => imageBlob({ mimeType: 'image/png', data: 'ab==' })).toThrow()
  })
  it('accepts local image files, supports an empty OS MIME via the filename and refuses oversized uploads', async () => {
    const file = new File([Uint8Array.from(fixturePng())], 'local.png', { type: 'image/png' })
    expect(await localImage(file)).toEqual(fixtureImage())
    expect(await localImage(new File([Uint8Array.from(fixturePng())], 'local.png'))).toEqual(fixtureImage())
    await expect(localImage(new File(['bad'], 'file.svg', { type: 'image/svg+xml' }))).rejects.toThrow()
    await expect(localImage(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'too-large.png', { type: 'image/png' }))).rejects.toThrow()
  })
})
