export function inputWav(durationMs = 100, rate = 24000, channels = 1): Buffer {
  const data = Math.round(durationMs * rate / 1000) * channels * 2, bytes = Buffer.alloc(44 + data)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels * 2, 28); bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(data, 40); return bytes
}
export function inputOgg(durationMs = 100): Buffer {
  function page(packet: Buffer, sequence: number, flags: number, granule: number) {
    const bytes = Buffer.alloc(28 + packet.length); bytes.write('OggS'); bytes[5] = flags; bytes.writeBigUInt64LE(BigInt(granule), 6); bytes.writeUInt32LE(7, 14); bytes.writeUInt32LE(sequence, 18); bytes[26] = 1; bytes[27] = packet.length; packet.copy(bytes, 28)
    let crc = 0; for (const byte of bytes) { crc ^= byte << 24; for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0) }; bytes.writeUInt32LE(crc >>> 0, 22); return bytes
  }
  const head = Buffer.alloc(19); head.write('OpusHead'); head[8] = 1; head[9] = 1; head.writeUInt32LE(48000, 12)
  const tags = Buffer.alloc(16); tags.write('OpusTags')
  return Buffer.concat([page(head, 0, 2, 0), page(tags, 1, 0, 0), page(Buffer.from([0xf8, 0xff, 0xfe]), 2, 4, durationMs * 48)])
}
