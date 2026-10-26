import { Send } from 'lucide-react'
import type { PluginConfiguration } from '@eating/plugin-core'
import type { CommunicationPlugin, ConfigurationValidation, PluginPanelProps } from '../../apps/web/src/plugins/contract'
import { ConfigurationForm, Field, TextValue, validateDisplayName } from '../../apps/web/src/components/ConfigurationForm'

function validate(values: PluginConfiguration): ConfigurationValidation {
  const errors: Record<string, string> = {}
  const nameError = validateDisplayName(values)
  if (nameError) errors.displayName = nameError
  if (!/^cli_[a-zA-Z0-9_]{3,80}$/.test(TextValue(values, 'appId'))) errors.appId = '请填写以 cli_ 开头的示例应用 ID。'
  if (!['long-connection', 'callback'].includes(TextValue(values, 'eventMode'))) errors.eventMode = '请选择事件接收方式。'
  return { valid: Object.keys(errors).length === 0, errors }
}

function FeishuPanel(props: PluginPanelProps) {
  return <ConfigurationForm {...props} title="应用配置" description="飞书插件提供自己的应用字段与事件选项。" validate={validate}>
    {({ values, update, errors }) => <>
      <Field label="显示名称" error={errors.displayName}>{attributes =>
        <input {...attributes} value={TextValue(values, 'displayName')} maxLength={40} onChange={event => update('displayName', event.target.value)} autoComplete="off" />
      }</Field>
      <Field label="应用 ID" error={errors.appId} hint="这里使用示例 ID，请不要填入密钥或认证令牌。">{attributes =>
        <input {...attributes} value={TextValue(values, 'appId')} maxLength={84} onChange={event => update('appId', event.target.value)} placeholder="cli_example_app" autoComplete="off" spellCheck={false} />
      }</Field>
      <Field label="事件接收方式" error={errors.eventMode}>{attributes =>
        <select {...attributes} value={TextValue(values, 'eventMode')} onChange={event => update('eventMode', event.target.value)}><option value="long-connection">长连接模式</option><option value="callback">事件回调模式</option></select>
      }</Field>
      <label className="check-field"><input type="checkbox" checked={values.mentionOnly === true} onChange={event => update('mentionOnly', event.target.checked)} /><span><strong>仅接收提及机器人的群消息</strong><small>这是本地偏好，尚未与飞书服务同步。</small></span></label>
    </>}
  </ConfigurationForm>
}

const plugin: CommunicationPlugin = {
  id: 'feishu', name: '飞书', description: '为飞书应用配置消息与事件接收方式。',
  version: '0.1.0', apiVersion: 1, kind: 'communication', order: 20,
  icon: Send, brandColor: '#4273c2', defaultRegistered: true,
  initialValues: { displayName: '工作中的 Eating', appId: 'cli_example_app', eventMode: 'long-connection', mentionOnly: true },
  validate, summary: values => TextValue(values, 'displayName', '飞书配置'), Panel: FeishuPanel,
}
export default plugin
