import type {
  ContentBlockData,
  DocumentBlockData,
  DocumentFormat,
  ImageBlockData,
  ImageFormat,
  JSONValue,
  Message,
  Snapshot,
  VideoFormat,
} from '@strands-agents/sdk'

import type { BackgroundAgentActivity } from './background.js'

import type { PeerMessage } from './messaging.js'

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
  /** Estimated composition of the latest root model request and its response. */
  breakdown?: ChatContextBreakdown
}

export interface ChatContextBreakdown {
  categories: readonly {
    kind: 'systemPrompt' | 'tools' | 'userMessages' | 'assistantMessages' | 'toolResults' | 'injectedContext' | 'other'
    tokens: number
  }[]
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

export type ChatConfigurationLanguage = 'typescript' | 'python'

export interface ChatConfigurationDocument {
  source: string
  generated: boolean
  path?: string
  error?: string
}

export interface ChatConfigurationProject {
  root: string
  entrypoint: string
}

export interface ChatConfigurationSource {
  preferredLanguage: ChatConfigurationLanguage
  documents: Record<ChatConfigurationLanguage, ChatConfigurationDocument>
  project?: ChatConfigurationProject
}

export type ChatConfigurationDiffs = Partial<Record<ChatConfigurationLanguage, ChatDiffPreview>>

/** The configuration before a turn's first change; that turn's diffs are measured against it. */
export interface ChatConfigurationBaseline {
  turnId: string | undefined
  source: ChatConfigurationSource
}

/** A rule a "forever" choice can save, from the exact action down to the whole tool. */
export interface ChatPermissionScope {
  rule: string
  label: string
}

export interface ChatPermissionRequest {
  id: string
  toolName: string
  input: JSONValue
  options: readonly ChatPermissionOption[]
  /** The specific action the call takes, such as a shell command, file path, or URL. */
  action?: string
  /** Most specific first; the last covers the whole tool. */
  scopes?: readonly ChatPermissionScope[]
  diff?: ChatDiffPreview
}

export type ChatPermissionMode = 'default' | 'bypassPermissions'

export type ChatPermissionPreset = 'ask' | 'bypass' | 'custom'

export interface ChatPermissionStatus {
  mode: ChatPermissionMode
  allowedTools: readonly string[]
  deniedTools: readonly string[]
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

export interface ChatAttachmentSummary {
  name: string
  size: number
  kind: 'image' | 'document'
}

export interface ChatAttachment extends ChatAttachmentSummary {
  path: string
  content: { image: ImageBlockData } | { document: DocumentBlockData }
}

export interface ChatInputWithAttachments {
  text: string
  attachments: readonly ChatAttachment[]
}

export type ChatInput = string | ChatInputWithAttachments

export interface ChatToolInfo {
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
  configurationBaseline?: ChatConfigurationBaseline
  model: string
  selection?: Pick<ChatForkState, 'model' | 'thinking'>
  workspace: string
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

export interface ChatConversations {
  activeId: string
  entries: readonly {
    id: string
    title: string
    description: string
    conversation: ChatConversation
  }[]
}

export interface ChatForkState {
  messages: readonly Message[]
  stash?: Record<string, JSONValue>
  model: string
  thinking: string | boolean | null
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
  stream(prompt: string | ContentBlockData[]): AsyncGenerator<ChatEvent, ChatRunResult, undefined>
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
  queueSteering?(prompt: string, onConsumed: () => void): boolean
  /** Completes after consumed callbacks; removes and returns all unconsumed prompts. */
  drainSteering?(): string[] | Promise<string[]>
  generateSessionName?(cancelSignal: AbortSignal): Promise<string>
  forkState?(): ChatForkState
  forkStash?(): Promise<Record<string, JSONValue> | undefined>
  captureConversation?(): Promise<Snapshot>
  modelSelection?(): ChatConversation['selection']
  sourceSelection?(): ChatConversation['sourceSelection']
  watchTasks?(listener: (tasks: readonly ChatTask[]) => void): () => void
  watchPermissions?(listener: (request: ChatPermissionRequest | undefined) => void): () => void
  permissionStatus?(): ChatPermissionStatus | undefined
  setPermissionMode?(mode: ChatPermissionMode): Promise<void>
  allowPermission?(toolName: string): Promise<void>
  removeAllowedPermission?(toolName: string): Promise<void>
  removeDeniedPermission?(rule: string): Promise<void>
  /** Summarizes older conversation context and returns the new context usage, or undefined when nothing changed. */
  compact?(): Promise<ChatContextUsage | undefined>
  clear?(): Promise<void>
  hasReadyBackgroundResults?(): boolean
  streamBackgroundResults?(): AsyncGenerator<ChatEvent, ChatRunResult, undefined>
  getTaskActivity?(taskId: string): BackgroundAgentActivity | undefined
  watchTaskActivity?(taskId: string, listener: (activity: BackgroundAgentActivity | undefined) => void): () => void
  respondPermission?(requestId: string, optionId?: string, rule?: string): boolean | Promise<boolean>
  dispose?(): void | Promise<void>
}

export type ChatEntry =
  | {
      id: string
      type: 'user'
      text: string
    }
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
  attachments?: readonly ChatAttachmentSummary[]
  agentName: string
  source?: 'background' | 'peer'
  peer?: PeerMessage['from']
  entries: readonly ChatEntry[]
  status: 'running' | 'complete' | 'cancelled' | 'error'
  durationMs?: number
  usage?: TokenUsage
  stopReason?: string
  error?: string
  recoveryHint?: string
  responseDelayed?: boolean
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
