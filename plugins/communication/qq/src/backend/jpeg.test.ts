import { describe, expect, it } from 'vitest'
import { createJpegFixture } from '../../../../../tests/fixtures/jpeg'
import { jpegImageEnd } from './jpeg'

const frame = (bytes: Buffer) => bytes.indexOf(Buffer.from([0xff, 0xc0]))
const scan = (bytes: Buffer) => bytes.indexOf(Buffer.from([0xff, 0xda]))
describe('JPEG codestream structure', () => {
  it.each([false, true])('finds the true end of a complete baseline/progressive=%s image before outer data', progressive => {
    const jpeg = createJpegFixture(progressive), trailer = Buffer.from('authored trailer with \xff\xd9 inside', 'latin1')
    expect(jpegImageEnd(jpeg)).toBe(jpeg.length)
    expect(jpegImageEnd(Buffer.concat([jpeg, trailer]))).toBe(jpeg.length)
  })
  it('skips marker-like bytes inside APP/COM segments and handles stuffed bytes, fill and restart markers', () => {
    const jpeg = createJpegFixture(), comment = Buffer.from([0xff, 0xfe, 0, 6, 0xff, 0xd9, 0xff, 0xd8])
    const commented = Buffer.concat([jpeg.subarray(0, 2), comment, jpeg.subarray(2)])
    expect(jpegImageEnd(commented)).toBe(commented.length)
    const stuffed = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xdd, 0, 4, 0, 1]), jpeg.subarray(2, -2), Buffer.from([0xff, 0x00, 0xd9, 0xff, 0xd0, 0x01, 0xff]), jpeg.subarray(-2)])
    expect(jpegImageEnd(stuffed)).toBe(stuffed.length)
  })
  it('rejects every truncated prefix even if marker-like trailer bytes are appended inside a segment', () => {
    const jpeg = createJpegFixture()
    for (let end = 0; end < jpeg.length; end++) expect(jpegImageEnd(jpeg.subarray(0, end)), String(end)).toBeNull()
    expect(jpegImageEnd(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), jpeg]))).toBeNull()
    expect(jpegImageEnd(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull()
  })
  it('rejects invalid segment lengths, frame dimensions/components, scans and empty entropy data', () => {
    const jpeg = createJpegFixture(), sof = frame(jpeg), sos = scan(jpeg)
    const malformed = [
      [4, 255], [5, 1], [sof + 4, 0], [sof + 6, 0], [sof + 8, 0], [sof + 9, 0],
      [sos + 3, 7], [sos + 4, 0], [sos + 5, 9],
    ]
    for (const [offset, value] of malformed) { const invalid = Buffer.from(jpeg); invalid[offset!] = value!; expect(jpegImageEnd(invalid), String(offset)).toBeNull() }
    expect(jpegImageEnd(Buffer.concat([jpeg.subarray(0, sos + 10), jpeg.subarray(-2)]))).toBeNull()
    expect(jpegImageEnd(Buffer.concat([jpeg.subarray(0, sof), Buffer.from([0xff, 0xd0]), jpeg.subarray(sof)]))).toBeNull()
  })
})
