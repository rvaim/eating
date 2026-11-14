/** A complete authored 1x1 gray JPEG, using constant quantizers and one-bit DC/EOB tables. */
export function createJpegFixture(progressive = false): Buffer {
  const segment = (marker: number, payload: Uint8Array) => {
    const header = Buffer.from([0xff, marker, 0, 0]); header.writeUInt16BE(payload.length + 2, 2)
    return Buffer.concat([header, payload])
  }
  const huffman = (table: number) => segment(0xc4, Buffer.from([table, 1, ...Array<number>(15).fill(0), 0]))
  const scan = (start: number, end: number) => segment(0xda, Buffer.from([1, 1, 0, start, end, 0]))
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xdb, Buffer.from([0, ...Array<number>(64).fill(1)])), huffman(0), huffman(0x10),
    segment(progressive ? 0xc2 : 0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
    ...(progressive ? [scan(0, 0), Buffer.from([0x7f]), scan(1, 63), Buffer.from([0x7f])] : [scan(0, 63), Buffer.from([0x3f])]),
    Buffer.from([0xff, 0xd9]),
  ])
}
