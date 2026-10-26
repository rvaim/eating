import { MessageCircle } from 'lucide-react'
import type { PluginConfiguration } from '@eating/plugin-core'
import type { CommunicationPlugin, ConfigurationValidation, PluginPanelProps } from '../../apps/web/src/plugins/contract'
import { ConfigurationForm, Field, TextValue, validateDisplayName, validateLocalAddress } from '../../apps/web/src/components/ConfigurationForm'

function validate(values: PluginConfiguration): ConfigurationValidation {
  const errors: Record<string, string> = {}
  const nameError = validateDisplayName(values)
  const addressError = validateLocalAddress(TextValue(values, 'address'), ['ws:', 'wss:'])
  if (nameError) errors.displayName = nameError
  if (addressError) errors.address = addressError
  if (!['mention', 'private'].includes(TextValue(values, 'replyMode'))) errors.replyMode = '请选择回复范围。'
  return { valid: Object.keys(errors).length === 0, errors }
}

function QQPanel(props: PluginPanelProps) {
  return <ConfigurationForm {...props} title="连接配置" description="为 QQ 设置显示名称和示例连接方式。" validate={validate}>
    {({ values, update, errors }) => <>
      <div className="field-grid">
        <Field label="显示名称" error={errors.displayName} hint="仅用于在 Eating 中识别这个配置。">{attributes =>
          <input {...attributes} value={TextValue(values, 'displayName')} maxLength={40} onChange={event => update('displayName', event.target.value)} autoComplete="off" />
        }</Field>
        <Field label="接入方式" hint="本版本仅展示配置，不发起网络请求。">{attributes =>
          <input {...attributes} value="OneBot · WebSocket" readOnly className="input-readonly" />
        }</Field>
      </div>
      <Field label="连接地址" error={errors.address} hint="示例地址，可在接入真实连接器后使用。">{attributes =>
        <input {...attributes} type="url" value={TextValue(values, 'address')} onChange={event => update('address', event.target.value)} placeholder="ws://127.0.0.1:3001" autoComplete="off" spellCheck={false} />
      }</Field>
      <Field label="回复范围" error={errors.replyMode} hint="保存偏好，不会在此版本发送消息。">{attributes =>
        <select {...attributes} value={TextValue(values, 'replyMode')} onChange={event => update('replyMode', event.target.value)}>
          <option value="mention">私聊与群聊中提及我</option><option value="private">仅私聊</option>
        </select>
      }</Field>
      <label className="check-field"><input type="checkbox" checked={values.groupMessages === true} onChange={event => update('groupMessages', event.target.checked)} /><span><strong>允许接收群聊消息</strong><small>连接器接入后，仍由 AI 决定是否回复。</small></span></label>
    </>}
  </ConfigurationForm>
}

const plugin: CommunicationPlugin = {
  id: 'qq', name: 'QQ', description: '通过 OneBot 连接 QQ 私聊与群聊。',
  version: '0.1.0', apiVersion: 1, kind: 'communication', order: 10,
  icon: MessageCircle, brandColor: '#3876b6', defaultRegistered: true,
  initialValues: { displayName: '我的 QQ 机器人', address: 'ws://127.0.0.1:3001', replyMode: 'mention', groupMessages: true },
  validate, summary: values => TextValue(values, 'displayName', 'QQ 配置'), Panel: QQPanel,
}
export default plugin
