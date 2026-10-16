import { join, resolve } from 'node:path'
import { setImmediate } from 'node:timers'

import {
  effortSlider,
  permissionChoosesScope,
  permissionRequestRows,
  type PermissionStage,
  formatPermissionPanelBody,
  formatTaskActivity,
  modelFilters,
  taskDetailRows,
  taskDetailTitle,
  settingsCategoryFilters,
  settingsRows,
  taskRows,
  sanitizeRows,
  makePanel,
  modelRows,
  sessionFilters,
  sessionRows,
  skillRows,
  skillDetailRows,
  permissionPreset,
  permissionSettingsRows,
  permissionSettingsSlider,
  builtinToolRows,
  mcpRows,
  mcpOptions,
  BACKGROUND_TASK_WAIT_TOGGLE,
  SETTINGS_SETUP_ACTION,
} from './panels.js'
import {
  commandAssistance as resolveCommandAssistance,
  LOCAL_COMMAND_NAMES,
  parseCommandInvocation,
  type CommandAssistance,
  type LocalCommandSpec,
} from './commands.js'
import { helpRows } from './help.js'
import {
  DEFAULT_CHAT_SETTINGS,
  DEFAULT_SETTINGS_CATEGORY,
  SETTINGS_CATEGORIES,
  parseSettingUpdate,
} from '../settings.js'
import { agentLaunchCommand } from '../project/import.js'
import { exportDirectoryName, type AgentProjectOutput } from '../project/export.js'
import { type ChatSessionRuntime, type SessionTarget } from '../session/sessions.js'
import { sessionResumeCommand, type ResumeSession } from '../session/resume.js'
import { unquote } from '../session/conversation-helpers.js'
import type { ChatSkillsRuntime, SkillActivation, SkillInfo } from '../skills.js'
import type { LoadedMcp, McpServerInfo } from '../mcp.js'
import { mcpFailure } from '../mcp/diagnostics.js'
import { type PeerMessage } from '../messaging.js'
import { modelDisplayName } from '../model/display.js'
import { modelControlErrorMessage } from '../model/selection.js'
import { presentChatStream, type StreamPresentationOptions } from '../stream-presentation.js'
import { errorMessage, sanitizeTerminalText } from '../terminal/sanitize.js'
import { canUseNativePicker, chooseDirectory } from '../terminal/directory-picker.js'
import { copyTerminalText } from '../terminal/terminal.js'
import { expandHome, strandsUserPath } from '../paths.js'
import { attachmentContent } from '../attachments.js'
import { configurationDiffs, sanitizeConfigurationSource } from '../configuration-source.js'
import {
  cloneRuntime,
  cloneTask,
  isConfigurationTool,
  isUnresolvedBackgroundTask,
  readTaskValue,
  readyBackgroundGeneration,
} from './controller-helpers.js'
import { TurnProjector, projectMessages } from './projector.js'
import {
  type ChatBackend,
  type ChatAttachment,
  type ChatInput,
  type ChatInputWithAttachments,
  type ChatContextUsage,
  type ChatControllerApi,
  type ChatConversation,
  type ChatConfigurationBaseline,
  type ChatConfigurationDiffs,
  type ChatConfigurationLanguage,
  type ChatConfigurationSource,
  type ChatControllerOptions,
  type ChatEvent,
  type ChatNotice,
  type ChatPanel,
  type ChatPanelRow,
  type ChatPermissionMode,
  type ChatPermissionRequest,
  type ChatRunResult,
  type ChatMcpStartup,
  type ChatRuntimeInfo,
  type ChatSettings,
  type ChatSnapshot,
  type ChatTask,
  type ChatTurn,
  type NewChatPanel,
  type ChatPermissionPreset,
} from './types.js'

export * from './types.js'

const EXIT_WORDS = new Set(['exit', 'quit', '/exit'])
const LIVE_LOCAL_COMMAND_NAMES = new Set(['help', 'settings', 'context', 'model', 'config'])
const MAX_PENDING_PEER_MESSAGES = 32
const TOOL_OUTPUT_EMIT_INTERVAL_MS = 32
const RESPONSE_DELAY_NOTICE_MS = 30_000

const EXPORT_PYTHON = 'export:python'
const EXPORT_TYPESCRIPT = 'export:typescript'
const EXPORT_NAME_PREFIX = 'export:name:'
const EXPORT_SAVE_DEFAULT_PREFIX = 'export:save-default:'
const EXPORT_SAVE_CUSTOM_PREFIX = 'export:save-custom:'

type SessionList = Awaited<ReturnType<ChatSessionRuntime['list']>>

interface PendingUserSubmission {
  kind: 'user'
  id: string
  input: ChatInputWithAttachments
  resolve: (turn: ChatTurn | undefined) => void
}

type PendingSubmission = PendingUserSubmission | { kind: 'peer'; id: string; message: PeerMessage }
type PendingSteering = { prompt: string }

export class ChatController implements ChatControllerApi {
  readonly peerEndpointId: string | undefined
  private readonly _listeners = new Set<() => void>()
  private _completedTurns: ChatTurn[] = []
  private readonly _panelStack: ChatPanel[] = []
  private readonly _skillDetails = new Map<string, SkillInfo>()
  private readonly _sessions: ChatSessionRuntime | undefined

  private _sessionCache: SessionList | undefined
  private _sessionRefresh: Promise<SessionList> | undefined
  private _sessionGeneration = 0
  private _sessionNaming: AbortController | undefined
  private _sessionRename: Promise<unknown> = Promise.resolve()
  private readonly _skills: ChatSkillsRuntime | undefined
  private _skillRefresh: Promise<readonly SkillInfo[]> | undefined
  private readonly _skillNames = new Set<string>()
  private readonly _mcp: LoadedMcp | undefined
  private readonly _mcpDetails = new Map<string, McpServerInfo>()
  private _mcpStartup: ChatMcpStartup | undefined
  private _stopWatchingMcpStartup: (() => void) | undefined
  private _settings: ChatSettings
  private readonly _streamPresentation: StreamPresentationOptions | undefined
  private readonly _setSettings: ((settings: Partial<ChatSettings>) => Promise<void>) | undefined
  private readonly _requestSetup: ChatControllerOptions['requestSetup']
  private readonly _builtinTools: ChatControllerOptions['builtinTools']
  private _builtinToolSelection = new Set<string>()
  private readonly _exportAgentProject: ChatControllerOptions['exportAgentProject']
  private readonly _useExportedProject: ChatControllerOptions['useExportedProject']
  private readonly _configurationSource: ChatControllerOptions['configurationSource']
  private readonly _project: ChatControllerOptions['project']
  private readonly _copyText: (text: string) => Promise<boolean>
  private _exportedPath: string | undefined
  private _configuration: ChatConfigurationSource | undefined
  private _configurationDiffs: ChatConfigurationDiffs | undefined
  /** The configuration before the first change of a turn; diffs accumulate against it for the rest of that turn. */
  private _configurationBaseline: ChatConfigurationBaseline | undefined

  private readonly _backend: ChatBackend
  private _activeProjector: TurnProjector | undefined
  private _drainingProjector: TurnProjector | undefined
  private _presentationAbort: AbortController | undefined
  private readonly _pendingSubmissions: PendingSubmission[] = []
  private readonly _pendingSteering: PendingSteering[] = []
  private _pendingSubmissionRun: Promise<void> | undefined
  private _stopWatchingTasks: (() => void) | undefined
  private _stopWatchingPermissions: (() => void) | undefined
  private _stopWatchingTaskActivity: (() => void) | undefined
  private readonly _usageSubscriptions = new Set<() => void>()
  private _usageGeneration = 0
  private _taskDetailRefreshTimer: ReturnType<typeof setTimeout> | undefined
  private _tasks: ChatTask[] = []
  private _taskBaselineReady = false
  private _backgroundContinuationPending = false
  private _backgroundContinuationRun: Promise<void> | undefined
  private readonly _deliveredBackgroundTaskIds = new Set<string>()
  private _openTaskDetailId: string | undefined
  private _notices: ChatNotice[] = []
  private _context: ChatContextUsage
  private _attemptedBackgroundGeneration: string | undefined
  private _panel: ChatPanel | undefined
  private _deferredModelRestart: string | undefined
  private _deferredModelNoticeId: string | undefined
  private _resourceChanging = false
  private _composerStatus: string | undefined
  private _closed = false
  private _exitCode: number | undefined
  private _hardExitCode: number | undefined
  private _nextTurn: number
  private _nextNotice = 1
  private _nextPanel = 1
  private _nextSubmission = 1
  private _runtime: ChatRuntimeInfo
  private _permissionMode: ChatPermissionMode | undefined
  private _permissionPreset: ChatPermissionPreset | undefined
  private _snapshot: ChatSnapshot

  constructor(backend: ChatBackend, options: ChatControllerOptions = {}) {
    this.peerEndpointId = options.peerEndpointId
    this._backend = backend
    this._sessions = options.sessions
    this._skills = options.skills
    for (const name of options.skillNames ?? []) {
      this._skillNames.add(name.toLowerCase())
    }
    this._mcp = options.mcp
    this._watchMcpStartup()
    this._settings = globalThis.structuredClone({ ...DEFAULT_CHAT_SETTINGS, ...options.settings })
    this._streamPresentation = options.streamPresentation
    this._setSettings = options.setSettings
    this._requestSetup = options.requestSetup
    this._builtinTools = options.builtinTools
    this._exportAgentProject = options.exportAgentProject
    this._useExportedProject = options.useExportedProject
    this._configurationSource = options.configurationSource
    this._project = options.project
    this._copyText = options.copyText ?? copyTerminalText
    const info = backend.info?.()
    const permissionStatus = backend.permissionStatus?.()
    this._permissionMode = permissionStatus?.mode
    this._permissionPreset = permissionStatus ? permissionPreset(permissionStatus) : undefined
    this._runtime = {
      agent: backend.name,
      version: 'development',
      backendId: backend.id,
      protocol: backend.protocol,
      model: info?.model ?? 'unknown',
      ...(info?.effort !== undefined ? { effort: info.effort } : {}),
      session: 'in-memory',
      cwd: process.cwd(),
      tools: info?.tools ?? [],
      ...options.runtime,
    }
    if (options.initialTurns) {
      this._completedTurns = [...options.initialTurns]
    } else if (options.initialMessages) {
      this._completedTurns.push(...projectMessages(options.initialMessages, backend.name))
    }
    this._nextTurn = this._completedTurns.length + 1
    this._context = { ...(backend.contextUsage?.() ?? {}) }
    this._refreshConfiguration()
    if (options.initialConfigurationBaseline && this._configuration) {
      this._configurationBaseline = options.initialConfigurationBaseline
      this._configurationDiffs = configurationDiffs(options.initialConfigurationBaseline.source, this._configuration)
    }
    this._snapshot = this._createSnapshot()
    this._stopWatchingTasks = this._backend.watchTasks?.((tasks) => {
      if (this._closed) {
        return
      }
      this._setTasks(tasks)
      this._emit()
    })
    if (!this._stopWatchingTasks) {
      this._taskBaselineReady = true
    }
    this._stopWatchingPermissions = this._backend.watchPermissions?.((request) => {
      if (this._closed || this._backend.protocol !== 'strands') {
        return
      }
      if (request) {
        this._openPermissionPanel(request)
      } else {
        this._closePermissionPanel()
      }
    })
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener)
    return () => {
      this._listeners.delete(listener)
    }
  }

  readonly getSnapshot = (): ChatSnapshot => this._snapshot

  async captureConversation(): Promise<ChatConversation> {
    if (!this._backend.captureConversation) {
      throw new Error('This agent cannot transfer its conversation.')
    }
    if (this.busy || this._hasUnresolvedBackgroundTasks()) {
      throw new Error('Finish or cancel running work before applying setup changes.')
    }
    const session = this._backend.sessionIdentity
    const sourceSelection = this._backend.sourceSelection?.()
    return {
      snapshot: await this._backend.captureConversation(),
      completedTurns: [...this._completedTurns],
      ...(this._configurationBaseline ? { configurationBaseline: this._configurationBaseline } : {}),
      model: this._runtime.model,
      ...(session ? { session } : {}),
      ...(sourceSelection ? { sourceSelection } : {}),
    }
  }

  showError(title: string, message: string): void {
    this._openError(title, '', message)
  }

  get backend(): ChatBackend {
    return this._backend
  }

  get busy(): boolean {
    return (
      this._activeProjector !== undefined ||
      this._drainingProjector !== undefined ||
      this._pendingSubmissions.length > 0 ||
      this._pendingSubmissionRun !== undefined ||
      this._resourceChanging
    )
  }

  get hardExitCode(): number | undefined {
    return this._hardExitCode
  }

  get resumeSession(): ResumeSession | undefined {
    const session = this._sessions?.currentTarget ?? this._backend.sessionIdentity
    if (!session?.sessionId) return undefined
    return {
      sessionId: session.sessionId,
      sessionDirectory: session.sessionDirectory,
      workspace: session.workspace,
      ...(this._project ? { agentProject: this._project.entrypoint } : {}),
    }
  }

  actionableCommandToken(input: string): string | undefined {
    if (input.startsWith('!')) {
      return '!'
    }
    const invocation = parseCommandInvocation(input)
    if (!invocation) {
      return undefined
    }
    if (invocation.prefix === '/' && LOCAL_COMMAND_NAMES.has(invocation.name.toLowerCase())) {
      return invocation.token
    }
    return this._backend.protocol === 'strands' && this._skillNames.has(invocation.name.toLowerCase())
      ? invocation.token
      : undefined
  }

  commandAssistance(input: string): CommandAssistance | undefined {
    // Runs per render; skip the skill-command materialization for the common non-command input.
    if (!input.startsWith('/')) {
      return undefined
    }
    return resolveCommandAssistance(input, this.actionableCommandToken(input), this._skillCommands())
  }

  async start(firstRequest?: string): Promise<void> {
    setImmediate(() => void this._discoverSkillNames())
    if (firstRequest) {
      const prompt = firstRequest.trim()
      if (prompt.startsWith('!')) {
        await this._executeSubmission(prompt)
      } else {
        await this._runPrompt(prompt)
      }
    }
  }

  private async _discoverSkillNames(): Promise<void> {
    if (!this._skills || this._backend.protocol !== 'strands') {
      return
    }
    try {
      this._rememberSkills(await this._listSkills())
      this._emit()
    } catch {
      // /skills reports discovery failures when the user opens it.
    }
  }

  private _listSkills(): Promise<readonly SkillInfo[]> {
    if (this._skillRefresh) {
      return this._skillRefresh
    }
    const refresh = this._skills!.list()
    this._skillRefresh = refresh
    const clearRefresh = (): void => {
      if (this._skillRefresh === refresh) {
        this._skillRefresh = undefined
      }
    }
    void refresh.then(clearRefresh, clearRefresh)
    return refresh
  }

  private _rememberSkills(skills: readonly SkillInfo[]): void {
    this._skillDetails.clear()
    for (const skill of skills) {
      this._skillDetails.set(skill.name, skill)
      this._skillNames.add(skill.name.toLowerCase())
    }
  }

  private _skillCommands(): LocalCommandSpec[] {
    return [...this._skillDetails.values()].map((skill) => ({
      name: skill.name,
      usage: `/${skill.name} [request]`,
      description: skill.description,
    }))
  }

  async submit(input: ChatInput): Promise<ChatTurn | undefined> {
    const submission = normalizeChatInput(input)
    const { text: prompt, attachments } = submission
    if ((!prompt && attachments.length === 0) || this._closed) {
      return undefined
    }
    // The failure reminder has been on screen while the user typed; any submission counts as seen.
    if (this._mcpStartup?.settled) {
      this._mcpStartup = undefined
    }
    if (attachments.length === 0 && EXIT_WORDS.has(prompt.toLowerCase())) {
      this.close()
      return undefined
    }
    if (
      attachments.length === 0 &&
      isLiveLocalCommand(prompt) &&
      !this._resourceChanging &&
      (this._panel?.kind !== 'permission' || parseCommandInvocation(prompt)?.name.toLowerCase() === 'settings')
    ) {
      return this._executeSubmission(prompt)
    }
    if (
      this._activeProjector ||
      this._drainingProjector ||
      this._pendingSubmissionRun ||
      this._pendingSubmissions.length > 0
    ) {
      return this._enqueueSubmission(submission)
    }
    if (this._resourceChanging) {
      return undefined
    }
    return this._executeSubmission(submission)
  }

  enqueuePeerMessage(message: PeerMessage): boolean {
    if (
      this._closed ||
      this._resourceChanging ||
      !this._backend.streamPeer ||
      this._pendingSubmissions.filter((pending) => pending.kind === 'peer').length >= MAX_PENDING_PEER_MESSAGES
    ) {
      return false
    }
    this._pendingSubmissions.push({
      kind: 'peer',
      id: `queued-${this._nextSubmission++}`,
      message,
    })
    this._emit()
    this._startPendingSubmissions()
    return true
  }

  async steer(input: string): Promise<ChatTurn | undefined> {
    const prompt = input.trim()
    if (!prompt || this._closed) {
      return undefined
    }
    if (EXIT_WORDS.has(prompt.toLowerCase())) {
      this.close()
      return undefined
    }
    if (prompt.startsWith('!')) {
      return this.busy ? this._enqueueSubmission(prompt) : this._executeSubmission(prompt)
    }
    if (
      this._resourceChanging &&
      !this._activeProjector &&
      !this._drainingProjector &&
      !this._pendingSubmissionRun &&
      this._pendingSubmissions.length === 0
    ) {
      return undefined
    }
    if (!this.busy) {
      return this._executeSubmission(prompt)
    }
    if (this._queueLiveSteering(prompt)) {
      return undefined
    }
    const pending = this._enqueueSubmission(prompt, true)
    this.cancel()
    return pending
  }

  updateQueuedPrompt(id: string, prompt: string): boolean {
    const normalized = prompt.trim()
    const pending = this._pendingSubmissions.find(
      (candidate): candidate is PendingUserSubmission => candidate.kind === 'user' && candidate.id === id
    )
    if (!pending || (!normalized && pending.input.attachments.length === 0)) {
      return false
    }
    pending.input = { ...pending.input, text: normalized }
    this._emit()
    return true
  }

  moveQueuedPrompt(id: string, direction: -1 | 1): boolean {
    const userIndexes = this._pendingSubmissions.flatMap((pending, index) => (pending.kind === 'user' ? [index] : []))
    const position = userIndexes.findIndex((index) => this._pendingSubmissions[index]?.id === id)
    const currentIndex = userIndexes[position]
    const targetIndex = userIndexes[position + direction]
    if (currentIndex === undefined || targetIndex === undefined) {
      return false
    }
    const current = this._pendingSubmissions[currentIndex]!
    this._pendingSubmissions[currentIndex] = this._pendingSubmissions[targetIndex]!
    this._pendingSubmissions[targetIndex] = current
    this._emit()
    return true
  }

  private async _executeSubmission(input: ChatInput): Promise<ChatTurn | undefined> {
    const submission = normalizeChatInput(input)
    const { text: prompt, attachments } = submission
    if (attachments.length > 0) {
      return this._runPrompt(submission)
    }
    if (prompt.startsWith('!')) {
      return this._runShellCommand(prompt)
    }
    const directSkill = prompt.startsWith('$') ? parseCommandInvocation(prompt) : undefined
    if (directSkill) {
      const turn = await this._activateSkillAndRun(directSkill.name, prompt)
      if (turn === null) {
        this._openError('unknown skill', `$${directSkill.name}`, 'Use /skills to list available skills.')
        return undefined
      }
      return turn
    }
    if (prompt.startsWith('/')) {
      await this._handleCommand(prompt)
      return undefined
    }
    return this._runPrompt(prompt)
  }

  private async _runShellCommand(prompt: string): Promise<ChatTurn | undefined> {
    const command = prompt.slice(1).trim()
    if (!command) {
      this._openError('shell command required', '!', 'Use !<command> to run a command in the active sandbox.')
      return undefined
    }
    if (!this._backend.streamShell) {
      this._openError(
        'shell unavailable',
        `!${command}`,
        'The active backend does not expose a sandbox. Switch to the built-in Strands connection.'
      )
      return undefined
    }
    this._panel = undefined
    this._panelStack.length = 0
    return this._runStream(prompt, this._backend.streamShell(command), 'shell')
  }

  private async _runPrompt(input: ChatInput, displayPrompt?: string): Promise<ChatTurn | undefined> {
    if (this._closed || this._activeProjector || this._drainingProjector || this._resourceChanging) {
      return undefined
    }
    const submission = normalizeChatInput(input)
    this._panel = undefined
    this._panelStack.length = 0
    const prompt =
      submission.attachments.length === 0 ? submission.text : attachmentContent(submission.text, submission.attachments)
    return this._runStream(
      displayPrompt ?? submission.text,
      this._backend.stream(prompt),
      'model',
      undefined,
      undefined,
      submission.attachments
    )
  }

  private async _runPeerMessage(message: PeerMessage): Promise<ChatTurn | undefined> {
    if (
      this._closed ||
      this._activeProjector ||
      this._drainingProjector ||
      this._resourceChanging ||
      !this._backend.streamPeer
    ) {
      return undefined
    }
    this._panel = undefined
    this._panelStack.length = 0
    return this._runStream(message.body, this._backend.streamPeer(message), 'model', 'peer', message.from)
  }

  private async _runBackgroundContinuation(): Promise<void> {
    if (
      this._closed ||
      this._activeProjector !== undefined ||
      this._drainingProjector !== undefined ||
      this._pendingSubmissionRun !== undefined ||
      this._resourceChanging ||
      this._pendingSubmissions.some((pending) => pending.kind === 'user') ||
      !this._backend.streamBackgroundResults ||
      !this._backend.hasReadyBackgroundResults?.()
    ) {
      return
    }
    await this._runStream('', this._backend.streamBackgroundResults(), 'model', 'background')
  }

  private async _runStream(
    prompt: string,
    source: AsyncGenerator<ChatEvent, ChatRunResult, undefined>,
    mode: 'model' | 'shell',
    turnSource?: ChatTurn['source'],
    peer?: ChatTurn['peer'],
    attachments?: readonly ChatAttachment[]
  ): Promise<ChatTurn> {
    const turnId = `turn-${this._nextTurn++}`
    const projector = new TurnProjector(turnId, prompt, this._backend.name, turnSource, peer, attachments)
    const usageGeneration = this._usageGeneration
    const presentationAbort = new AbortController()
    let toolOutputEmitTimer: ReturnType<typeof setTimeout> | undefined
    let responseDelayTimer: ReturnType<typeof setTimeout> | undefined
    const runningTools = new Set<string>()
    const resetResponseDelay = (event?: ChatEvent): void => {
      if (event?.type === 'tasks') return
      clearTimeout(responseDelayTimer)
      projector.setResponseDelayed(false)
      if (event?.type === 'toolStart' && !event.background) runningTools.add(event.toolUseId)
      if (event?.type === 'toolResult') runningTools.delete(event.toolUseId)
      if (mode === 'shell' || runningTools.size > 0 || event?.type === 'permission') return
      responseDelayTimer = setTimeout(() => {
        if (this._activeProjector !== projector) return
        projector.setResponseDelayed(true)
        this._emit()
      }, RESPONSE_DELAY_NOTICE_MS)
    }
    const emitStreamEvent = (event: ChatEvent): void => {
      if (event.type !== 'toolOutputDelta') {
        clearTimeout(toolOutputEmitTimer)
        toolOutputEmitTimer = undefined
        this._emit()
        return
      }
      toolOutputEmitTimer ??= setTimeout(() => {
        toolOutputEmitTimer = undefined
        this._emit()
      }, TOOL_OUTPUT_EMIT_INTERVAL_MS)
    }
    this._activeProjector = projector
    this._presentationAbort = presentationAbort
    resetResponseDelay()
    this._emit()

    const contextBeforeTurn = { ...this._context }
    try {
      const turnContext: ChatContextUsage = {}
      const stream = this._streamPresentation
        ? presentChatStream(source, this._streamPresentation, presentationAbort.signal)
        : source
      let next = await stream.next()
      while (!next.done) {
        this._handleEvent(projector, next.value, turnContext)
        resetResponseDelay(next.value)
        emitStreamEvent(next.value)
        next = await stream.next()
      }
      projector.finish(next.value)
      if (next.value.context || Object.keys(turnContext).length > 0) {
        this._context = { ...turnContext, ...next.value.context }
      }
      if (next.value.watchUsage && !this._closed && usageGeneration === this._usageGeneration) {
        this._watchTurnUsage(turnId, projector, next.value.watchUsage)
      }
    } catch (error) {
      this._context = contextBeforeTurn
      const recovery = mode === 'shell' ? undefined : this._failureRecoveryHint(error)
      projector.fail(error, recovery)
    } finally {
      clearTimeout(toolOutputEmitTimer)
      clearTimeout(responseDelayTimer)
      this._queueUndeliveredSteering(this._backend.drainSteering?.() ?? [])
      const wasDetachedByCancellation = this._drainingProjector === projector
      if (!wasDetachedByCancellation) {
        this._completedTurns.push(projector.snapshot())
      }
      if (this._activeProjector === projector) {
        this._activeProjector = undefined
      }
      if (wasDetachedByCancellation) {
        this._drainingProjector = undefined
      }
      this._clearDeliveredBackgroundTaskNotices()
      if (this._presentationAbort === presentationAbort) {
        this._presentationAbort = undefined
      }
      this._emit()
      if (!this._closed) {
        await this._applyDeferredModelRestart()
        this._startBackgroundContinuation()
        this._startPendingSubmissions()
      }
    }

    return projector.snapshot()
  }

  private _failureRecoveryHint(error: unknown): string {
    const message = errorMessage(error)
    const credentials = /credentials?|expiredtoken|security token|sso.*expired/i.test(message)
    const guidance = credentials
      ? 'Refresh your credentials, then resend your message.'
      : 'Check your connection and provider, then resend your message.'
    const session = this.resumeSession
    return session ? `${guidance}\nTo resume after restarting: ${sessionResumeCommand(session)}` : guidance
  }

  private _watchTurnUsage(
    turnId: string,
    projector: TurnProjector,
    watch: NonNullable<ChatRunResult['watchUsage']>
  ): void {
    let active = true
    let unsubscribe = (): void => {}
    const stop = (): void => {
      active = false
      unsubscribe()
      this._usageSubscriptions.delete(stop)
    }
    unsubscribe = watch((usage) => {
      if (!active) {
        return
      }
      stop()
      if (this._closed || !usage) {
        return
      }
      projector.setUsage(usage)
      const index = this._completedTurns.findIndex((turn) => turn.id === turnId)
      if (index >= 0) {
        this._completedTurns[index] = { ...this._completedTurns[index]!, usage: { ...usage } }
      }
      if (
        this._activeProjector === projector ||
        (!this._activeProjector && this._completedTurns.at(-1)?.id === turnId)
      ) {
        const { currentTokens, projectedTokens, contextWindow, breakdown } = this._context
        this._context = {
          ...(currentTokens !== undefined ? { currentTokens } : {}),
          ...(projectedTokens !== undefined ? { projectedTokens } : {}),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(breakdown ? { breakdown } : {}),
          ...usage,
        }
      }
      this._emit()
    })
    if (active) {
      this._usageSubscriptions.add(stop)
    } else {
      unsubscribe()
    }
  }

  private _stopWatchingUsage(): void {
    this._usageGeneration++
    for (const stop of this._usageSubscriptions) {
      stop()
    }
  }

  cancel(): boolean {
    if (this._activeProjector) {
      const undeliveredSteering = this._backend.drainSteering?.() ?? []
      const projector = this._activeProjector
      projector.markCancelled()
      this._completedTurns.push(projector.snapshot())
      this._activeProjector = undefined
      this._drainingProjector = projector
      this._presentationAbort?.abort()
      this._backend.cancel()
      this._queueUndeliveredSteering(undeliveredSteering)
      this._emit()
      return true
    }
    if (this._drainingProjector) {
      this._presentationAbort?.abort()
      this._backend.cancel()
      return true
    }
    return false
  }

  close(exitCode = 0): void {
    if (this._closed) {
      return
    }
    this._closed = true
    this._sessionNaming?.abort()
    this._stopWatchingUsage()
    this._backgroundContinuationPending = false
    const interrupted = this._activeProjector !== undefined || this._drainingProjector !== undefined
    this._exitCode = interrupted && exitCode === 0 ? 130 : exitCode
    if (interrupted) {
      this._hardExitCode = this._exitCode
      this._activeProjector?.markCancelled()
      this._presentationAbort?.abort()
      this._backend.drainSteering?.()
      this._pendingSteering.length = 0
      this._backend.cancel()
    }
    this._resolvePendingSubmissions()
    this._emit()
  }

  async dispose(): Promise<void> {
    this._sessionNaming?.abort()
    this._stopWatchingUsage()
    if (this._activeProjector || this._drainingProjector) {
      this._presentationAbort?.abort()
      this._backend.drainSteering?.()
      this._pendingSteering.length = 0
      this._backend.cancel()
    }
    this._resolvePendingSubmissions()
    this._stopWatchingMcpStartup?.()
    this._stopWatchingMcpStartup = undefined
    this._stopWatchingTasks?.()
    this._stopWatchingTasks = undefined
    this._stopWatchingPermissions?.()
    this._stopWatchingPermissions = undefined
    this._stopTaskActivity()
    this._listeners.clear()
    await Promise.allSettled([Promise.resolve().then(() => this._backend.dispose?.()), this._mcp?.dispose()])
  }

  private _enqueueSubmission(input: ChatInput, priority = false): Promise<ChatTurn | undefined> {
    return new Promise((resolve) => {
      const pending: PendingUserSubmission = {
        kind: 'user',
        id: `queued-${this._nextSubmission++}`,
        input: normalizeChatInput(input),
        resolve,
      }
      if (priority) {
        this._pendingSubmissions.unshift(pending)
      } else {
        this._pendingSubmissions.push(pending)
      }
      this._emit()
      this._startPendingSubmissions()
    })
  }

  private _queueLiveSteering(prompt: string): boolean {
    if (!this._activeProjector || !this._backend.queueSteering) {
      return false
    }
    const projector = this._activeProjector
    let receipt: PendingSteering | undefined
    let consumed = false
    const queued = this._backend.queueSteering(prompt, () => {
      if (consumed) {
        return
      }
      consumed = true
      projector.appendUserMessage(prompt)
      if (receipt) {
        const index = this._pendingSteering.indexOf(receipt)
        if (index >= 0) {
          this._pendingSteering.splice(index, 1)
        }
      }
      this._emit()
    })
    if (!queued) {
      return false
    }
    if (consumed) {
      return true
    }
    receipt = { prompt }
    this._pendingSteering.push(receipt)
    this._emit()
    return true
  }

  private _queueUndeliveredSteering(prompts: readonly string[]): void {
    for (const prompt of prompts) {
      const index = this._pendingSteering.findIndex((pending) => pending.prompt === prompt)
      if (index >= 0) {
        this._pendingSteering.splice(index, 1)
      }
    }
    for (const prompt of [...prompts].reverse()) {
      void this._enqueueSubmission(prompt, true)
    }
  }

  private _startPendingSubmissions(): void {
    if (
      this._pendingSubmissionRun ||
      this._pendingSubmissions.length === 0 ||
      this._closed ||
      this._activeProjector ||
      this._drainingProjector ||
      this._resourceChanging
    ) {
      return
    }
    const run = this._drainPendingSubmissions()
    this._pendingSubmissionRun = run
    void run.finally(() => {
      if (this._pendingSubmissionRun === run) {
        this._pendingSubmissionRun = undefined
      }
      this._startBackgroundContinuation()
      this._startPendingSubmissions()
      this._emit()
    })
  }

  private async _drainPendingSubmissions(): Promise<void> {
    while (!this._closed && !this._activeProjector && !this._drainingProjector && !this._resourceChanging) {
      if (
        !this._pendingSubmissions.some((pending) => pending.kind === 'user') &&
        this._backgroundContinuationPending &&
        this._backend.hasReadyBackgroundResults?.()
      ) {
        return
      }
      const pending = this._pendingSubmissions.shift()
      if (!pending) {
        return
      }
      this._panel = undefined
      this._panelStack.length = 0
      if (pending.kind === 'peer') {
        await this._runPeerMessage(pending.message)
      } else {
        const turn = await this._executeSubmission(pending.input)
        pending.resolve(turn)
      }
    }
  }

  private _resolvePendingSubmissions(): void {
    for (const pending of this._pendingSubmissions.splice(0)) {
      if (pending.kind === 'user') {
        pending.resolve(undefined)
      }
    }
  }

  dismissPanel(): boolean {
    if (!this._panel || this._resourceChanging || this._panel.kind === 'permission') {
      return false
    }
    if (this._panel.kind === 'tools' && !this._applyBuiltinTools()) {
      return true
    }
    this._stopTaskActivity()
    this._panel = this._panelStack.pop()
    this._emit()
    return true
  }

  async setSettings(settings: Partial<ChatSettings>): Promise<boolean> {
    return this._applySettings(settings, 'settings')
  }

  async activatePanelRow(row: ChatPanelRow): Promise<boolean> {
    if (!this._panel || !row.value || this._resourceChanging) {
      return false
    }
    switch (this._panel.kind) {
      case 'help': {
        const selected = this._panel.rows.find((candidate) => candidate.value === row.value)
        if (!selected) {
          return false
        }
        if (row.value.startsWith('help:command:')) {
          await this.submit(`/${row.value.slice('help:command:'.length)}`)
        } else {
          this._pushPanel({ kind: 'help-detail', title: selected.label, rows: [], body: selected.description })
        }
        return true
      }
      case 'effort':
      case 'models':
        return row.value.startsWith('effort:')
          ? this._selectEffort(row.value.slice('effort:'.length))
          : this._selectModel(row.value)
      case 'tasks':
        return row.value === BACKGROUND_TASK_WAIT_TOGGLE
          ? this._toggleBackgroundTaskWaitMode()
          : this._openTaskDetail(row.value)
      case 'permissions':
        return this._updatePermissions(row.value)
      case 'tools':
        return this._toggleBuiltinTool(row.value)
      case 'mcp':
        return row.value.startsWith('mcp:toggle:') ? this._toggleMcpServer(row.value) : false
      case 'settings':
        if (row.value === SETTINGS_SETUP_ACTION) {
          if (!this._requestSetup) {
            return false
          }
          this._requestSetup()
          return true
        }
        return row.value.startsWith('settings:')
          ? this._openSettingsCategory(row.value)
          : this._updateSetting(row.value)
      case 'export':
        if (row.value === 'export:copy-path' || row.value === 'export:copy-command') {
          return this._copyExport(row.value)
        }
        if (row.value === 'export:use-project') {
          return this._useExported()
        }
        if (row.value === EXPORT_TYPESCRIPT || row.value === EXPORT_PYTHON) {
          this._openExportNamePanel(row.value === EXPORT_TYPESCRIPT ? 'typescript' : 'python')
          return true
        }
        if (row.value.startsWith(EXPORT_NAME_PREFIX)) {
          const [language, encodedName = ''] = row.value.slice(EXPORT_NAME_PREFIX.length).split(':')
          if (language !== 'typescript' && language !== 'python') {
            return false
          }
          this._openExportDestinationPanel(language, exportDirectoryName(decodeURIComponent(encodedName)))
          return true
        }
        if (row.value.startsWith(EXPORT_SAVE_DEFAULT_PREFIX) || row.value.startsWith(EXPORT_SAVE_CUSTOM_PREFIX)) {
          const custom = row.value.startsWith(EXPORT_SAVE_CUSTOM_PREFIX)
          const [language, encodedName] = row.value
            .slice((custom ? EXPORT_SAVE_CUSTOM_PREFIX : EXPORT_SAVE_DEFAULT_PREFIX).length)
            .split(':')
          if ((language !== 'typescript' && language !== 'python') || !encodedName) {
            return false
          }
          const name = decodeURIComponent(encodedName)
          if (!custom) {
            return this._exportAgent(language, strandsUserPath('harnesses', name), 'directory')
          }
          const parent = await chooseDirectory(`Choose where to save ${name}`)
          return parent ? this._exportAgent(language, join(parent, name), 'directory') : true
        }
        return false
      case 'permission':
        return this._respondPermission(row.value)
      default:
        return false
    }
  }

  openContextPanel(): void {
    this._openPanel({ kind: 'context', title: 'Context usage', rows: [] })
  }

  refreshConfiguration(resetDiff = false): void {
    if (resetDiff) {
      this._configurationBaseline = undefined
      this._configurationDiffs = undefined
    }
    this._refreshConfiguration(!resetDiff)
    this._emit()
  }

  sessionTarget(reference: string): Promise<SessionTarget | undefined> {
    return this._sessions && this._backend.protocol === 'strands'
      ? this._sessions.resolve(reference)
      : Promise.resolve(undefined)
  }

  sessionResumeBlockReason(): string | undefined {
    if (this.busy) {
      return 'Wait for the current turn and queued work to finish before opening another saved session.'
    }
    if (this._hasUnresolvedBackgroundTasks()) {
      return 'Background work is still running or waiting to be delivered. Finish or cancel it before opening another saved session.'
    }
    return undefined
  }

  private async _rebuildModel(modelId: string): Promise<boolean> {
    if (!this._backend.restartModel) {
      this._openError('model change unavailable', modelId, 'This backend cannot change to this model.')
      return false
    }
    if (this._activeProjector || this._drainingProjector) {
      const supersededModelId = this._deferredModelRestart
      const supersededNotice = this._notices.find((candidate) => candidate.id === this._deferredModelNoticeId)
      if (supersededModelId && supersededNotice) {
        supersededNotice.status = 'delivered'
        supersededNotice.text =
          `Model change to ${modelDisplayName(supersededModelId)} superseded by ` + modelDisplayName(modelId)
      }
      this._deferredModelRestart = modelId
      const notice = this._addNotice(
        'running',
        `Model change queued for after the current turn: ${modelDisplayName(modelId)}`
      )
      this._deferredModelNoticeId = notice.id
      this._emit()
      return true
    }
    this._resourceChanging = true
    try {
      const selected = await this._backend.restartModel(modelId)
      this._context = {}
      this._refreshRuntime(typeof selected === 'string' ? selected : modelId)
      this._updateOpenModelPanel(modelId)
      this._openEffortPanelIfAvailable()
      this._emit()
      return true
    } catch (error) {
      this._openError('model change failed', modelId, modelControlErrorMessage(error, 'model'))
      return false
    } finally {
      this._resourceChanging = false
    }
  }

  private _handleEvent(projector: TurnProjector, event: ChatEvent, turnContext: ChatContextUsage): void {
    if (event.type === 'tasks') {
      this._setTasks(event.tasks)
      return
    }
    if (event.type === 'context') {
      const firstUpdate = Object.keys(turnContext).length === 0
      Object.assign(turnContext, event.usage)
      this._context = firstUpdate ? { ...event.usage } : { ...this._context, ...event.usage }
      return
    }
    if (event.type === 'permission') {
      this._openPermissionPanel(event.request)
      return
    }
    projector.handle(event)
    if (event.type === 'toolStart' && isConfigurationTool(event.name)) {
      if (!this._configurationBaseline || this._configurationBaseline.turnId !== this._configurationTurnId()) {
        this._configurationDiffs = undefined
      }
      this._refreshConfiguration()
    } else if (event.type === 'toolResult' && projector.hasTool(isConfigurationTool)) {
      this._refreshConfiguration(true)
    }
  }

  /** Mirrors background MCP connection progress into the snapshot; failures stay visible until /mcp opens. */
  private _watchMcpStartup(): void {
    const startup = this._mcp?.startup
    if (!startup) {
      return
    }
    const refresh = (): void => {
      const progress = startup.progress()
      const settled = progress.connected + progress.failed >= progress.total
      if (!settled) {
        this._mcpStartup = { ...progress, settled: false }
        return
      }
      this._mcpStartup = progress.failed > 0 ? { ...progress, settled: true } : undefined
      this._stopWatchingMcpStartup?.()
      this._stopWatchingMcpStartup = undefined
    }
    refresh()
    if (!this._mcpStartup || this._mcpStartup.settled) {
      return
    }
    this._stopWatchingMcpStartup = startup.subscribe(() => {
      refresh()
      this._emit()
    })
  }

  private _createSnapshot(): ChatSnapshot {
    const activeTurn = this._activeProjector?.snapshot()
    return {
      completedTurns: [...this._completedTurns],
      ...(activeTurn ? { activeTurn } : {}),
      pendingSteering: this._pendingSteering.map(({ prompt }) => sanitizeTerminalText(prompt)),
      queuedPrompts: this._pendingSubmissions.map((pending) => ({
        id: pending.id,
        prompt: sanitizeTerminalText(pending.kind === 'peer' ? pending.message.body : pending.input.text),
        ...(pending.kind === 'user' && pending.input.attachments.length > 0
          ? {
              attachments: pending.input.attachments.map(({ name, size, kind }) => ({
                name: sanitizeTerminalText(name),
                size,
                kind,
              })),
            }
          : {}),
        ...(pending.kind === 'peer'
          ? {
              source: 'peer' as const,
              from: sanitizeTerminalText(pending.message.from.name),
            }
          : {}),
      })),
      notices: this._notices.map((notice) => ({ ...notice })),
      tasks: this._tasks.map(cloneTask),
      context: { ...this._context },
      status: this._closed ? 'closed' : activeTurn ? 'running' : this._drainingProjector ? 'interrupting' : 'idle',
      ...(this._mcpStartup ? { mcpStartup: { ...this._mcpStartup } } : {}),
      ...(this._composerStatus ? { composerStatus: this._composerStatus } : {}),
      ...(this._panel ? { panel: makePanel(this._panel.id, this._panel) } : {}),
      ...(this._configuration ? { configuration: this._configuration } : {}),
      ...(this._configurationDiffs ? { configurationDiffs: this._configurationDiffs } : {}),
      runtime: cloneRuntime(this._runtime),
      ...(this._permissionMode ? { permissionMode: this._permissionMode } : {}),
      ...(this._permissionPreset ? { permissionPreset: this._permissionPreset } : {}),
      settings: globalThis.structuredClone(this._settings),
      ...(this._exitCode !== undefined ? { exitCode: this._exitCode } : {}),
    }
  }

  private _emit(): void {
    this._snapshot = this._createSnapshot()
    for (const listener of this._listeners) {
      listener()
    }
  }

  private async _handleCommand(prompt: string): Promise<void> {
    const [command = '', ...rest] = prompt.slice(1).trim().split(/\s+/)
    const argument = rest.join(' ')
    switch (command.toLowerCase()) {
      case 'help':
        this._openPanel({
          kind: 'help',
          title: 'Help',
          rows: helpRows(this._backend, {
            sessions: this._sessions !== undefined,
            skills: this._skills !== undefined,
            mcp: this._mcp !== undefined,
            setup: this._requestSetup !== undefined,
            tools: this._builtinTools !== undefined,
            export: this._exportAgentProject !== undefined,
            config: this._configurationSource !== undefined,
          }),
          searchable: true,
          filters: [
            { id: 'controls', label: 'Controls' },
            { id: 'commands', label: 'Commands' },
            { id: 'tools', label: 'Tools' },
            { id: 'all', label: 'All' },
          ],
        })
        break
      case 'context':
        this.openContextPanel()
        break
      case 'compact':
        await this._compactConversation()
        break
      case 'clear':
        await this._clearConversation()
        break
      case 'tasks':
        this._openTasksPanel()
        break
      case 'model':
        await (argument ? this._selectModel(argument) : this.openModelPanel())
        break
      case 'effort':
        if (argument) {
          await this._selectEffort(argument.toLowerCase())
        } else {
          this._openEffortPanel()
        }
        break
      case 'sessions':
        await (argument ? this._handleSessionsCommand(argument) : this._openSessionsPanel())
        break
      case 'rename':
        await this._handleSessionsCommand(`rename${argument ? ` ${argument}` : ''}`)
        break
      case 'skills':
        await this._openSkillsPanel()
        break
      case 'mcp':
        await this._openMcpPanel()
        break
      case 'permissions':
        await this._handlePermissionsCommand(argument)
        break
      case 'settings':
        this._openSettingsCategory(`settings:${DEFAULT_SETTINGS_CATEGORY}`, true)
        break
      case 'config':
        this._openConfigurationPanel(argument)
        break
      case 'setup':
        this._requestSetup?.()
        break
      case 'tools':
        this._openBuiltinToolsPanel()
        break
      case 'export':
        await this._handleExportCommand(parseCommandInvocation(prompt)?.argument ?? '')
        break
      case 'exit':
        this.close()
        break
      default: {
        const turn = await this._activateSkillAndRun(command, prompt)
        if (turn === null) {
          this._openError('unknown command', `/${command}`, 'Type / to browse commands or use /skills to list skills.')
        }
        break
      }
    }
  }

  private _openBuiltinToolsPanel(): void {
    if (!this._builtinTools) {
      this._openError(
        'tools unavailable',
        '/tools',
        this._project
          ? `This agent is defined in ${this._project.entrypoint}. Edit its tools there.`
          : 'Tool selection is not available in this session.'
      )
      return
    }
    const choices = this._builtinTools.choices()
    this._builtinToolSelection = new Set(choices.filter((choice) => choice.enabled).map((choice) => choice.name))
    this._openPanel({ kind: 'tools', title: 'Tools', rows: builtinToolRows(choices, this._builtinToolSelection) })
  }

  private _openConfigurationPanel(argument: string): void {
    const requested = argument.toLowerCase()
    if (requested && requested !== 'typescript' && requested !== 'python') {
      this._openError('unknown configuration language', argument, 'Use /config, /config typescript, or /config python.')
      return
    }
    this._refreshConfiguration()
    if (!this._configuration) {
      this._openError(
        'configuration unavailable',
        '/config',
        'This connection does not expose editable agent configuration.'
      )
      return
    }
    const language = (requested || this._configuration.preferredLanguage) as ChatConfigurationLanguage
    this._openPanel({
      kind: 'config',
      title: 'Configuration',
      rows: [],
      filters: [
        { id: 'typescript', label: 'TypeScript' },
        { id: 'python', label: 'Python' },
      ],
      configuration: this._configuration,
      language,
    })
  }

  private _toggleBuiltinTool(value: string): boolean {
    if (this._panel?.kind !== 'tools' || !this._builtinTools || !value.startsWith('tools:toggle:')) {
      return false
    }
    const name = decodeURIComponent(value.slice('tools:toggle:'.length))
    if (!this._builtinToolSelection.delete(name)) {
      this._builtinToolSelection.add(name)
    }
    // Keeping the panel id keeps the cursor on the toggled row.
    const rows = builtinToolRows(this._builtinTools.choices(), this._builtinToolSelection)
    this._panel = makePanel(this._panel.id, { kind: 'tools', title: 'Tools', rows })
    this._emit()
    return true
  }

  /** Closing `/tools` applies its selection; returns false when the change is blocked. */
  private _applyBuiltinTools(): boolean {
    const choices = this._builtinTools?.choices() ?? []
    if (choices.every((choice) => choice.enabled === this._builtinToolSelection.has(choice.name))) {
      return true
    }
    if (this.busy || this._hasUnresolvedBackgroundTasks()) {
      this._openError('tools not changed', '/tools', 'Finish or cancel running work, then change tools again.')
      return false
    }
    this._builtinTools?.apply([...this._builtinToolSelection])
    return true
  }

  private _openTasksPanel(): void {
    const waitForCompletion = this._backend.backgroundTasksWaitForCompletion?.()
    const tasks = taskRows(this._tasks)
    this._openPanel({
      kind: 'tasks',
      title: `Tasks (${tasks.length})`,
      rows: tasks,
      searchable: true,
      ...(waitForCompletion !== undefined ? { waitForCompletion } : {}),
    })
  }

  private async _toggleBackgroundTaskWaitMode(): Promise<boolean> {
    const current = this._backend.backgroundTasksWaitForCompletion?.()
    if (current === undefined || !this._backend.setBackgroundTasksWaitForCompletion) {
      return false
    }
    if (this._hasUnresolvedBackgroundTasks()) {
      this._openError(
        'task mode change blocked',
        'Wait for completion',
        'Background work is still running or waiting to be delivered. Finish or cancel it before rebuilding the agent.'
      )
      return false
    }

    const next = !current
    this._resourceChanging = true
    this._openPanel({
      kind: 'tasks',
      title: 'Updating background behavior',
      rows: [],
      waitForCompletion: next,
    })
    try {
      await this._backend.setBackgroundTasksWaitForCompletion(next)
      this._context = {}
      this._refreshRuntime()
      this._openTasksPanel()
      return true
    } catch (error) {
      this._openError('task mode change failed', 'Wait for completion', errorMessage(error))
      return false
    } finally {
      this._resourceChanging = false
    }
  }

  private _openEffortPanel(): void {
    if (this._openEffortPanelIfAvailable()) {
      return
    }
    this._openError('effort unavailable', this._runtime.model, 'This model does not support reasoning effort.')
  }

  private _openEffortPanelIfAvailable(): boolean {
    const slider = effortSlider(this._backend.listEfforts?.() ?? [])
    if (!slider || slider.disabled) {
      return false
    }
    this._openPanel({
      kind: 'effort',
      title: 'Effort',
      rows: [],
      slider,
      body: `${modelDisplayName(this._runtime.model)}\n${this._runtime.model}`,
    })
    return true
  }

  async openModelPanel(): Promise<void> {
    if (!this._backend.listModels) {
      this._openError('models unavailable', this._runtime.model, 'This backend does not expose model selection.')
      return
    }
    const loading = this._openPanel({ kind: 'models', title: 'Models', rows: [], loading: true })
    try {
      const models = await this._backend.listModels()
      if (this._panel?.id !== loading.id) {
        return
      }
      this._openPanel({
        kind: 'models',
        title: `Models (${models.length})`,
        rows: modelRows(models, this._runtime.model),
        searchable: true,
        filters: modelFilters(
          models.map((model) => model.catalog).filter((catalog): catalog is string => !!catalog),
          this._backend.protocol
        ),
        body: `${modelDisplayName(this._runtime.model)}\n${this._runtime.model}`,
      })
    } catch (error) {
      if (this._panel?.id === loading.id) {
        this._openError('model discovery failed', this._runtime.model, errorMessage(error))
      }
    }
  }

  private async _selectModel(modelId: string): Promise<boolean> {
    if (!this._backend.switchModel && !this._backend.restartModel) {
      this._openError('model switch unavailable', modelId, 'This backend does not expose model selection.')
      return false
    }
    let mode: 'live' | 'restart'
    try {
      mode = this._backend.modelChangeMode?.(modelId) ?? (this._backend.switchModel ? 'live' : 'restart')
    } catch (error) {
      this._openError('model change failed', modelId, modelControlErrorMessage(error, 'model'))
      return false
    }
    if (mode === 'restart') {
      if (this._hasUnresolvedBackgroundTasks()) {
        this._openError(
          'model change blocked',
          modelId,
          'Background work is still running or waiting to be delivered. Finish or cancel it before changing models.'
        )
        return false
      }
      return this._rebuildModel(modelId)
    }
    this._resourceChanging = true
    try {
      const selected = await this._backend.switchModel!(modelId)
      this._context = {}
      this._refreshRuntime(selected ?? modelId)
      if (this._activeProjector || this._drainingProjector) {
        this._addNotice('delivered', `Model updated for the next model call: ${modelDisplayName(modelId)}`)
      }
      this._updateOpenModelPanel(modelId)
      this._openEffortPanelIfAvailable()
      this._emit()
      return true
    } catch (error) {
      this._openError('model switch failed', modelId, modelControlErrorMessage(error, 'model'))
      return false
    } finally {
      this._resourceChanging = false
    }
  }

  private async _selectEffort(effort: string): Promise<boolean> {
    if (!this._backend.setEffort) {
      this._openError('effort unavailable', effort, 'This backend does not expose reasoning effort.')
      return false
    }
    if (this._hasUnresolvedBackgroundTasks()) {
      this._openError(
        'effort change blocked',
        effort,
        'Background work is still running or waiting to be delivered. Finish or cancel it before rebuilding the agent.'
      )
      return false
    }
    this._resourceChanging = true
    try {
      const selected = await this._backend.setEffort(effort)
      this._context = {}
      this._refreshRuntime()
      if (this._panel?.kind === 'effort') {
        this._panel = {
          ...this._panel,
          slider: {
            ...this._panel.slider,
            options: this._panel.slider.options.map(({ active: _active, ...option }) => ({
              ...option,
              ...(option.id === effort ? { active: true } : {}),
            })),
          },
        }
      }
      this._emit()
      return selected !== undefined
    } catch (error) {
      this._openError('effort change failed', effort, modelControlErrorMessage(error, 'effort'))
      return false
    } finally {
      this._resourceChanging = false
    }
  }

  private async _openSessionsPanel(): Promise<void> {
    const sessionsRuntime = this._sessions
    if (!sessionsRuntime || this._backend.protocol !== 'strands') {
      this._openError('sessions unavailable', 'sessions', 'Saved sessions are not available for this backend.')
      return
    }
    if (this._sessionCache) {
      const panel = this._showSessionsPanel(sessionsRuntime, this._sessionCache)
      void this._refreshSessionsPanel(sessionsRuntime, panel.id)
      return
    }
    const loading = this._openPanel({
      kind: 'sessions',
      title: 'Sessions',
      rows: [{ label: 'loading', description: `Reading ${sessionsRuntime.directory}` }],
      filters: [{ id: 'all', label: 'All' }],
      loading: true,
    })
    await this._refreshSessionsPanel(sessionsRuntime, loading.id)
  }

  private async _refreshSessionsPanel(sessionsRuntime: ChatSessionRuntime, panelId: string): Promise<void> {
    const generation = this._sessionGeneration
    try {
      const sessions = await this._listSessions(sessionsRuntime)
      if (generation !== this._sessionGeneration || this._panel?.id !== panelId) {
        return
      }
      this._showSessionsPanel(sessionsRuntime, sessions, panelId)
    } catch (error) {
      if (generation === this._sessionGeneration && this._panel?.id === panelId && !this._sessionCache) {
        this._openError('session discovery failed', sessionsRuntime.directory, errorMessage(error))
      }
    }
  }

  private _listSessions(sessionsRuntime: ChatSessionRuntime): Promise<SessionList> {
    if (this._sessionRefresh) {
      return this._sessionRefresh
    }
    const generation = this._sessionGeneration
    const refresh = sessionsRuntime.list().then((sessions) => {
      if (generation === this._sessionGeneration) {
        this._sessionCache = sessions
      }
      return sessions
    })
    this._sessionRefresh = refresh
    const clearRefresh = (): void => {
      if (this._sessionRefresh === refresh) {
        this._sessionRefresh = undefined
      }
    }
    void refresh.then(clearRefresh, clearRefresh)
    return refresh
  }

  private _showSessionsPanel(sessionsRuntime: ChatSessionRuntime, sessions: SessionList, panelId?: string): ChatPanel {
    const rows = sessionRows(sessions)
    const filters = sessionFilters(sessions)
    if (!panelId) {
      return this._openPanel({
        kind: 'sessions',
        title: `Sessions (${sessions.length})`,
        rows,
        searchable: true,
        filters,
      })
    }
    const panel = this._makePanel({
      kind: 'sessions',
      title: `Sessions (${sessions.length})`,
      rows,
      searchable: true,
      filters,
    })
    this._panel = { ...panel, id: panelId }
    this._emit()
    return this._panel
  }

  private _invalidateSessions(): void {
    this._sessionGeneration++
    this._sessionRefresh = undefined
  }

  private async _handleSessionsCommand(argument: string): Promise<void> {
    const rename = /^rename(?:\s+([\s\S]+))?$/i.exec(argument)
    if (!rename) {
      this._openError('sessions command failed', `/sessions ${argument}`, 'Use /sessions or /sessions rename [name].')
      return
    }
    const name = rename[1] ?? ''
    if (!this._sessions?.renameCurrent || this._backend.protocol !== 'strands') {
      this._openError('session rename unavailable', name, 'The current backend does not expose a file-backed session.')
      return
    }
    this._sessionNaming?.abort()
    if (!name) {
      void this._generateSessionName()
      return
    }
    this._resourceChanging = true
    try {
      const renamed = await this._renameSession(name, this._sessions.current)
      this._runtime.session = renamed.name
      this._runtime.sessionName = renamed.name
      this._invalidateSessions()
      this._sessionCache = this._sessionCache?.map((session) =>
        session.active ? { ...session, name: renamed.name } : session
      )
      await this._openSessionsPanel()
    } catch (error) {
      this._openError('session rename failed', name, errorMessage(error))
    } finally {
      this._resourceChanging = false
    }
  }

  private async _generateSessionName(): Promise<void> {
    if (!this._backend.generateSessionName || !this._sessions?.current) {
      this._openError('session rename unavailable', '/sessions rename', 'Use /sessions rename <name> on this backend.')
      return
    }
    const sessionId = this._sessions.current
    const request = new AbortController()
    this._sessionNaming = request
    const notice = this._addNotice('running', 'Generating session name')
    this._emit()
    try {
      const name = await this._backend.generateSessionName(request.signal)
      request.signal.throwIfAborted()
      const renamed = await this._renameSession(name, sessionId, request.signal)
      request.signal.throwIfAborted()
      this._runtime.session = renamed.name
      this._runtime.sessionName = renamed.name
      this._invalidateSessions()
      this._sessionCache = undefined
      notice.status = 'success'
      notice.text = `Session renamed: ${renamed.name}`
      if (this._panel?.kind === 'sessions') {
        await this._openSessionsPanel()
      }
    } catch (error) {
      notice.status = request.signal.aborted ? 'delivered' : 'error'
      notice.text = request.signal.aborted
        ? 'Session naming cancelled'
        : `Session rename failed: ${errorMessage(error)}`
    } finally {
      if (this._sessionNaming === request) {
        this._sessionNaming = undefined
      }
      this._emit()
    }
  }

  private _renameSession(
    name: string,
    sessionId: string | undefined,
    signal?: AbortSignal
  ): Promise<{ sessionId: string; name: string }> {
    const sessions = this._sessions
    const renameCurrent = sessions?.renameCurrent?.bind(sessions)
    if (!sessions || !renameCurrent) {
      return Promise.reject(new Error('The current backend does not expose a file-backed session.'))
    }
    const renamed = this._sessionRename.then(() => {
      signal?.throwIfAborted()
      if (sessions.current !== sessionId) {
        throw new Error('The active session changed before it could be renamed.')
      }
      return renameCurrent(name)
    })
    this._sessionRename = renamed.catch(() => undefined)
    return renamed
  }

  private async _openSkillsPanel(): Promise<void> {
    if (!this._skills || this._backend.protocol !== 'strands') {
      this._openError('skills unavailable', 'skills', 'No skills runtime is configured for this backend.')
      return
    }
    const loading = this._openPanel({
      kind: 'skills',
      title: 'Skills',
      rows: [{ label: 'loading', description: 'Parsing configured skills with the Strands SDK.' }],
    })
    try {
      const skills = await this._listSkills()
      if (this._panel?.id !== loading.id) {
        return
      }
      this._rememberSkills(skills)
      this._openPanel({
        kind: 'skills',
        title: `Skills (${skills.length})`,
        rows: skillRows(skills),
        searchable: true,
        ...(this._skills.paths?.length ? { body: `Checked: ${this._skills.paths.join(', ')}` } : {}),
      })
    } catch (error) {
      if (this._panel?.id === loading.id) {
        this._openError('skill discovery failed', 'skills', errorMessage(error))
      }
    }
  }

  private async _activateSkillAndRun(name: string, displayPrompt: string): Promise<ChatTurn | null | undefined> {
    if (!this._skills || this._backend.protocol !== 'strands') {
      return null
    }
    this._resourceChanging = true
    let activation: SkillActivation | undefined
    try {
      activation = await this._skills.activate(name)
    } catch (error) {
      this._openError('skill activation failed', name, errorMessage(error))
      return undefined
    } finally {
      this._resourceChanging = false
    }
    if (!activation) {
      return null
    }
    const { skill } = activation
    this._skillNames.add(skill.name.toLowerCase())
    this._skillDetails.set(skill.name, skill)
    return this._runPrompt(skillInvocationPrompt(activation, displayPrompt), displayPrompt)
  }

  private async _compactConversation(): Promise<void> {
    if (!this._backend.compact) {
      this._openError('compaction unavailable', 'compact', 'This backend cannot compact its conversation.')
      return
    }
    if (this._hasUnresolvedBackgroundTasks()) {
      this._openError(
        'compaction blocked',
        'compact',
        'Background work is still running or waiting to be delivered. Finish or cancel it before compacting.'
      )
      return
    }
    this._resourceChanging = true
    this._composerStatus = 'Compacting context...'
    this._panel = undefined
    this._panelStack.length = 0
    this._emit()
    try {
      const context = await this._backend.compact()
      if (context) {
        this._context = { ...context }
        this._addNotice('success', 'Compacted older conversation context into a summary')
      } else {
        this._addNotice('delivered', 'Nothing to compact yet')
      }
    } catch (error) {
      this._openError('compaction failed', 'compact', errorMessage(error))
    } finally {
      this._resourceChanging = false
      this._composerStatus = undefined
      this._emit()
    }
  }

  private async _clearConversation(): Promise<void> {
    if (!this._backend.clear) {
      this._openError('clear unavailable', 'clear', 'This backend cannot start a fresh conversation.')
      return
    }
    if (this._hasUnresolvedBackgroundTasks()) {
      this._openError(
        'clear blocked',
        'clear',
        'Background work is still running or waiting to be delivered. Finish or cancel it before clearing.'
      )
      return
    }
    this._sessionNaming?.abort()
    this._resourceChanging = true
    this._composerStatus = 'Starting fresh conversation...'
    this._panel = undefined
    this._panelStack.length = 0
    this._emit()
    try {
      await this._backend.clear()
      this._stopWatchingUsage()
      this._completedTurns = []
      this._notices = []
      this._tasks = []
      this._context = {}
      this._nextTurn = 1
      this._nextNotice = 1
      this._taskBaselineReady = false
      this._backgroundContinuationPending = false
      this._attemptedBackgroundGeneration = undefined
      this._stopTaskActivity()
      this._skillDetails.clear()
      this._runtime.session = this._backend.info?.().sessionId ?? 'in-memory'
      delete this._runtime.sessionName
      this._invalidateSessions()
      this._sessionCache = undefined
      this._refreshRuntime()
      this._panel = undefined
      this._panelStack.length = 0
      this._emit()
    } catch (error) {
      this._openError('clear failed', 'clear', errorMessage(error))
    } finally {
      this._resourceChanging = false
      this._composerStatus = undefined
      this._emit()
    }
  }

  openSkillDetail(name: string): boolean {
    const skill = this._skillDetails.get(name)
    if (!skill) {
      return false
    }
    this._pushPanel({
      kind: 'detail',
      title: `Skill: ${skill.name}`,
      rows: skillDetailRows(skill),
      body: skill.instructions || '(No instructions.)',
    })
    return true
  }

  openMcpDetail(name: string): boolean {
    const server = this._mcpDetails.get(name)
    if (!server || this._resourceChanging || this._closed) {
      return false
    }
    const failure =
      server.state === 'failed'
        ? mcpFailure({ ...server, canRetry: this._mcp?.setEnabled !== undefined && server.canRetry !== false })
        : undefined
    this._pushPanel({
      kind: 'detail',
      title: `MCP: ${server.name}`,
      rows: [
        ...(failure
          ? [
              { label: 'Problem', description: failure.summary },
              { label: 'Next step', description: failure.guidance },
              ...(this._mcp?.setEnabled && server.canRetry !== false
                ? [
                    {
                      label: 'Retry',
                      description:
                        'Esc back, then R retries with the loaded settings. It does not reread configuration.',
                    },
                  ]
                : []),
            ]
          : [{ label: 'Status', description: server.state }]),
        ...(server.source ? [{ label: 'Source', description: server.source }] : []),
        { label: 'Transport', description: server.transport },
        { label: 'Target', description: server.target },
      ],
      body: [
        ...(server.error ? [`Full error\n${server.error}`] : []),
        ...(this._mcp?.warnings.length ? [`Configuration warnings\n${this._mcp.warnings.join('\n')}`] : []),
      ].join('\n\n'),
    })
    return true
  }

  async retryMcpServer(name: string): Promise<boolean> {
    const server = this._mcpDetails.get(name)
    if (
      !server ||
      server.canRetry === false ||
      (server.state !== 'failed' && server.state !== 'disconnected') ||
      this._panel?.kind !== 'mcp'
    ) {
      return false
    }
    return this._setMcpServerEnabled(name, true, false)
  }

  private _mcpPanel(servers: readonly McpServerInfo[]): Extract<NewChatPanel, { kind: 'mcp' }> {
    this._mcpDetails.clear()
    for (const server of servers) {
      this._mcpDetails.set(server.name, server)
    }
    const toggles = this._mcp?.setEnabled !== undefined
    return {
      kind: 'mcp',
      title: `MCP servers (${servers.length})`,
      rows: mcpRows(servers, toggles),
      canRetry:
        toggles &&
        servers.some(
          (server) => server.canRetry !== false && (server.state === 'failed' || server.state === 'disconnected')
        ),
      ...mcpOptions(servers, this._mcp?.paths ?? [], this._mcp?.warnings ?? []),
    }
  }

  private async _openMcpPanel(): Promise<void> {
    if (!this._mcp) {
      this._openError('MCP unavailable', 'mcp', 'No MCP runtime is configured.')
      return
    }
    // The panel shows every failure, so the composer reminder is done.
    if (this._mcpStartup?.settled) {
      this._mcpStartup = undefined
    }
    const loading = this._openPanel({
      kind: 'mcp',
      title: 'MCP servers',
      rows: [{ label: 'loading', description: 'Checking server connections and tools.' }],
    })
    try {
      const servers = await this._mcp.list(true)
      if (this._panel?.id !== loading.id) {
        return
      }
      this._openPanel(this._mcpPanel(servers))
    } catch (error) {
      if (this._panel?.id === loading.id) {
        this._openError('MCP connection failed', 'mcp', errorMessage(error))
      }
    }
  }

  private async _toggleMcpServer(value: string): Promise<boolean> {
    const name = decodeURIComponent(value.slice('mcp:toggle:'.length))
    const server = this._mcpDetails.get(name)
    if (!server) {
      return false
    }
    return this._setMcpServerEnabled(name, server.state === 'disabled', true)
  }

  private async _setMcpServerEnabled(name: string, enable: boolean, persist: boolean): Promise<boolean> {
    if (!this._mcp?.setEnabled || this.busy || this._closed) {
      return false
    }
    const panelId = this._panel?.id
    this._resourceChanging = true
    this._composerStatus = enable ? `Connecting ${name}...` : `Disconnecting ${name}...`
    this._emit()
    try {
      const failure = await this._mcp.setEnabled(name, enable)
      if (persist) {
        const disabled = new Set(this._settings.disabledMcpServers)
        if (enable) {
          disabled.delete(name)
        } else {
          disabled.add(name)
        }
        this._settings = { ...this._settings, disabledMcpServers: [...disabled] }
        await this._setSettings?.({ disabledMcpServers: [...disabled] })
      }
      if (failure) {
        this._addNotice('error', `${name}: ${failure}`)
      }
      const servers = await this._mcp.list(true)
      if (this._panel?.kind === 'mcp' && this._panel.id === panelId && !this._closed) {
        this._panel = makePanel(this._panel.id, this._mcpPanel(servers))
      }
    } catch (error) {
      this._addNotice('error', `${name}: ${errorMessage(error)}`)
    } finally {
      this._resourceChanging = false
      this._composerStatus = undefined
    }
    this._emit()
    return true
  }

  private async _handlePermissionsCommand(argument: string): Promise<void> {
    if (!argument) {
      this._openPermissionsPanel()
      return
    }
    const normalized = argument.toLowerCase()
    if (normalized === 'default' || normalized === 'bypass' || normalized === 'bypasspermissions') {
      await this._setPermissionMode(normalized === 'default' ? 'default' : 'bypassPermissions')
      return
    }
    this._openError(
      'unknown permission mode',
      argument,
      'Use /permissions, /permissions default, or /permissions bypass.'
    )
  }

  private _openPermissionsPanel(refresh = false): void {
    const status = this._backend.permissionStatus?.()
    if (
      !status ||
      !this._backend.setPermissionMode ||
      !this._backend.allowPermission ||
      !this._backend.removeAllowedPermission
    ) {
      this._openError(
        'permissions unavailable',
        this._backend.name,
        'Permission configuration is available only for the built-in Strands backend.'
      )
      return
    }
    this._permissionMode = status.mode
    if (!refresh || !this._permissionPreset) {
      this._permissionPreset = permissionPreset(status)
    }
    const panel = {
      kind: 'permissions',
      title: 'Permissions',
      searchable: true,
      rows: permissionSettingsRows(status, this._runtime.tools, this._permissionPreset),
      slider: permissionSettingsSlider(this._permissionPreset),
    } satisfies NewChatPanel
    if (refresh && this._panel?.kind === 'permissions') {
      const currentId = this._panel.id
      this._panel = { ...this._makePanel(panel), id: currentId }
      this._emit()
      return
    }
    this._openPanel(panel)
  }

  private async _updatePermissions(value: string): Promise<boolean> {
    const [prefix, action, encodedValue] = value.split(':')
    if (prefix !== 'permissions' || !action || !encodedValue) {
      return false
    }
    if (action === 'preset' && (encodedValue === 'ask' || encodedValue === 'bypass' || encodedValue === 'custom')) {
      return this._setPermissionPreset(encodedValue)
    }
    if (action === 'deny') {
      return this._removeDeniedPermission(decodeURIComponent(encodedValue))
    }
    if (
      action !== 'tool' ||
      !this._backend.allowPermission ||
      !this._backend.removeAllowedPermission ||
      !this._backend.permissionStatus
    ) {
      return false
    }
    const toolName = decodeURIComponent(encodedValue)
    try {
      const allowed = this._backend.permissionStatus()?.allowedTools.includes(toolName) ?? false
      if (allowed) {
        await this._backend.removeAllowedPermission(toolName)
      } else {
        await this._backend.allowPermission(toolName)
      }
      this._permissionPreset = 'custom'
      this._openPermissionsPanel(true)
      return true
    } catch (error) {
      this._openError('permission update failed', toolName, errorMessage(error))
      return false
    }
  }

  private async _removeDeniedPermission(rule: string): Promise<boolean> {
    if (!this._backend.removeDeniedPermission) {
      return false
    }
    try {
      await this._backend.removeDeniedPermission(rule)
      this._openPermissionsPanel(true)
      return true
    } catch (error) {
      this._openError('permission update failed', rule, errorMessage(error))
      return false
    }
  }

  private async _setPermissionPreset(preset: ChatPermissionPreset): Promise<boolean> {
    const status = this._backend.permissionStatus?.()
    if (!status || !this._backend.setPermissionMode || !this._backend.removeAllowedPermission) {
      this._openError(
        'permissions unavailable',
        this._backend.name,
        'Permission configuration is available only for the built-in Strands backend.'
      )
      return false
    }
    try {
      if (preset === 'ask') {
        for (const toolName of status.allowedTools) {
          await this._backend.removeAllowedPermission(toolName)
        }
      }
      const mode = preset === 'bypass' ? 'bypassPermissions' : 'default'
      await this._backend.setPermissionMode(mode)
      this._permissionMode = mode
      this._permissionPreset = preset
      this._openPermissionsPanel(true)
      return true
    } catch (error) {
      this._openError('permission update failed', preset, errorMessage(error))
      return false
    }
  }

  private async _setPermissionMode(mode: ChatPermissionMode): Promise<boolean> {
    if (!this._backend.setPermissionMode) {
      this._openError(
        'permissions unavailable',
        this._backend.name,
        'Permission configuration is available only for the built-in Strands backend.'
      )
      return false
    }
    try {
      await this._backend.setPermissionMode(mode)
      this._permissionMode = mode
      const status = this._backend.permissionStatus?.()
      this._permissionPreset = status ? permissionPreset(status) : mode === 'default' ? 'ask' : 'bypass'
      this._openPermissionsPanel(true)
      return true
    } catch (error) {
      this._openError('permission update failed', mode, errorMessage(error))
      return false
    }
  }

  private async _handleExportCommand(argument: string): Promise<void> {
    if (!argument) {
      this._openExportPanel()
      return
    }
    const match = /^(\S+)\s+([\s\S]+)$/u.exec(argument)
    const language = match?.[1]?.toLowerCase()
    const destination = unquote(match?.[2]?.trim() ?? '')
    if ((language !== 'typescript' && language !== 'python') || !destination.trim()) {
      this._openError('Export arguments required', '/export', 'Usage: /export <typescript|python> <path.zip>')
      return
    }
    await this._exportAgent(language, resolve(this._runtime.cwd, expandHome(destination)))
  }

  private _openExportPanel(): void {
    if (!this._exportAgentProject) {
      this._openError('export unavailable', '/export', 'This connection cannot export an agent project.')
      return
    }
    this._exportedPath = undefined
    this._openPanel({
      kind: 'export',
      title: `Export ${this._backend.name}`,
      rows: [
        {
          label: 'Python',
          description: 'strands-harness project',
          value: EXPORT_PYTHON,
        },
        {
          label: 'TypeScript',
          description: '@strands-agents/harness project',
          value: EXPORT_TYPESCRIPT,
        },
      ].filter((row) => !this._project || row.value === `export:${this._project.language}`),
      body: this._project
        ? 'Export a separate copy of these source files.'
        : 'Export a copy, including pending agent changes.',
    })
  }

  private _openExportNamePanel(language: ChatConfigurationLanguage): void {
    const defaultName = exportDirectoryName(this._backend.name)
    this._pushPanel({
      kind: 'export',
      title: 'Name exported folder',
      rows: [],
      searchable: true,
      nameInput: { language, defaultName },
      body: 'Choose a folder name for this copy.',
    })
  }

  private _openExportDestinationPanel(language: ChatConfigurationLanguage, name: string): void {
    const encodedName = encodeURIComponent(name)
    this._pushPanel({
      kind: 'export',
      title: `Save ${language === 'typescript' ? 'TypeScript' : 'Python'} copy`,
      rows: [
        {
          label: 'Default folder',
          description: `~/.strands/harnesses/${name}`,
          value: `${EXPORT_SAVE_DEFAULT_PREFIX}${language}:${encodedName}`,
        },
        {
          label: canUseNativePicker() ? 'Choose parent folder' : 'Custom path',
          description: canUseNativePicker() ? `Browse and save as ${name}` : `/export ${language} <path.zip>`,
          ...(canUseNativePicker() ? { value: `${EXPORT_SAVE_CUSTOM_PREFIX}${language}:${encodedName}` } : {}),
        },
      ],
      body: 'Choose where to save this copy.',
    })
  }

  private async _exportAgent(
    language: ChatConfigurationLanguage,
    destination?: string,
    output: AgentProjectOutput = 'zip'
  ): Promise<boolean> {
    if (!this._exportAgentProject) {
      return false
    }
    if (this._project && language !== this._project.language) {
      this._openError(
        'export failed',
        language,
        `This agent is authored in ${this._project.language}; export it in the same language to preserve its code.`
      )
      return false
    }
    this._resourceChanging = true
    try {
      const path =
        output === 'zip'
          ? await this._exportAgentProject(language, destination)
          : await this._exportAgentProject(language, destination, output)
      if (path) {
        this._exportedPath = path
        const switchable = output === 'directory' && this._useExportedProject !== undefined
        this._openPanel({
          kind: 'export',
          title: 'Export complete',
          rows: [
            ...(switchable
              ? [
                  {
                    label: 'Use for this session',
                    description: 'Edits reload this session',
                    value: 'export:use-project',
                  },
                ]
              : []),
            { label: 'Copy path', description: path, value: 'export:copy-path' },
            { label: 'Copy launch command', description: agentLaunchCommand(path), value: 'export:copy-command' },
          ],
          body: 'Saved a copy. No automatic updates.',
        })
      } else if (destination === undefined && output === 'zip') {
        this._openError('Export path required', '/export', `Use /export ${language} <path.zip> to save this agent.`)
      }
      return path !== undefined
    } catch (error) {
      this._openError('export failed', language, errorMessage(error))
      return false
    } finally {
      this._resourceChanging = false
    }
  }

  private _useExported(): boolean {
    if (!this._exportedPath || !this._useExportedProject || this._panel?.kind !== 'export') {
      return false
    }
    if (this.busy || this._hasUnresolvedBackgroundTasks()) {
      this._openError('switch failed', this._exportedPath, 'Finish or cancel running work before switching projects.')
      return true
    }
    this._useExportedProject(this._exportedPath)
    return true
  }

  private async _copyExport(action: 'export:copy-path' | 'export:copy-command'): Promise<boolean> {
    if (!this._exportedPath || this._panel?.kind !== 'export') {
      return false
    }
    const panel = this._panel
    const text = action === 'export:copy-path' ? this._exportedPath : agentLaunchCommand(this._exportedPath)
    let copied = false
    try {
      copied = await this._copyText(text)
    } catch {
      // Clipboard failures are reflected on the selected row.
    }
    if (this._panel === panel) {
      this._panel = {
        ...panel,
        rows: panel.rows.map((row) =>
          row.value === action
            ? {
                ...row,
                description: `${copied ? 'Copied' : 'Copy failed'} · ${sanitizeTerminalText(text)}`,
                badge: { text: copied ? 'Copied' : 'Copy failed', tone: copied ? 'success' : 'danger' },
              }
            : row
        ),
      }
      this._emit()
    }
    return copied
  }

  private async _updateSetting(setting: string): Promise<boolean> {
    if (this._panel?.kind !== 'settings') {
      return false
    }
    const update = parseSettingUpdate(setting, this._settings)
    if (!update) {
      return false
    }
    return this._applySettings(update, setting.split('=')[0]!)
  }

  private async _applySettings(update: Partial<ChatSettings>, setting: string): Promise<boolean> {
    this._resourceChanging = true
    try {
      await this._setSettings?.(update)
    } catch (error) {
      this._openError('setting update failed', setting, errorMessage(error))
      return false
    } finally {
      this._resourceChanging = false
    }
    this._settings = globalThis.structuredClone({ ...this._settings, ...update })
    if (this._panel?.kind === 'settings') {
      this._panel = {
        ...this._panel,
        rows: sanitizeRows(
          settingsRows(
            this._settings,
            this._panel.settingsCategory ?? DEFAULT_SETTINGS_CATEGORY,
            this._requestSetup !== undefined
          )
        ),
      }
    }
    this._emit()
    return true
  }

  private _openSettingsCategory(value: string, replace = false): boolean {
    const category = SETTINGS_CATEGORIES.find(({ id }) => value === `settings:${id}`)
    if (!category) {
      return false
    }
    const rows = settingsRows(this._settings, category.id, this._requestSetup !== undefined)
    const panel = {
      kind: 'settings',
      title: category.label,
      rows,
      filters: settingsCategoryFilters(),
      settingsCategory: category.id,
    } satisfies NewChatPanel
    if (replace) {
      this._openPanel(panel)
    } else if (this._panel?.kind === 'settings') {
      this._panel = this._makePanel(panel)
      this._emit()
    } else {
      this._pushPanel(panel)
    }
    return true
  }

  private _respondPermission(value: string): boolean {
    const [prefix, encodedRequestId, encodedOptionId, encodedRule] = value.split(':')
    if (prefix !== 'permission' || !encodedRequestId || !encodedOptionId || this._panel?.kind !== 'permission') {
      return false
    }
    const request = this._panel.request
    const requestId = decodeURIComponent(encodedRequestId)
    const optionId = decodeURIComponent(encodedOptionId)
    if (request.id !== requestId) {
      return false
    }
    if (optionId === 'back' && this._panel.stage) {
      const stage = this._panel.stage
      this._showPermissionPanel(
        request,
        undefined,
        request.options.findIndex((option) => option.id === stage)
      )
      return true
    }
    if (encodedRule === undefined && permissionChoosesScope(request, optionId)) {
      this._showPermissionPanel(request, optionId === 'allow-always' ? 'allow-always' : 'deny-always')
      return true
    }
    const rule = encodedRule === undefined ? undefined : decodeURIComponent(encodedRule)
    if (!this._backend.respondPermission?.(requestId, optionId, rule)) {
      return false
    }
    this._closePermissionPanel()
    return true
  }

  private _openPermissionPanel(request: ChatPermissionRequest): void {
    this._pushPanel(this._permissionPanel(request))
  }

  private _showPermissionPanel(request: ChatPermissionRequest, stage?: PermissionStage, selected?: number): void {
    this._panel = this._makePanel(this._permissionPanel(request, stage, selected))
    this._emit()
  }

  private _permissionPanel(request: ChatPermissionRequest, stage?: PermissionStage, selected?: number): NewChatPanel {
    return {
      kind: 'permission',
      title:
        stage === 'allow-always'
          ? `Always allow ${request.toolName} for…`
          : stage === 'deny-always'
            ? `Always deny ${request.toolName} for…`
            : 'Allow tool call?',
      rows: permissionRequestRows(request, stage),
      body: formatPermissionPanelBody(request),
      request,
      ...(stage ? { stage } : {}),
      ...(selected !== undefined && selected > 0 ? { selected } : {}),
    }
  }

  private _refreshRuntime(model?: string): void {
    const info = this._backend.info?.()
    const session =
      info?.sessionId && this._sessions?.current === info.sessionId && this._runtime.session !== info.sessionId
        ? this._runtime.session
        : (info?.sessionId ?? (this._backend.protocol === 'strands' ? this._runtime.session : 'not saved'))
    const runtime: ChatRuntimeInfo = {
      ...this._runtime,
      agent: this._backend.name,
      backendId: this._backend.id,
      protocol: this._backend.protocol,
      model: model ?? info?.model ?? this._runtime.model,
      tools: info?.tools ?? [],
      session,
    }
    if (info?.effort !== undefined) {
      runtime.effort = info.effort
    } else {
      delete runtime.effort
    }
    this._runtime = runtime
    this._refreshConfiguration()
  }

  private _refreshConfiguration(trackChanges = false): void {
    if (!this._configurationSource) {
      return
    }
    try {
      const previous = this._configuration
      const configuration = sanitizeConfigurationSource(this._configurationSource())
      if (trackChanges && previous) {
        const turnId = this._configurationTurnId()
        const current = this._configurationBaseline
        const baseline = current && current.turnId === turnId ? current : { turnId, source: previous }
        this._configurationBaseline = baseline
        this._configurationDiffs = configurationDiffs(baseline.source, configuration)
      }
      this._configuration = configuration
      if (this._panel?.kind === 'config') {
        this._panel = { ...this._panel, configuration: this._configuration }
      }
    } catch {
      // Keep the last readable configuration while the source is being replaced.
    }
  }

  private _configurationTurnId(): string | undefined {
    return this._activeProjector?.snapshot().id ?? this._completedTurns.at(-1)?.id
  }

  private _closePermissionPanel(): void {
    const panels = this._panelStack.filter((panel) => panel.kind !== 'permission')
    const removed = panels.length !== this._panelStack.length
    this._panelStack.splice(0, this._panelStack.length, ...panels)
    if (this._panel?.kind === 'permission') {
      this._panel = this._panelStack.pop()
    } else if (!removed) {
      return
    }
    this._emit()
  }

  private _setTasks(tasks: readonly ChatTask[]): void {
    const previous = new Map(this._tasks.map((task) => [task.id, task]))
    this._tasks = tasks.map(cloneTask)
    if (this._taskBaselineReady) {
      this._recordTaskTransitions(previous, this._tasks)
    } else {
      this._taskBaselineReady = true
    }
    if (this._panel?.kind === 'tasks') {
      const waitForCompletion = this._backend.backgroundTasksWaitForCompletion?.()
      const rows = taskRows(this._tasks)
      this._panel = {
        ...this._panel,
        title: `Tasks (${rows.length})`,
        rows: sanitizeRows(rows),
        ...(waitForCompletion !== undefined ? { waitForCompletion } : {}),
      }
    }
    if (this._openTaskDetailId) {
      this._refreshTaskDetail()
    }
    const generation = readyBackgroundGeneration(this._tasks)
    if (generation && this._attemptedBackgroundGeneration !== generation && this._backend.streamBackgroundResults) {
      this._backgroundContinuationPending = true
      this._startBackgroundContinuation()
    } else if (!generation) {
      this._backgroundContinuationPending = false
    }
  }

  private _startBackgroundContinuation(): void {
    if (
      !this._backgroundContinuationPending ||
      this._backgroundContinuationRun ||
      this._closed ||
      this._activeProjector !== undefined ||
      this._drainingProjector !== undefined ||
      this._pendingSubmissionRun !== undefined ||
      this._resourceChanging ||
      this._pendingSubmissions.some((pending) => pending.kind === 'user') ||
      !this._backend.streamBackgroundResults
    ) {
      return
    }
    if (!this._backend.hasReadyBackgroundResults?.()) {
      this._backgroundContinuationPending = false
      return
    }

    const generation = readyBackgroundGeneration(this._tasks)
    if (!generation || this._attemptedBackgroundGeneration === generation) {
      this._backgroundContinuationPending = false
      return
    }
    this._attemptedBackgroundGeneration = generation
    this._backgroundContinuationPending = false
    const run = this._runBackgroundContinuation()
    this._backgroundContinuationRun = run
    void run.finally(() => {
      if (this._backgroundContinuationRun === run) {
        this._backgroundContinuationRun = undefined
      }
      this._startBackgroundContinuation()
      this._startPendingSubmissions()
    })
  }

  private _hasUnresolvedBackgroundTasks(): boolean {
    return this._tasks.some(isUnresolvedBackgroundTask)
  }

  private _openTaskDetail(value: string): boolean {
    const taskId = readTaskValue(value)
    const task = taskId ? this._tasks.find((candidate) => candidate.id === taskId) : undefined
    if (!task) {
      return false
    }

    this._stopTaskActivity()
    this._openTaskDetailId = task.id
    const activity = this._backend.getTaskActivity?.(task.id)
    this._pushPanel({
      kind: 'detail',
      title: taskDetailTitle(task, activity),
      rows: taskDetailRows(task, activity),
      body: activity ? '' : formatTaskActivity(task),
      followTail: true,
      ...(activity ? { activity } : {}),
    })
    this._stopWatchingTaskActivity = this._backend.watchTaskActivity?.(task.id, () => {
      if (this._openTaskDetailId !== task.id || this._taskDetailRefreshTimer) {
        return
      }
      this._taskDetailRefreshTimer = setTimeout(() => {
        this._taskDetailRefreshTimer = undefined
        this._refreshTaskDetail()
        this._emit()
      }, 33)
    })
    return true
  }

  private _refreshTaskDetail(): void {
    const taskId = this._openTaskDetailId
    const task = taskId ? this._tasks.find((candidate) => candidate.id === taskId) : undefined
    if (!task || this._panel?.kind !== 'detail') {
      return
    }
    const activity = this._backend.getTaskActivity?.(task.id)
    const { activity: _previousActivity, ...panel } = this._panel
    this._panel = {
      ...panel,
      title: taskDetailTitle(task, activity),
      rows: sanitizeRows(taskDetailRows(task, activity)),
      body: sanitizeTerminalText(activity ? '' : formatTaskActivity(task)),
      ...(activity ? { activity } : {}),
    }
  }

  private _stopTaskActivity(): void {
    clearTimeout(this._taskDetailRefreshTimer)
    this._taskDetailRefreshTimer = undefined
    this._stopWatchingTaskActivity?.()
    this._stopWatchingTaskActivity = undefined
    this._openTaskDetailId = undefined
  }

  private _recordTaskTransitions(previous: ReadonlyMap<string, ChatTask>, current: readonly ChatTask[]): void {
    const currentIds = new Set(current.map((task) => task.id))
    for (const task of current) {
      if (task.source !== 'background') {
        continue
      }
      const prior = previous.get(task.id)
      if (
        prior?.status !== task.status &&
        (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')
      ) {
        const status = task.status === 'completed' ? 'success' : 'error'
        this._addNotice(status, `Background task ${task.status} (${task.label})`, task.id)
      }

      if (prior?.deliveryState !== 'delivered' && task.deliveryState === 'delivered') {
        this._markBackgroundTaskDelivered(task.id)
      }
    }
    for (const task of previous.values()) {
      if (task.source === 'background' && task.deliveryState === 'ready' && !currentIds.has(task.id)) {
        this._markBackgroundTaskDelivered(task.id)
      }
    }
  }

  private _markBackgroundTaskDelivered(taskId: string): void {
    this._deliveredBackgroundTaskIds.add(taskId)
    if (!this._activeProjector && !this._drainingProjector) {
      this._clearDeliveredBackgroundTaskNotices()
    }
  }

  private _clearDeliveredBackgroundTaskNotices(): void {
    if (this._deliveredBackgroundTaskIds.size === 0) {
      return
    }
    this._notices = this._notices.filter(
      (notice) => notice.status !== 'success' || !notice.taskId || !this._deliveredBackgroundTaskIds.has(notice.taskId)
    )
    this._deliveredBackgroundTaskIds.clear()
  }

  private _addNotice(status: ChatNotice['status'], text: string, taskId?: string): ChatNotice {
    const afterTurnId = this._activeProjector?.snapshot().id ?? this._completedTurns.at(-1)?.id
    const notice = {
      id: `notice-${this._nextNotice++}`,
      ...(afterTurnId ? { afterTurnId } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      text: sanitizeTerminalText(text),
      status,
    }
    this._notices.push(notice)
    return notice
  }

  private async _applyDeferredModelRestart(): Promise<void> {
    const modelId = this._deferredModelRestart
    if (!modelId || this._closed || this._activeProjector || this._drainingProjector || !this._backend.restartModel) {
      return
    }
    this._deferredModelRestart = undefined
    const notice = this._notices.find((candidate) => candidate.id === this._deferredModelNoticeId)
    this._deferredModelNoticeId = undefined
    if (this._hasUnresolvedBackgroundTasks()) {
      if (notice) {
        notice.status = 'error'
        notice.text = 'Model change could not run because background work is still active'
      }
      this._emit()
      return
    }
    this._resourceChanging = true
    if (notice) {
      notice.text = `Applying model change: ${modelDisplayName(modelId)}`
    }
    this._emit()
    try {
      const selected = await this._backend.restartModel(modelId)
      this._context = {}
      this._refreshRuntime(typeof selected === 'string' ? selected : modelId)
      this._updateOpenModelPanel(modelId)
      if (notice) {
        notice.status = 'delivered'
        notice.text = `Model changed to ${modelDisplayName(modelId)}`
      }
      this._openEffortPanelIfAvailable()
    } catch (error) {
      if (notice) {
        notice.status = 'error'
        notice.text = modelControlErrorMessage(error, 'model')
      }
    } finally {
      this._resourceChanging = false
      this._emit()
    }
  }

  private _updateOpenModelPanel(modelId: string): void {
    const panel = this._panel
    if (panel?.kind !== 'models') {
      return
    }
    const rows = panel.rows.map((row) => {
      const next = { ...row }
      if (next.badge?.text === 'current') {
        delete next.badge
        if (next.section === 'Current model') {
          delete next.section
        }
      }
      return row.value === modelId
        ? {
            ...next,
            section: 'Current model',
            badge: { text: 'current', tone: 'success' as const },
          }
        : next
    })
    const updated = this._makePanel({
      kind: 'models',
      title: panel.title,
      rows,
      ...(panel.searchable !== undefined ? { searchable: panel.searchable } : {}),
      ...(panel.filters ? { filters: panel.filters } : {}),
      body: `${modelDisplayName(this._runtime.model)}\n${this._runtime.model}`,
    })
    this._panel = { ...updated, id: panel.id }
  }

  private _openPanel(input: NewChatPanel): ChatPanel {
    if (this._panel?.kind === 'permission') {
      return this._pushPanel(input)
    }
    this._panelStack.length = this._panelStack.findIndex((panel) => panel.kind === 'permission') + 1
    const panel = this._makePanel(input)
    this._panel = panel
    this._emit()
    return panel
  }

  private _pushPanel(input: NewChatPanel): ChatPanel {
    if (this._panel) {
      this._panelStack.push(this._panel)
    }
    const panel = this._makePanel(input)
    this._panel = panel
    this._emit()
    return panel
  }

  private _makePanel(input: NewChatPanel): ChatPanel {
    return makePanel(`panel-${this._nextPanel++}`, input)
  }

  private _openError(title: string, label: string, description: string): void {
    this._openPanel({ kind: 'error', title, rows: [{ label, description, tone: 'danger' }] })
  }
}

function skillInvocationPrompt(activation: SkillActivation, displayPrompt: string): string {
  return [
    '<strands_skill_activation>',
    `The user explicitly invoked the ${activation.skill.name} skill. It is already activated; do not call the skills tool again.`,
    'Follow the activated instructions below. Treat text after the leading skill command as the request; if there is none, apply the skill to the current conversation.',
    '',
    '<skill_instructions>',
    activation.content,
    '</skill_instructions>',
    '</strands_skill_activation>',
    '',
    displayPrompt,
  ].join('\n')
}

function isLiveLocalCommand(prompt: string): boolean {
  const invocation = parseCommandInvocation(prompt)
  return invocation?.prefix === '/' && LIVE_LOCAL_COMMAND_NAMES.has(invocation.name.toLowerCase())
}

function normalizeChatInput(input: ChatInput): ChatInputWithAttachments {
  return typeof input === 'string'
    ? { text: input.trim(), attachments: [] }
    : { text: input.text.trim(), attachments: [...input.attachments] }
}
