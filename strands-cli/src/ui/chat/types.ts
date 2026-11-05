import type { Message } from '@strands-agents/sdk'
import type {
  ChatAttachmentSummary,
  ChatBackend,
  ChatBuiltinToolsRuntime,
  ChatConfigurationBaseline,
  ChatConfigurationDiffs,
  ChatConfigurationLanguage,
  ChatConfigurationSource,
  ChatContextUsage,
  ChatConversations,
  ChatEffortOption,
  ChatInput,
  ChatPermissionMode,
  ChatPermissionPreset,
  ChatPermissionRequest,
  ChatTask,
  ChatToolInfo,
  ChatTurn,
} from '../../agent/types.js'

import type { BackgroundAgentActivity } from '../../agent/background.js'
import type { LoadedMcp } from '../../agent/mcp.js'
import type { PeerMessage } from '../../agent/messaging.js'
import type { ChatSkillsRuntime } from '../../agent/skills.js'
import type { VoiceSessionSnapshot } from '../../agent/voice.js'
import type { ChatSettings, SettingsCategory } from '../../config/settings.js'
import type { AgentProjectOutput } from '../../project/export.js'
import type { ImportedAgentProject } from '../../project/import.js'
import type { ChatSessionRuntime, ResumeSession } from '../../session/sessions.js'
import type { CommandAssistance } from './commands.js'
import type { StreamPresentationOptions } from './stream-presentation.js'

export {
  CONTEXT_OFFLOAD_THRESHOLD_OPTIONS,
  DEFAULT_CHAT_SETTINGS,
  FROG_THEME_LABELS,
  FROG_THEMES,
  THEME_COLOR_KEYS,
  type ChatSettings,
  type ContextOffloadThreshold,
  type FrogTheme,
  type ResolvedColorMode,
  type SettingsCategory,
  type ThemeColors,
  type ThemeSettings,
} from '../../config/settings.js'

export interface ChatNotice {
  id: string
  afterTurnId?: string
  taskId?: string
  text: string
  status: 'running' | 'success' | 'error' | 'delivered'
}

export interface ChatPanelRow {
  label: string
  description: string
  columns?: readonly string[]
  value?: string
  section?: string
  bold?: boolean
  current?: boolean
  filter?: string
  tone?: 'normal' | 'success' | 'warning' | 'danger'
  control?:
    | {
        kind: 'toggle'
        checked: boolean
      }
    | {
        kind: 'segmented'
        options: readonly {
          label: string
          value: string
          active?: boolean
        }[]
      }
  badge?: {
    text: string
    tone: 'normal' | 'success' | 'warning' | 'danger'
  }
}

export interface ChatPanelFilter {
  id: string
  label: string
}

export interface ChatPanelSlider {
  label: string
  options: readonly ChatEffortOption[]
  disabled?: boolean
}

export interface ChatPanelBase {
  title: string
  rows: readonly ChatPanelRow[]
  searchable?: boolean
  filters?: readonly ChatPanelFilter[]
  body?: string
}

export type NewChatPanel =
  | (ChatPanelBase & {
      kind: 'context' | 'skills' | 'agents' | 'tools' | 'voice' | 'help' | 'error'
    })
  | (ChatPanelBase & {
      kind: 'mcp'
      canRetry?: boolean
    })
  | (ChatPanelBase & {
      kind: 'export'
      nameInput?: { language: ChatConfigurationLanguage; defaultName: string }
    })
  | (ChatPanelBase & {
      kind: 'sessions'
      /** Saved sessions are still being discovered. */
      loading?: boolean
    })
  | (ChatPanelBase & {
      kind: 'models'
      /** Models are still being discovered. */
      loading?: boolean
      awsProfile?: {
        value: string
        options: readonly { value: string; label: string }[]
        open?: boolean
      }
    })
  | (ChatPanelBase & {
      kind: 'effort'
      slider: ChatPanelSlider
    })
  | (ChatPanelBase & {
      kind: 'tasks'
    })
  | (ChatPanelBase & {
      kind: 'permissions'
      slider: ChatPanelSlider
    })
  | (ChatPanelBase & {
      kind: 'permission'
      request: ChatPermissionRequest
      /** The forever choice whose scopes are listed; absent on the main choices. */
      stage?: 'allow-always' | 'deny-always'
      /** The row selected when the panel opens. */
      selected?: number
    })
  | (ChatPanelBase & {
      kind: 'detail' | 'help-detail'
      followTail?: boolean
      activity?: BackgroundAgentActivity
    })
  | (ChatPanelBase & {
      kind: 'settings'
      settingsCategory?: SettingsCategory
    })
  | (ChatPanelBase & {
      kind: 'config'
      configuration: ChatConfigurationSource
      language: ChatConfigurationLanguage
    })

export type ChatPanel = NewChatPanel & { id: string }
export type ChatModelPanel = Extract<ChatPanel, { kind: 'models' }>
export type ChatSessionsPanel = Extract<ChatPanel, { kind: 'sessions' }>
export type ChatTasksPanel = Extract<ChatPanel, { kind: 'tasks' }>
export type ChatPermissionsPanel = Extract<ChatPanel, { kind: 'permissions' }>
export type ChatPermissionPanel = Extract<ChatPanel, { kind: 'permission' }>
export type ChatDetailPanel = Extract<ChatPanel, { kind: 'detail' | 'help-detail' }>

export interface ChatRuntimeInfo {
  agent: string
  version: string
  backendId: string
  protocol: ChatBackend['protocol']
  model: string
  effort?: string
  session: string
  sessionName?: string
  cwd: string
  tools: readonly ChatToolInfo[]
  configuration?: readonly { label: string; value: string }[]
}

export interface ChatVoiceStore {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => VoiceSessionSnapshot
}

/** Progress of the MCP servers connecting in the background after launch. */
export interface ChatMcpStartup {
  total: number
  connected: number
  failed: number
  /** All connections finished; shown only while failures remain unseen. */
  settled: boolean
}

export interface ChatSnapshot {
  conversationId?: string
  completedTurns: readonly ChatTurn[]
  activeTurn?: ChatTurn
  pendingSteering: readonly string[]
  queuedPrompts: readonly {
    id: string
    prompt: string
    attachments?: readonly ChatAttachmentSummary[]
    source?: 'peer'
    from?: string
  }[]
  notices: readonly ChatNotice[]
  tasks: readonly ChatTask[]
  context: ChatContextUsage
  status: 'idle' | 'running' | 'interrupting' | 'closed'
  /** Present only while MCP servers are still connecting. */
  mcpStartup?: ChatMcpStartup
  composerStatus?: string
  panel?: ChatPanel
  configuration?: ChatConfigurationSource
  configurationDiffs?: ChatConfigurationDiffs
  runtime: ChatRuntimeInfo
  permissionMode?: ChatPermissionMode
  permissionPreset?: ChatPermissionPreset
  settings: ChatSettings
  voice?: VoiceSessionSnapshot
  exitCode?: number
}

export interface ChatControllerOptions {
  project?: ImportedAgentProject
  copyText?: (text: string) => Promise<boolean>
  runtime?: Partial<ChatRuntimeInfo>
  settings?: Partial<ChatSettings>
  streamPresentation?: StreamPresentationOptions
  sessions?: ChatSessionRuntime
  skills?: ChatSkillsRuntime
  skillNames?: readonly string[]
  mcp?: Omit<LoadedMcp, 'clients'>
  initialMessages?: readonly Message[]
  initialTurns?: readonly ChatTurn[]
  initialConfigurationBaseline?: ChatConfigurationBaseline
  setSettings?: (settings: Partial<ChatSettings>) => Promise<void>
  requestSetup?: () => void
  awsProfile?: {
    get(): Omit<NonNullable<ChatModelPanel['awsProfile']>, 'open'>
    select(profile: string): void
  }
  builtinTools?: ChatBuiltinToolsRuntime
  exportAgentProject?: (
    language: ChatConfigurationLanguage,
    destination?: string,
    output?: AgentProjectOutput
  ) => Promise<string | undefined>
  configurationSource?: () => ChatConfigurationSource
  /** Reload this session from an exported project directory, keeping the conversation. */
  useExportedProject?: (path: string) => void
  peerEndpointId?: string
}

export interface ChatControllerApi {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => ChatSnapshot
  readonly voice?: ChatVoiceStore
  readonly busy: boolean
  readonly hardExitCode: number | undefined
  readonly resumeSession?: ResumeSession | undefined
  captureConversations?(): Promise<ChatConversations>
  pauseVoiceInput?(): () => void
  showError?(title: string, message: string): void
  setSettings?(settings: Partial<ChatSettings>): Promise<boolean>
  toggleVoiceMute?(): boolean
  actionableCommandToken(input: string): string | undefined
  commandAssistance?(input: string): CommandAssistance | undefined
  start(firstRequest?: string): Promise<void>
  submit(input: ChatInput): Promise<ChatTurn | undefined>
  enqueuePeerMessage?(message: PeerMessage): boolean
  steer(input: string): Promise<ChatTurn | undefined>
  updateQueuedPrompt(id: string, prompt: string): boolean
  removeQueuedPrompt(id: string): boolean
  moveQueuedPrompt(id: string, direction: -1 | 1): boolean
  cancel(): boolean
  close(exitCode?: number): void
  dispose(): Promise<void>
  dismissPanel(): boolean
  activatePanelRow(row: ChatPanelRow): Promise<boolean>
  openSkillDetail(name: string): boolean
  openMcpDetail(name: string): boolean
  retryMcpServer(name: string): Promise<boolean>
  openModelPanel(): Promise<void>
  openContextPanel(): void
}
