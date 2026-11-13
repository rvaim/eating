import { describe, expect, it } from 'vitest'
import { checkedInputAudio } from './input-audio'
import { inputOgg, inputWav } from '../../../tests/fixtures/input-audio'
describe('independent incoming audio contract', () => {
  it.each([8000, 16000, 22050, 24000, 32000, 44100, 48000])('accepts provider-supported PCM sample rate %i with stereo duration', rate => {
    expect(checkedInputAudio(inputWav(1000, rate, 2))).toMatchObject({ mimeType: 'audio/wav', durationMs: 1000 })
  })
  it('checks Ogg Opus container, EOS and checksum instead of trusting a filename', () => {
    const bytes = inputOgg(); expect(checkedInputAudio(bytes)).toMatchObject({ mimeType: 'audio/ogg', durationMs: 100 })
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; expect(() => checkedInputAudio(bytes)).toThrow()
    expect(() => checkedInputAudio(inputOgg().subarray(0, 90))).toThrow()
  })
  it('rejects raw PCM, MP3, mismatched length, compression and excessive duration or size', () => {
    for (const v of [Buffer.alloc(48), Buffer.from('ID3'.repeat(20)), inputWav(120001), inputOgg(120001), Buffer.alloc(8 * 1024 * 1024 + 1)]) expect(() => checkedInputAudio(v)).toThrow()
    const wav = inputWav(); wav.writeUInt16LE(3, 20); expect(() => checkedInputAudio(wav)).toThrow()
    expect(checkedInputAudio(inputWav(120000))).toMatchObject({ durationMs: 120000 })
  })
  it('accepts a PCM fmt extension without confusing it with compressed WAV', () => {
    const wav = inputWav(), extended = Buffer.concat([wav.subarray(0, 36), Buffer.alloc(2), wav.subarray(36)]); extended.writeUInt32LE(extended.length - 8, 4); extended.writeUInt32LE(18, 16)
    expect(checkedInputAudio(extended)).toMatchObject({ mimeType: 'audio/wav', durationMs: 100 }); extended.writeUInt16LE(1, 36); expect(() => checkedInputAudio(extended)).toThrow()
  })

})
