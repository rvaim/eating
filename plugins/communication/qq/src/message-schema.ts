import type { JsonObject } from '@eating/plugin-sdk'

const MAX_TEXT = 262144
const MAX_SAFE = Number.MAX_SAFE_INTEGER

// Exact decimal string ranges let the browser and backend enforce the same safe IDs without coercion.
function decimalUpTo(maximum: number, zero = false): string {
  const digits = String(maximum)
  const alternatives: string[] = zero ? ['0'] : []
  if (digits.length > 1) alternatives.push(`[1-9][0-9]{0,${digits.length - 2}}`)
  for (let index = 0; index < digits.length; index++) {
    const minimum = index === 0 ? 1 : 0
    const maximumDigit = Number(digits[index]) - 1
    if (maximumDigit < minimum) continue
    const digit = minimum === maximumDigit ? String(minimum) : `[${minimum}-${maximumDigit}]`
    const remaining = digits.length - index - 1
    alternatives.push(`${digits.slice(0, index)}${digit}${remaining ? `[0-9]{${remaining}}` : ''}`)
  }
  alternatives.push(digits)
  return `(?:${alternatives.join('|')})`
}

export const oneBotIdSchema: JsonObject = {
  anyOf: [
    { type: 'integer', minimum: 1, maximum: MAX_SAFE },
    { type: 'string', maxLength: 16, pattern: `^${decimalUpTo(MAX_SAFE)}$` },
  ],
  description: '正整数 QQ／群号码；可用安全整数或十进制字符串。',
}
export const oneBotMessageIdSchema: JsonObject = {
  anyOf: [
    { type: 'integer', minimum: -2147483648, maximum: 2147483647 },
    { type: 'string', maxLength: 11, pattern: `^(?:${decimalUpTo(2147483647, true)}|-${decimalUpTo(2147483648, true)})$` },
  ],
  description: 'OneBot v11 的有符号 int32 消息 ID，可用整数或十进制字符串。',
}

const text = (minimum = 0): JsonObject => ({ type: 'string', minLength: minimum, maxLength: MAX_TEXT })
const integerParameter: JsonObject = {
  anyOf: [
    { type: 'string', maxLength: 17, pattern: `^-?${decimalUpTo(MAX_SAFE, true)}$` },
    { type: 'integer', minimum: -MAX_SAFE, maximum: MAX_SAFE },
  ],
}
const numberParameter: JsonObject = {
  anyOf: [
    { type: 'string', minLength: 1, maxLength: 64, pattern: '^-?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)$' },
    { type: 'number', minimum: -MAX_SAFE, maximum: MAX_SAFE },
  ],
}
const booleanParameter: JsonObject = {
  anyOf: [
    { type: 'string', enum: ['0', '1', 'no', 'yes', 'false', 'true'] },
    { type: 'boolean' },
    { type: 'integer', enum: [0, 1] },
  ],
}
const mediaProperties: JsonObject = {
  file: { type: 'string', minLength: 1, maxLength: 1048576, description: 'OneBot 文件名、file://、http(s)://、base64://，或获准插件返回的 eating-asset:// 资源引用。插件图片引用放入 type:"image" 消息段的 data.file，消息段对象／数组直接作为 message 传入，不要 JSON.stringify 或放进 text 段。图片资源由 Eating 转换为标准图片数据；语音使用 speech_get 返回的 eating-audio:// 引用，必须放入单独的 record 段，后台按当前授权解析音频。不读取任意本机文件。' },
  cache: { ...booleanParameter, default: '1' },
  proxy: { ...booleanParameter, default: '1' },
  timeout: numberParameter,
}
const object = (properties: JsonObject, required: string[] = []): JsonObject => ({
  type: 'object', properties, required, additionalProperties: false,
})
const segment = (type: string, data: JsonObject): JsonObject => object({ type: { const: type }, data }, ['type', 'data'])
const noData: JsonObject = { anyOf: [{ type: 'null' }, object({})] }

/** Official sendable segments. `forward` is deliberately absent: OneBot v11 defines it as receive-only. */
export const oneBotMessageDefinitions: JsonObject = {
  oneBotMessage: {
    anyOf: [
      { type: 'string', minLength: 1, maxLength: MAX_TEXT },
      { type: 'array', minItems: 1, maxItems: 1000, items: { $ref: '#/$defs/oneBotSegment' } },
      { $ref: '#/$defs/oneBotSegment' },
    ],
  },
  oneBotSegment: {
    oneOf: [
      segment('text', object({ text: text(1) }, ['text'])),
      segment('face', object({ id: integerParameter }, ['id'])),
      segment('image', object({ ...mediaProperties, type: { type: 'string', enum: ['flash'] } }, ['file'])),
      segment('record', object({ ...mediaProperties, magic: { ...booleanParameter, default: '0' } }, ['file'])),
      segment('video', object(mediaProperties, ['file'])),
      segment('at', object({ qq: { anyOf: [{ type: 'string', const: 'all' }, oneBotIdSchema] } }, ['qq'])),
      segment('rps', noData),
      segment('dice', noData),
      segment('shake', noData),
      segment('poke', object({ type: integerParameter, id: integerParameter }, ['type', 'id'])),
      segment('anonymous', { anyOf: [{ type: 'null' }, object({ ignore: booleanParameter })] }),
      segment('share', object({ url: text(1), title: text(), content: text(), image: text() }, ['url', 'title'])),
      segment('contact', object({ type: { type: 'string', enum: ['qq', 'group'] }, id: oneBotIdSchema }, ['type', 'id'])),
      segment('location', object({ lat: numberParameter, lon: numberParameter, title: text(), content: text() }, ['lat', 'lon'])),
      segment('music', {
        oneOf: [
          object({ type: { type: 'string', enum: ['qq', '163', 'xm'] }, id: integerParameter }, ['type', 'id']),
          object({ type: { const: 'custom' }, url: text(1), audio: text(1), title: text(), content: text(), image: text() }, ['type', 'url', 'audio', 'title']),
        ],
      }),
      segment('reply', object({ id: oneBotMessageIdSchema }, ['id'])),
      segment('node', {
        oneOf: [
          object({ id: oneBotMessageIdSchema }, ['id']),
          object({ user_id: oneBotIdSchema, nickname: text(), content: { $ref: '#/$defs/oneBotMessage' } }, ['user_id', 'nickname', 'content']),
        ],
      }),
      segment('xml', object({ data: text(1) }, ['data'])),
      segment('json', object({ data: text(1) }, ['data'])),
    ],
  },
}

export const oneBotMessageSchema: JsonObject = {
  $ref: '#/$defs/oneBotMessage',
  description: '普通文字直接传字符串，例如 {"message":"你好"}；消息段直接传对象或数组，不能 JSON.stringify，也不能把 text／image／record 等消息段 JSON 放进字符串或 text 段。图片把工具返回的原 eating-asset:// 引用放在 image.data.file；语音把 speech_get 返回的原 eating-audio:// 引用放在单独的 record.data.file，不混文字／图片，不用 CQ 码包装内部引用，不猜本机路径。错误格式在发送前以 QQ_MESSAGE_FORMAT_INVALID／not-sent 拒绝并指出字段；没有登记发送动作，修正后复用已有资源和本次 request_id，已成功或 unknown 的动作不得重发。生成成功、文字发送的 message_id 不等于图片／语音发送成功；以正确媒体调用及真实回执为准。正常聊天不发送协议 JSON 或内部工具报告；必要诊断以实际证据为准。普通字符串默认按文字发送；auto_escape=false 只解析标准外部 CQ 码，不能解析 JSON 或内部媒体引用。',
  examples: [
    '你好',
    [{ type: 'text', data: { text: '你好' } }],
    [{ type: 'image', data: { file: 'eating-asset://image-generation/<assetId>' } }],
    { type: 'record', data: { file: 'eating-audio://text-to-speech/<assetId>' } },
  ],
}
