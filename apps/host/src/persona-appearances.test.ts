import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_PERSONA_APPEARANCE_IMAGES, imageLimits } from '@eating/plugin-sdk'
import { PersonaAppearanceStore } from './persona-appearances'
import { createImageFixturePng } from '../../../tests/fixtures/image'

const stops: Array<() => void> = []
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop()
})

function fixture(maxImageMiB = 10) {
  const parent = realpathSync(tmpdir())
  const dir = realpathSync(mkdtempSync(join(parent, 'eating-persona-appearances-')))
  stops.push(() => {
    if (realpathSync(dir) !== dir || dirname(dir) !== parent || !basename(dir).startsWith('eating-persona-appearances-')) {
      throw new Error('Unsafe cleanup')
    }
    rmSync(dir, { recursive: true })
  })
  return { dir, store: new PersonaAppearanceStore(join(dir, 'persona-appearances'), () => imageLimits(maxImageMiB)) }
}

const jpegBytes = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x2a, 0x00, 0x18, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xff, 0xd9,
])

describe('PersonaAppearanceStore', () => {
  it('stores validated PNG/JPEG images, parses dimensions, enforces CAS edits, and cascades persona removal', () => {
    const { store } = fixture()
    const personaA = '00000000-0000-4000-8000-0000000000a1'
    const personaB = '00000000-0000-4000-8000-0000000000b2'
    expect(store.list(personaA)).toEqual({
      protocolVersion: 1,
      personaId: personaA,
      revision: 0,
      maxImages: MAX_PERSONA_APPEARANCE_IMAGES,
      images: [],
    })

    const png = createImageFixturePng()
    const first = store.add(personaA, { data: png.toString('base64'), mimeType: 'image/png', label: '正面半身' })
    expect(first.revision).toBe(1)
    expect(first.image).toMatchObject({ label: '正面半身', mimeType: 'image/png', width: 1, height: 1, byteLength: png.length })

    const second = store.add(personaA, {
      data: `data:image/jpeg;base64,${jpegBytes.toString('base64')}`,
      label: '侧脸参考',
      expectedRevision: 1,
    })
    expect(second.revision).toBe(2)
    expect(second.image).toMatchObject({ label: '侧脸参考', mimeType: 'image/jpeg', width: 24, height: 42 })

    const relabeled = store.updateLabel(personaA, first.image.id, '蓝发红瞳设定', 2)
    expect(relabeled.revision).toBe(3)
    expect(relabeled.images[0]!.label).toBe('蓝发红瞳设定')

    expect(() => store.updateLabel(personaA, first.image.id, 'stale', 2)).toThrowError(expect.objectContaining({ code: 'PERSONA_APPEARANCE_CONFLICT' }))

    const reordered = store.reorder(personaA, [second.image.id, first.image.id], 3)
    expect(reordered.revision).toBe(4)
    expect(reordered.images.map(item => item.id)).toEqual([second.image.id, first.image.id])

    expect(store.readImageResource(personaA, first.image.id)).toEqual({ mimeType: 'image/png', data: png.toString('base64') })

    const afterRemove = store.remove(personaA, second.image.id, 4)
    expect(afterRemove.images).toHaveLength(1)
    expect(() => store.readImageBytes(personaA, second.image.id)).toThrowError(expect.objectContaining({ code: 'PERSONA_APPEARANCE_NOT_FOUND' }))

    const addedB = store.add(personaB, { data: png.toString('base64'), label: 'Persona B' })
    store.removePersona(personaB)
    expect(store.list(personaB).images).toEqual([])
    expect(() => store.readImageBytes(personaB, addedB.image.id)).toThrowError(expect.objectContaining({ code: 'PERSONA_APPEARANCE_NOT_FOUND' }))
    expect(store.list(personaA).images).toHaveLength(1)
  })

  it('rejects non-image/mismatched MIME bytes, enforces max image cap and byte limits, and refuses tampered index/blob', () => {
    const { store } = fixture(1)
    const personaId = '00000000-0000-4000-8000-0000000000c3'

    expect(() => store.add(personaId, { data: Buffer.from('<svg></svg>').toString('base64') })).toThrowError(expect.objectContaining({ code: 'INVALID_PERSONA_APPEARANCE_IMAGE' }))
    expect(() => store.add(personaId, { data: jpegBytes.toString('base64'), mimeType: 'image/png' })).toThrowError(expect.objectContaining({ code: 'INVALID_PERSONA_APPEARANCE_IMAGE' }))
    expect(() => store.add(personaId, { data: Buffer.alloc(1024 * 1024 + 8, 1).toString('base64') })).toThrowError(expect.objectContaining({ code: 'IMAGE_TOO_LARGE' }))

    const png = createImageFixturePng()
    for (let i = 0; i < MAX_PERSONA_APPEARANCE_IMAGES; i++) {
      store.add(personaId, { data: png.toString('base64'), label: `图 ${i + 1}` })
    }
    expect(() => store.add(personaId, { data: png.toString('base64') })).toThrowError(expect.objectContaining({ code: 'PERSONA_APPEARANCE_LIMIT_REACHED' }))

    const firstId = store.list(personaId).images[0]!.id
    const blobFile = join(store.directory, `${firstId}.bin`)
    writeFileSync(blobFile, jpegBytes)
    expect(() => store.readImageBytes(personaId, firstId)).toThrowError(expect.objectContaining({ code: 'PERSONA_APPEARANCE_STORAGE_CORRUPTED' }))

    const indexPath = join(store.directory, 'index.json')
    if (process.platform !== 'win32') expect(statSync(indexPath).mode & 0o777).toBe(0o600)
    writeFileSync(indexPath, '{"schemaVersion":2')
    expect(() => store.list(personaId)).toThrowError(expect.objectContaining({ code: 'PERSONA_APPEARANCE_STORAGE_CORRUPTED' }))
    expect(readFileSync(indexPath, 'utf8')).toBe('{"schemaVersion":2')
    chmodSync(indexPath, 0o600)
  })
})
