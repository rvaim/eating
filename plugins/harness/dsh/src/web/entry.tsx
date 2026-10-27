import { BrainCircuit } from 'lucide-react'
import type { HarnessPlugin } from '@eating/ui-sdk'
import { DSHPanel, validateConfiguration } from './panel'

const plugin: HarnessPlugin = {
  id: 'dsh', kind: 'harness', name: 'DeepSeek Harness',
  description: '使用独立运行时和主会话处理消息，由主 Agent 自行决定是否调用 QQ 工具。',
  version: '0.1.0', apiVersion: 1, order: 10,
  icon: BrainCircuit, brandColor: '#3876b6', defaultRegistered: true,
  initialValues: { displayName: 'DeepSeek Harness', endpoint: '', model: '', autoConnect: false, timeoutMs: '60000', maxTokens: '4096' },
  validate: validateConfiguration,
  summary: values => [typeof values.displayName === 'string' && values.displayName.trim() ? values.displayName.trim() : 'DeepSeek Harness',
    typeof values.model === 'string' ? values.model.trim() : ''].filter(Boolean).join(' · '),
  Panel: DSHPanel,
}
export default plugin
