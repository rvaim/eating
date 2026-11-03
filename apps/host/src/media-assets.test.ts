import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { PlatformError } from '@eating/plugin-sdk'
import { createImageFixturePng } from '../../../tests/fixtures/image'
import { verifiedImageAsset } from './media-assets'

function fixture() {
  const bytes = createImageFixturePng(), readBytes = vi.fn(async () => bytes), assertAllowed = vi.fn(() => {})
  const value = { mimeType: 'image/png' as const, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), readBytes, localFile: vi.fn(async () => '/fixture/image.png') }
  return { value, readBytes, assertAllowed, bytes }
}
describe('Host verified sending media leases', () => {
  it('checks source bytes and metadata and keeps file paths behind an internal method', async () => {
    const f = fixture(), lease = await verifiedImageAsset(f.value, f.assertAllowed)
    expect(Buffer.from(await lease.readBytes())).toEqual(f.bytes)
    expect(await lease.localFile!()).toBe('/fixture/image.png')
    await lease.assertActive()
    expect(f.readBytes).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(lease)).not.toContain('/fixture')
    expect(Object.isFrozen(lease)).toBe(true)
  })
  it.each(['size', 'hash', 'mime', 'overlimit', 'empty'] as const)('rejects provider %s mismatches before exposing a lease', async kind => {
    const f = fixture()
    const invalid = kind === 'size' ? { ...f.value, byteLength: f.bytes.length + 1 }
      : kind === 'hash' ? { ...f.value, sha256: '0'.repeat(64) }
        : kind === 'mime' ? { ...f.value, mimeType: 'image/jpeg' as const }
          : kind === 'overlimit' ? { ...f.value, byteLength: 5 * 1024 * 1024 + 1 }
            : { ...f.value, readBytes: async () => new Uint8Array() }
    await expect(verifiedImageAsset(invalid, f.assertAllowed)).rejects.toMatchObject({ code: 'INVALID_IMAGE_RESOURCE', outcome: 'not-sent' })
  })
  it('rechecks revocation before and after every asynchronous source read and before sending', async () => {
    const f = fixture(), lease = await verifiedImageAsset(f.value, f.assertAllowed)
    let active = true
    f.assertAllowed.mockImplementation(() => { if (!active) throw new PlatformError('ASSET_ACCESS_DENIED', 'Revoked', 403, 'not-sent') })
    f.readBytes.mockImplementationOnce(async () => { active = false; return f.bytes })
    await expect(lease.readBytes()).rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })
    await expect(lease.localFile!()).rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })
    await expect(lease.assertActive()).rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })
    expect(f.value.localFile).not.toHaveBeenCalled()
  })
  it('detects a later source mutation even when the logical reference is unchanged', async () => {
    const f = fixture(), lease = await verifiedImageAsset(f.value, f.assertAllowed), changed = Buffer.from(f.bytes)
    changed[changed.length - 1] = 0
    f.readBytes.mockResolvedValueOnce(changed)
    await expect(lease.assertActive()).rejects.toMatchObject({ code: 'INVALID_IMAGE_RESOURCE', outcome: 'not-sent' })
  })
})
