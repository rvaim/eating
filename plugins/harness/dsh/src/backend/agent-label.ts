import type { AgentInvocationScope } from '@eating/plugin-sdk'

/** Display identity only; the verified binding key and native UUID stay independent. */
export function agentInstanceLabel(scope: Pick<AgentInvocationScope, 'pluginId' | 'accountId' | 'kind' | 'targetId'>, pluginName?: string): string {
  return `${pluginName || scope.pluginId}-${scope.accountId}-${scope.kind === 'private' ? '私聊' : '群聊'}-${scope.targetId}`
}
