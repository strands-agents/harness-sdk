import type { DocumentFormat, ImageFormat, JSONValue, Message, Snapshot, VideoFormat } from '@strands-agents/sdk'

import type { BackgroundAgentActivity } from '../background/activity.js'
import type { LoadedMcp } from '../mcp.js'
import type { PeerMessage } from '../messaging.js'
import type { ChatSessionRuntime } from '../session/sessions.js'
import type { ChatSkillsRuntime } from '../skills.js'
import type { StreamPresentationOptions } from '../stream-presentation.js'
import type { VoiceSessionSnapshot } from '../voice/session.js'
import type { ImportedAgentProject } from '../project/import.js'
import type { ChatSettings, SettingsCategory } from '../settings.js'

export {
  DEFAULT_CHAT_SETTINGS,
  FROG_THEMES,
  FROG_THEME_LABELS,
  THEME_COLOR_KEYS,
  type ChatSettings,
  type FrogTheme,
  type ColorMode,
  type ResolvedColorMode,
  type ThemeColors,
  type CustomTheme,
  type SettingsCategory,
} from '../settings.js'

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens: number
  cacheReadInputTokens: number
  cacheWriteInputTokens: number
}

export interface ChatContextUsage extends Partial<TokenUsage> {
  currentTokens?: number
  projectedTokens?: number
  contextWindow?: number
}

export interface ChatTask {
  id: string
  label: string
  status: 'pending' | 'queued' | 'in_progress' | 'working' | 'paused' | 'completed' | 'failed' | 'cancelled'
  source: 'todo' | 'background' | 'acp'
  detail?: string
  toolUseId?: string
  deliveryState?: 'pending' | 'ready' | 'delivered'
  result?: string
  error?: string
}

export interface ChatPermissionOption {
  id: string
  label: string
  description?: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

export interface ChatDiffLine {
  kind: 'header' | 'context' | 'add' | 'remove'
  text: string
  oldLine?: number
  newLine?: number
}

export interface ChatDiffPreview {
  path: string
  lines: readonly ChatDiffLine[]
  truncated?: boolean
}

export interface ChatPermissionRequest {
  id: string
  toolName: string
  input: JSONValue
  options: readonly ChatPermissionOption[]
  diff?: ChatDiffPreview
}

export type ChatPermissionMode = 'default' | 'bypassPermissions'

export interface ChatPermissionStatus {
  mode: ChatPermissionMode
  allowedTools: readonly string[]
  configPath: string
}

export interface ChatS3Location {
  type: 's3'
  uri: string
  bucketOwner?: string
}

export type ChatImageSource =
  { type: 'bytes'; bytes: Uint8Array } | { type: 's3'; location: ChatS3Location } | { type: 'url'; url: string }

export type ChatVideoSource = { type: 'bytes'; bytes: Uint8Array } | { type: 's3'; location: ChatS3Location }

export type ChatDocumentSource =
  | { type: 'bytes'; bytes: Uint8Array }
  | { type: 'text'; text: string }
  | { type: 'content'; content: readonly string[] }
  | { type: 's3'; location: ChatS3Location }

export type ChatMediaContent =
  | {
      type: 'image'
      format: ImageFormat
      source: ChatImageSource
    }
  | {
      type: 'video'
      format: VideoFormat
      source: ChatVideoSource
    }
  | {
      type: 'document'
      name: string
      format: DocumentFormat
      source: ChatDocumentSource
      citations?: { enabled: boolean }
      context?: string
    }

export type ChatToolResultContent =
  | {
      type: 'text'
      text: string
    }
  | {
      type: 'json'
      value: JSONValue
    }
  | ChatMediaContent

export type ChatEvent =
  | {
      type: 'reasoningDelta'
      text: string
    }
  | {
      type: 'textDelta'
      text: string
    }
  | {
      type: 'media'
      content: ChatMediaContent
    }
  | {
      type: 'toolStart'
      toolUseId: string
      name: string
      input: JSONValue
      background?: boolean
    }
  | {
      type: 'toolOutputDelta'
      toolUseId: string
      stream: 'stdout' | 'stderr'
      text: string
    }
  | {
      type: 'toolResult'
      toolUseId: string
      status: 'success' | 'error'
      content: readonly ChatToolResultContent[]
      error?: string
    }
  | {
      type: 'tasks'
      tasks: readonly ChatTask[]
    }
  | {
      type: 'context'
      usage: ChatContextUsage
    }
  | {
      type: 'permission'
      request: ChatPermissionRequest
    }

export interface ChatRunResult {
  stopReason: string
  usage?: TokenUsage
  /** Final spend for this run when its background work outlives the stream; fires once. */
  watchUsage?: (listener: (usage: TokenUsage | undefined) => void) => () => void
  context?: ChatContextUsage
  finalText?: string
  finalReasoning?: string
}

interface ChatToolInfo {
  name: string
  description: string
  source?: string
}

export interface ChatEffortOption {
  id: string
  label: string
  active?: boolean
}

export interface ChatConversation {
  snapshot: Snapshot
  completedTurns: readonly ChatTurn[]
  model: string
  session?: {
    sessionId: string
    sessionDirectory: string
    workspace: string
    configured: { sessionId: string | null; sessionDir: string }
  }
  sourceSelection?: {
    source: string
    configured: Pick<ChatForkState, 'model' | 'thinking'>
    selected: Pick<ChatForkState, 'model' | 'thinking'>
  }
}

export interface ChatForkState {
  messages: readonly Message[]
  model: string
  thinking: string | boolean | null
  backgroundTasksWaitForCompletion: boolean
}

export interface ChatModelOption {
  id: string
  name: string
  description: string
  value?: string
  active?: boolean
  catalog?: string
}

export interface ChatBackend {
  readonly id: string
  readonly name: string
  readonly protocol: 'strands' | 'acp'
  readonly sessionIdentity?: ChatConversation['session']
  reconstructable?(): boolean
  stream(prompt: string): AsyncGenerator<ChatEvent, ChatRunResult, undefined>
  streamPeer?(message: PeerMessage): AsyncGenerator<ChatEvent, ChatRunResult, undefined>
  cancel(): void
  info?(): {
    description?: string
    model?: string
    effort?: string
    sessionId?: string
    tools?: readonly ChatToolInfo[]
  }
  contextUsage?(): ChatContextUsage | undefined
  listModels?(): Promise<readonly ChatModelOption[]> | readonly ChatModelOption[]
  modelChangeMode?(modelId: string): 'live' | 'restart'
  switchModel?(modelId: string): Promise<string | void>
  restartModel?(modelId: string): Promise<string | void>
  listEfforts?(): readonly ChatEffortOption[]
  setEffort?(effort: string): Promise<string | void>
  streamShell?(command: string): AsyncGenerator<ChatEvent, ChatRunResult, undefined>
  queueSteering?(prompt: string): boolean
  forkState?(): ChatForkState
  captureConversation?(): Promise<Snapshot>
  sourceSelection?(): ChatConversation['sourceSelection']
  watchTasks?(listener: (tasks: readonly ChatTask[]) => void): () => void
  watchPermissions?(listener: (request: ChatPermissionRequest | undefined) => void): () => void
  permissionStatus?(): ChatPermissionStatus | undefined
  setPermissionMode?(mode: ChatPermissionMode): Promise<void>
  allowPermission?(toolName: string): Promise<void>
  removeAllowedPermission?(toolName: string): Promise<void>
  backgroundTasksWaitForCompletion?(): boolean | undefined
  setBackgroundTasksWaitForCompletion?(waitForCompletion: boolean): Promise<void>
  /** Summarizes older conversation context and returns the new context usage, or undefined when nothing changed. */
  compact?(): Promise<ChatContextUsage | undefined>
  clear?(): Promise<void>
  hasReadyBackgroundResults?(): boolean
  streamBackgroundResults?(): AsyncGenerator<ChatEvent, ChatRunResult, undefined>
  getTaskActivity?(taskId: string): BackgroundAgentActivity | undefined
  watchTaskActivity?(taskId: string, listener: (activity: BackgroundAgentActivity | undefined) => void): () => void
  respondPermission?(requestId: string, optionId?: string): boolean
  dispose?(): void | Promise<void>
}

export type ChatEntry =
  | {
      id: string
      type: 'reasoning'
      text: string
    }
  | {
      id: string
      type: 'assistant'
      text: string
    }
  | {
      id: string
      type: 'media'
      content: ChatMediaContent
    }
  | {
      id: string
      type: 'tool'
      toolUseId: string
      name: string
      input: JSONValue
      status: 'running' | 'success' | 'error' | 'cancelled'
      background?: boolean
      result?: readonly ChatToolResultContent[]
      error?: string
    }

export interface ChatTurn {
  id: string
  prompt: string
  agentName: string
  source?: 'background' | 'peer'
  peer?: PeerMessage['from']
  entries: readonly ChatEntry[]
  status: 'running' | 'complete' | 'cancelled' | 'error'
  durationMs?: number
  usage?: TokenUsage
  stopReason?: string
  error?: string
}

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
  value?: string
  section?: string
  bold?: boolean
  current?: boolean
  filter?: string
  tone?: 'normal' | 'warning' | 'danger'
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
    tone: 'success' | 'warning' | 'danger'
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
  focused?: boolean
}

export interface ChatPanel {
  id: string
  kind:
    | 'progress'
    | 'context'
    | 'tasks'
    | 'models'
    | 'effort'
    | 'sessions'
    | 'skills'
    | 'mcp'
    | 'agents'
    | 'rename'
    | 'permissions'
    | 'tools'
    | 'settings'
    | 'voice'
    | 'export'
    | 'help'
    | 'detail'
    | 'permission'
    | 'error'
  title: string
  rows: readonly ChatPanelRow[]
  searchable?: boolean
  filters?: readonly ChatPanelFilter[]
  slider?: ChatPanelSlider
  body?: string
  diff?: ChatDiffPreview
  followTail?: boolean
  activity?: BackgroundAgentActivity
  settingsCategory?: SettingsCategory
  settingsCategories?: readonly {
    id: SettingsCategory
    label: string
    description: string
  }[]
}

export type ChatPanelOptions = Pick<
  ChatPanel,
  | 'searchable'
  | 'filters'
  | 'slider'
  | 'body'
  | 'diff'
  | 'followTail'
  | 'activity'
  | 'settingsCategory'
  | 'settingsCategories'
>

export interface ChatRuntimeInfo {
  agent: string
  version: string
  backendId: string
  protocol: ChatBackend['protocol']
  model: string
  effort?: string
  session: string
  cwd: string
  tools: readonly ChatToolInfo[]
  configuration?: readonly { label: string; value: string }[]
}

export interface ChatVoiceStore {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => VoiceSessionSnapshot
}

export interface ChatSnapshot {
  completedTurns: readonly ChatTurn[]
  activeTurn?: ChatTurn
  queuedPrompts: readonly {
    id: string
    prompt: string
    source?: 'peer'
    from?: string
  }[]
  notices: readonly ChatNotice[]
  tasks: readonly ChatTask[]
  context: ChatContextUsage
  status: 'idle' | 'running' | 'interrupting' | 'closed'
  composerStatus?: string
  panel?: ChatPanel
  runtime: ChatRuntimeInfo
  settings: ChatSettings
  voice?: VoiceSessionSnapshot
  exitCode?: number
}

export interface ChatBuiltinToolChoice {
  name: string
  description: string
  enabled: boolean
  /** Enabling it sends data to a third-party service. */
  thirdParty?: boolean
}

export interface ChatBuiltinToolsRuntime {
  choices(): readonly ChatBuiltinToolChoice[]
  /** Saves the selection and reloads the agent, keeping the conversation. */
  apply(enabled: readonly string[]): void
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
  mcp?: LoadedMcp
  initialMessages?: readonly Message[]
  initialTurns?: readonly ChatTurn[]
  setSettings?: (settings: Partial<ChatSettings>) => Promise<void>
  requestSetup?: () => void
  builtinTools?: ChatBuiltinToolsRuntime
  exportAgentProject?: (language: 'typescript' | 'python', destination?: string) => Promise<string | undefined>
  peerEndpointId?: string
}

export interface ChatControllerApi {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => ChatSnapshot
  readonly voice?: ChatVoiceStore
  readonly busy: boolean
  readonly hardExitCode: number | undefined
  captureConversation?(conversationId?: string): Promise<ChatConversation>
  pauseVoiceInput?(): (target: ChatControllerApi) => void
  showError?(title: string, message: string): void
  toggleVoiceMute?(): boolean
  actionableCommandToken(input: string): string | undefined
  start(firstRequest?: string): Promise<void>
  submit(input: string): Promise<ChatTurn | undefined>
  enqueuePeerMessage?(message: PeerMessage): boolean
  steer(input: string): Promise<ChatTurn | undefined>
  steerQueued(id?: string): boolean
  updateQueuedPrompt(id: string, prompt: string): boolean
  moveQueuedPrompt(id: string, direction: -1 | 1): boolean
  cancel(): boolean
  close(exitCode?: number): void
  dispose(): Promise<void>
  dismissPanel(): boolean
  activatePanelRow(row: ChatPanelRow): Promise<boolean>
  openSkillDetail(name: string): boolean
  openModelPanel(): Promise<void>
  openContextPanel(): void
}
