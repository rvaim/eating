import { checkedAudioBytes } from '@eating/plugin-sdk'
export function normalizeSpeechText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\p{Z}\s，。！？、；：“”‘’「」『』,!?;:"']/gu, '').replace(/(?<!\d)\.|\.(?!\d)/gu, '')
}
export function wav(pcm: Buffer): Buffer {
  const bytes = Buffer.alloc(44 + pcm.length); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(pcm.length, 40); pcm.copy(bytes, 44)
  checkedAudioBytes(bytes, 'audio/wav'); return bytes
}
