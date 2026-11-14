import { describe, expect, it } from 'vitest'
import type { JsonObject } from '@eating/plugin-sdk'
import { prepareOneBotCall, qqTools } from './operations'
const audioRef = 'eating-audio://text-to-speech/' + 'a'.repeat(64)
const request_id = 'audio-reference-fixture-001'
const audio = { type: 'record', data: { file: audioRef } }

describe('explicit audio reference on QQ sending tools', () => {
  it.each(['send_private_msg', 'send_group_msg', 'send_msg'])('constructs one canonical record for %s without passing internal fields to OneBot', action => {
    const tool = qqTools.find(t => t.protocolAction === action)!
    const target: JsonObject = action === 'send_group_msg' ? { group_id: '456' } : { user_id: '123' }
    expect(prepareOneBotCall(tool, { ...target, audio_ref: audioRef, request_id })).toEqual({ action, params: { [action === 'send_group_msg' ? 'group_id' : 'user_id']: action === 'send_group_msg' ? 456 : 123, message: [audio], auto_escape: true } })
    const invalid: JsonObject[] = [
      { ...target, audio_ref: audioRef, message: 'do not mix' },
      { ...target, audio_ref: audioRef, message: [audio] },
      { ...target, audio_ref: audioRef, auto_escape: false },
      { ...target, audio_ref: 'file:///guessed.wav' },
      { ...target, audio_ref: '[CQ:record,file=' + audioRef + ']' },
      { ...target, audio_ref: JSON.stringify(audio) },
      { ...target, audio_ref: 'eating-audio://invalid' },
      target,
    ]
    for (const input of invalid) expect(() => prepareOneBotCall(tool, { ...input, request_id })).toThrow()
  })
  it('retains explicit target validation for generic sends and excludes quick operations', () => {
    const generic = qqTools.find(t => t.protocolAction === 'send_msg')!
    const invalidTargets: JsonObject[] = [{}, { user_id: 123, group_id: 456 }, { message_type: 'group', user_id: 123 }]
    for (const target of invalidTargets) expect(() => prepareOneBotCall(generic, { ...target, audio_ref: audioRef, request_id })).toThrow()
    expect(prepareOneBotCall(generic, { message_type: 'group', group_id: 456, audio_ref: audioRef, request_id }).params.message).toEqual([audio])
    const quick = qqTools.find(t => t.protocolAction === '.handle_quick_operation')!
    expect(() => prepareOneBotCall(quick, { context: {}, operation: { audio_ref: audioRef }, request_id })).toThrow()
  })
})
