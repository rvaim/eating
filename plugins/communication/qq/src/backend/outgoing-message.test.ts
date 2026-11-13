import { describe, expect, it } from 'vitest'
import type { JsonObject, JsonValue } from '@eating/plugin-sdk'
import { ONEBOT_V11_SEND_SEGMENTS } from '../../../../../tests/fixtures/onebot-v11-contract'
import { prepareOneBotCall, qqTools } from './operations'

const audio = { type: 'record', data: { file: 'eating-audio://text-to-speech/' + 'a'.repeat(64) } }
const image = { type: 'image', data: { file: 'eating-asset://image-generation/fixture-image' } }
const text = { type: 'text', data: { text: '普通聊天' } }
const context = { post_type: 'message', message_type: 'private', self_id: 123, user_id: 456 }
function prepare(action: string, message: JsonValue, extra: JsonObject = {}) {
  const params: JsonObject = action === '.handle_quick_operation' ? { context, operation: { reply: message } }
    : action === 'send_group_msg' ? { group_id: 789, message } : { user_id: 456, message }
  return prepareOneBotCall(qqTools.find(tool => tool.protocolAction === action)!, { ...params, request_id: 'message-format-fixture-1', ...extra })
}

describe('outgoing QQ message representation', () => {
  it.each(['send_private_msg', 'send_group_msg', 'send_msg', '.handle_quick_operation'])('rejects serialized text and voice, media text, and internal CQ references in %s', action => {
    const malformed: JsonValue[] = [
      JSON.stringify(text), JSON.stringify([text]), JSON.stringify(audio), JSON.stringify([audio]),
      JSON.stringify(JSON.stringify([text])), JSON.stringify(image),
      { type: 'text', data: { text: JSON.stringify([text]) } },
      { type: 'node', data: { user_id: 456, nickname: '成员', content: JSON.stringify(audio) } },
      audio.data.file, `语音：${audio.data.file}`, `[CQ:record,file=${audio.data.file}]`,
      { type: 'text', data: { text: audio.data.file } },
      { type: 'image', data: { file: audio.data.file } },
      { type: 'record', data: { file: image.data.file } },
      { type: 'share', data: { url: 'https://example.invalid', title: audio.data.file } },
    ]
    for (const message of malformed) {
      for (const auto_escape of [true, false]) {
        let error: unknown
        try { prepare(action, message, action === '.handle_quick_operation' ? {} : { auto_escape }) } catch (caught) { error = caught }
        expect(error).toMatchObject({ code: 'QQ_MESSAGE_FORMAT_INVALID', statusCode: 400, outcome: 'not-sent' })
        expect((error as Error).message).toContain(action === '.handle_quick_operation' ? 'operation.reply' : 'message')
        expect((error as Error).message).toContain('request_id')
        expect((error as Error).message).toContain('不要 JSON.stringify')
      }
    }
  })

  it.each(ONEBOT_V11_SEND_SEGMENTS)('rejects a stringified %s segment without interpreting it as ordinary text', type => {
    expect(() => prepare('send_private_msg', JSON.stringify({ type, data: {} }))).toThrowError('收到的是序列化消息段字符串')
  })

  it('checks internal audio placement and standalone shape before accepting a send', () => {
    const malformed: JsonValue[] = [
      [audio, text], [audio, audio], [text, audio],
      { type: 'node', data: { user_id: 456, nickname: '成员', content: [audio] } },
      { type: 'record', data: { file: 'eating-audio://invalid' } },
    ]
    for (const message of malformed) expect(() => prepare('send_private_msg', message)).toThrowError('本次未发送')
    expect(() => prepare('.handle_quick_operation', audio)).toThrowError('不使用快速操作 reply')
    expect(prepare('send_private_msg', audio).params.message).toEqual(audio)
    expect(prepare('send_group_msg', [audio]).params.message).toEqual([audio])
  })

  it('preserves ordinary text, business JSON, external CQ, and real structured segments', () => {
    for (const message of ['普通聊天', '{"result":"ok"}', '[1,2,3]', '{"type":"event","data":{"ok":true}}', '[CQ:record,file=https://example.invalid/a.wav]']) {
      expect(prepare('send_private_msg', message, { auto_escape: false }).params.message).toBe(message)
    }
    for (const message of [text, [text], image, [text, image], { type: 'json', data: { data: JSON.stringify(text) } }]) {
      expect(prepare('send_private_msg', message).params.message).toEqual(message)
    }
    const inbound = { ...context, message: JSON.stringify(audio) }
    expect(prepare('.handle_quick_operation', '收到', { context: inbound }).params.context).toEqual(inbound)
  })

  it('handles deep serialized data without recursively validating or rewriting it', () => {
    const nested = '['.repeat(20000) + JSON.stringify(text) + ']'.repeat(20000)
    expect(() => prepare('send_private_msg', nested)).toThrowError('收到的是序列化消息段字符串')
    const business = '{"payload":' + '['.repeat(20000) + '0' + ']'.repeat(20000) + '}'
    expect(prepare('send_private_msg', business).params.message).toBe(business)
  })
})
