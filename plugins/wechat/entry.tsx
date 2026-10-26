import { MessagesSquare } from 'lucide-react'
import type { PluginConfiguration } from '@eating/plugin-core'
import type { CommunicationPlugin, ConfigurationValidation, PluginPanelProps } from '../../apps/web/src/plugins/contract'
import { ConfigurationForm, Field, TextValue, validateDisplayName, validateLocalAddress } from '../../apps/web/src/components/ConfigurationForm'

function validate(values: PluginConfiguration): ConfigurationValidation {
  const errors: Record<string, string> = {}
  const nameError = validateDisplayName(values)
  const addressError = validateLocalAddress(TextValue(values, 'serviceUrl'), ['http:', 'https:'])
  if (nameError) errors.displayName = nameError
  if (addressError) errors.serviceUrl = addressError
  return { valid: Object.keys(errors).length === 0, errors }
}

function WechatPanel(props: PluginPanelProps) {
  return <ConfigurationForm {...props} title="服务配置" description="微信示例插件提供自己的服务地址与会话选项。" validate={validate}>
    {({ values, update, errors }) => <>
      <Field label="显示名称" error={errors.displayName}>{attributes =>
        <input {...attributes} value={TextValue(values, 'displayName')} maxLength={40} onChange={event => update('displayName', event.target.value)} autoComplete="off" />
      }</Field>
      <Field label="服务地址" error={errors.serviceUrl} hint="此地址仅用于格式校验，不连接任何微信协议服务。">{attributes =>
        <input {...attributes} type="url" value={TextValue(values, 'serviceUrl')} onChange={event => update('serviceUrl', event.target.value)} autoComplete="off" spellCheck={false} />
      }</Field>
      <label className="check-field"><input type="checkbox" checked={values.privateOnly === true} onChange={event => update('privateOnly', event.target.checked)} /><span><strong>仅启用私聊</strong><small>未接入登录、账号绑定或真实消息收发。</small></span></label>
    </>}
  </ConfigurationForm>
}

const plugin: CommunicationPlugin = {
  id: 'wechat', name: '微信', description: '验证新平台分类与独立配置面板的注册。',
  version: '0.1.0', apiVersion: 1, kind: 'communication', order: 30,
  icon: MessagesSquare, brandColor: '#348358', defaultRegistered: false,
  initialValues: { displayName: '微信中的 Eating', serviceUrl: 'http://127.0.0.1:8787', privateOnly: true },
  validate, summary: values => TextValue(values, 'displayName', '微信配置'), Panel: WechatPanel,
}
export default plugin
