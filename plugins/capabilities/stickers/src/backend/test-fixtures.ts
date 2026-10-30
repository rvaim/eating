import { deflateSync } from 'node:zlib'
export function fixturePng(color = 0): Buffer {
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff
    for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0) }
    return (value ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4, 4, 'ascii'); data.copy(bytes, 8)
    bytes.writeUInt32BE(crc(bytes.subarray(4, -4)), bytes.length - 4); return bytes
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, color & 255, color >>> 8 & 255, 94, 255]))), chunk('IEND', Buffer.alloc(0))])
}
export const fixtureImage = (color = 0) => ({ mimeType: 'image/png' as const, data: fixturePng(color).toString('base64') })
