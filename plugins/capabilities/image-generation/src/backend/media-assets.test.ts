import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createImageFixturePng } from '../../../../../tests/fixtures/image'
import { ImageGenerationStore } from './store'
import { imageBytes } from './image'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (realpathSync(root) !== root || dirname(root) !== realpathSync(tmpdir()) || !basename(root).startsWith('eating-generated-media-')) throw new Error('Unsafe generation media cleanup')
    rmSync(root, { recursive: true })
  }
})
function fixture() {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'eating-generated-media-'))); roots.push(root)
  const store = new ImageGenerationStore(root), bytes = createImageFixturePng(), requestHash = createHash('sha256').update('generation-fixture').digest('hex')
  const job = store.enqueue('generation-media-fixture-0001', requestHash, 'temporary fixture', 'fixture-model')
  store.complete(job.jobId, imageBytes(bytes, 'image/png'), () => {})
  const assetId = store.job(job.jobId).assetIds[0]!
  return { root, store, bytes, assetId }
}
describe('generated image sending sources', () => {
  it('returns original bytes and validated local files without reading a Base64 preview', async () => {
    const f = fixture(), asset = f.store.getAsset(f.assetId)
    expect(asset).toMatchObject({ mimeType: 'image/png', byteLength: f.bytes.length, sha256: f.assetId })
    expect(Buffer.from(await asset.readBytes())).toEqual(f.bytes)
    expect(await asset.localFile!()).toBe(join(f.root, 'blobs', f.assetId))
    expect(JSON.stringify(asset)).not.toContain(f.root)
    expect(JSON.stringify(asset)).not.toContain(f.bytes.toString('base64'))
  })
  it('rejects traversal identifiers and detects symlink changes after a source was obtained', async () => {
    const f = fixture(), asset = f.store.getAsset(f.assetId), path = await asset.localFile!()
    expect(() => f.store.getAsset('../state.json')).toThrow()
    const target = realpathSync(path)
    if (target !== path || dirname(target) !== join(f.root, 'blobs')) throw new Error('Unsafe generated media replacement')
    rmSync(target); symlinkSync(join(f.root, 'state.json'), target)
    await expect(asset.readBytes()).rejects.toMatchObject({ code: 'IMAGE_GENERATION_STATE_CORRUPTED' })
    await expect(asset.localFile!()).rejects.toMatchObject({ code: 'IMAGE_GENERATION_STATE_CORRUPTED' })
  })
})
