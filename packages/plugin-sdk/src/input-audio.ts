import { PlatformError } from './index.js'

export const MAX_INPUT_AUDIO_BYTES = 8 * 1024 * 1024
export const MAX_INPUT_AUDIO_DURATION_MS = 120000
const invalid = (): never => { throw new PlatformError('INVALID_INPUT_AUDIO', '识别音频须为有效的16位PCM WAV或Ogg Opus，最多8MiB／120秒。', 400, 'not-sent') }

/** Inspect the container, never a file extension or caller-provided duration. */
export function checkedInputAudio(value: unknown): { bytes: Uint8Array; mimeType: 'audio/wav' | 'audio/ogg'; durationMs: number } {
  if (!(value instanceof Uint8Array) || value.byteLength < 44 || value.byteLength > MAX_INPUT_AUDIO_BYTES) return invalid()
  const bytes = new Uint8Array(value), view = new DataView(bytes.buffer)
  const ascii = (at: number, size: number) => String.fromCharCode(...bytes.subarray(at, at + size))
  let durationMs = 0, mimeType: 'audio/wav' | 'audio/ogg'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') {
    mimeType = 'audio/wav'
    if (view.getUint32(4, true) + 8 !== bytes.length) return invalid()
    let rate = 0, channels = 0, size = 0, format = false, data = false
    for (let at = 12; at < bytes.length;) {
      if (at + 8 > bytes.length) return invalid()
      const name = ascii(at, 4), length = view.getUint32(at + 4, true), end = at + 8 + length
      if (end > bytes.length) return invalid()
      if (name === 'fmt ') {
        if (format || ![16, 18].includes(length) || length === 18 && view.getUint16(at + 24, true) !== 0 || view.getUint16(at + 8, true) !== 1 || view.getUint16(at + 22, true) !== 16) return invalid()
        format = true; channels = view.getUint16(at + 10, true); rate = view.getUint32(at + 12, true)
        if (![1, 2].includes(channels) || ![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(rate)
          || view.getUint16(at + 20, true) !== channels * 2 || view.getUint32(at + 16, true) !== rate * channels * 2) return invalid()
      } else if (name === 'data') { if (data || !format || !length || length % (channels * 2)) return invalid(); data = true; size = length }
      at = end + length % 2
      if (at > bytes.length) return invalid()
    }
    if (!format || !data) return invalid()
    durationMs = size / (rate * channels * 2) * 1000
  } else if (ascii(0, 4) === 'OggS') {
    mimeType = 'audio/ogg'
    let at = 0, sequence = 0, serial: number | null = null, granule = 0n, preSkip = 0, packets = 0, ended = false
    let partial: number[] = []
    while (at < bytes.length) {
      if (ended || at + 27 > bytes.length || ascii(at, 4) !== 'OggS' || bytes[at + 4] !== 0) return invalid()
      const flags = bytes[at + 5]!, count = bytes[at + 26]!, headerEnd = at + 27 + count
      if (flags & ~7 || headerEnd > bytes.length || view.getUint32(at + 18, true) !== sequence++
        || Boolean(flags & 1) !== Boolean(partial.length) || sequence === 1 && !(flags & 2) || sequence > 1 && flags & 2) return invalid()
      const stream = view.getUint32(at + 14, true); if (serial !== null && stream !== serial) return invalid(); serial = stream
      let end = headerEnd
      for (let i = at + 27; i < headerEnd; i++) end += bytes[i]!
      if (end > bytes.length) return invalid()
      let crc = 0
      for (let i = at; i < end; i++) { crc ^= (i >= at + 22 && i < at + 26 ? 0 : bytes[i]!) << 24; for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0) }
      if ((crc >>> 0) !== view.getUint32(at + 22, true)) return invalid()
      let offset = headerEnd
      for (let i = at + 27; i < headerEnd; i++) {
        const length = bytes[i]!; partial.push(...bytes.subarray(offset, offset + length)); offset += length
        if (partial.length > 65536) return invalid()
        if (length < 255) {
          const packet = Uint8Array.from(partial); partial = []
          const magic = String.fromCharCode(...packet.subarray(0, 8))
          if (packets === 0) { if (magic !== 'OpusHead' || packet.length !== 19 || packet[8] !== 1 || ![1, 2].includes(packet[9]!) || packet[18] !== 0) return invalid(); preSkip = new DataView(packet.buffer).getUint16(10, true) }
          else if (packets === 1 && magic !== 'OpusTags' || packets > 1 && !packet.length) return invalid()
          packets++
        }
      }
      const current = view.getBigUint64(at + 6, true)
      if (current !== 0xffffffffffffffffn) { if (current < granule) return invalid(); granule = current }
      ended = Boolean(flags & 4); at = end
    }
    if (!ended || partial.length || packets < 3 || granule <= BigInt(preSkip)) return invalid()
    durationMs = Number(granule - BigInt(preSkip)) / 48
  } else return invalid()
  if (!(durationMs > 0 && durationMs <= MAX_INPUT_AUDIO_DURATION_MS)) return invalid()
  return { bytes, mimeType, durationMs }
}
