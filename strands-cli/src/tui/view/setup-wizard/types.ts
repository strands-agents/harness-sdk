import type { HarnessAgentConfig } from '@strands-agents/harness'

import type { PermissionMode, ProviderEnvironmentKey, ProviderId } from '../../config.js'
import type { ChatSettings } from '../../chat/types.js'

export type EditableField = 'name' | 'instructions' | 'skills' | 'memoryDir' | 'importPath' | ProviderEnvironmentKey
export type SetupFlow = 'quickstart' | 'manual' | 'agent' | 'import'

export type AppearanceSettings = Pick<
  ChatSettings,
  'frogTheme' | 'colorMode' | 'customTheme' | 'transcriptSpacing' | 'animations' | 'showReasoning' | 'toolOutput'
>

export interface SetupDraft {
  providers: ProviderId[]
  profile: HarnessAgentConfig
  permissionMode: PermissionMode
  allowedTools: string[]
  customPermissions: boolean
  disabledSkills?: Exclude<HarnessAgentConfig['skills'], false>
  settings: Pick<ChatSettings, 'mcpDiscovery' | 'skillDiscovery' | 'agentMessaging'>
}

export interface WizardRow {
  id: string
  label: string
  description: string
  section?: string
  active?: boolean
  disabled?: boolean
  input?: boolean
  field?: EditableField
  selectOptions?: readonly SelectOption[]
  status?: 'success' | 'warning' | 'error'
  descriptionColor?: string
  choices?: readonly { label: string; value?: string | boolean; active: boolean; activate(): void }[]
  activate(): void
}

export interface SelectOption {
  label: string
  value?: string
  custom?: boolean
}
