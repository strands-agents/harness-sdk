import { homedir } from 'node:os'
import { resolve } from 'node:path'

import {
  clonePanel,
  effortSlider,
  permissionRequestRows,
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
  sessionRows,
  setupQuestionRows,
  skillRows,
  skillDetailRows,
  permissionSettingsRows,
  mcpRows,
  mcpOptions,
  BACKGROUND_TASK_WAIT_TOGGLE,
} from './panels.js'
import { LOCAL_COMMAND_NAMES, parseCommandInvocation } from './commands.js'
import { helpRows } from './help.js'
import {
  DEFAULT_CHAT_SETTINGS,
  DEFAULT_SETTINGS_CATEGORY,
  SETTINGS_CATEGORIES,
  parseSettingUpdate,
} from '../settings.js'
import { agentLaunchCommand } from '../project/import.js'
import { type ChatSessionRuntime, type SessionTarget } from '../session/sessions.js'
import { unquote } from '../session/conversation-helpers.js'
import type { ChatSkillsRuntime, SkillInfo } from '../skills.js'
import type { LoadedMcp } from '../mcp.js'
import { type PeerMessage } from '../messaging.js'
import { modelDisplayName } from '../model/display.js'
import { modelControlErrorMessage } from '../model/selection.js'
import { presentChatStream, type StreamPresentationOptions } from '../stream-presentation.js'
import { errorMessage, sanitizeTerminalText } from '../terminal/sanitize.js'
import { canChooseDirectory } from '../terminal/directory-picker.js'
import { copyTerminalText } from '../terminal/terminal.js'
import {
  cloneRuntime,
  cloneTask,
  isUnresolvedBackgroundTask,
  readTaskValue,
  readyBackgroundGeneration,
} from './controller-helpers.js'
import { TurnProjector, projectMessages } from './projector.js'
import type { SetupQuestionBroker, SetupQuestionRequest } from '../setup/questions.js'
import {
  type ChatBackend,
  type ChatContextUsage,
  type ChatControllerApi,
  type ChatConversation,
  type ChatControllerOptions,
  type ChatEvent,
  type ChatNotice,
  type ChatPanel,
  type ChatPanelOptions,
  type ChatPanelRow,
  type ChatPermissionMode,
  type ChatPermissionRequest,
  type ChatRunResult,
  type ChatRuntimeInfo,
  type ChatSettings,
  type ChatSnapshot,
  type ChatTask,
  type ChatTurn,
} from './types.js'

export * from './types.js'

const EXIT_WORDS = new Set(['exit', 'quit'])
const MAX_PENDING_PEER_MESSAGES = 32
const TOOL_OUTPUT_EMIT_INTERVAL_MS = 32

const EXPORT_PYTHON = 'export:python'
const EXPORT_TYPESCRIPT = 'export:typescript'

type SessionList = Awaited<ReturnType<ChatSessionRuntime['list']>>

interface PendingUserSubmission {
  kind: 'user'
  id: string
  prompt: string
  resolve: (turn: ChatTurn | undefined) => void
}

type PendingSubmission = PendingUserSubmission | { kind: 'peer'; id: string; message: PeerMessage }

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
  private readonly _skills: ChatSkillsRuntime | undefined
  private readonly _skillNames = new Set<string>()
  private readonly _mcp: LoadedMcp | undefined
  private _settings: ChatSettings
  private readonly _streamPresentation: StreamPresentationOptions | undefined
  private readonly _setSettings: ((settings: Partial<ChatSettings>) => Promise<void>) | undefined
  private readonly _requestSetup: (() => void) | undefined
  private readonly _exportAgentProject: ChatControllerOptions['exportAgentProject']
  private readonly _project: ChatControllerOptions['project']
  private readonly _copyText: (text: string) => Promise<boolean>
  private readonly _setupQuestions: SetupQuestionBroker | undefined
  private _exportedPath: string | undefined

  private readonly _backend: ChatBackend
  private _activeProjector: TurnProjector | undefined
  private _drainingProjector: TurnProjector | undefined
  private _presentationAbort: AbortController | undefined
  private readonly _pendingSubmissions: PendingSubmission[] = []
  private _pendingSubmissionRun: Promise<void> | undefined
  private _stopWatchingTasks: (() => void) | undefined
  private _stopWatchingPermissions: (() => void) | undefined
  private _stopWatchingSetupQuestions: (() => void) | undefined
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
  private _setupGuideAnswer: string | undefined
  private _closed = false
  private _exitCode: number | undefined
  private _hardExitCode: number | undefined
  private _nextTurn: number
  private _nextNotice = 1
  private _nextPanel = 1
  private _nextSubmission = 1
  private _runtime: ChatRuntimeInfo
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
    this._settings = globalThis.structuredClone({ ...DEFAULT_CHAT_SETTINGS, ...options.settings })
    this._streamPresentation = options.streamPresentation
    this._setSettings = options.setSettings
    this._requestSetup = options.requestSetup
    this._exportAgentProject = options.exportAgentProject
    this._project = options.project
    this._copyText = options.copyText ?? copyTerminalText
    this._setupQuestions = options.setupQuestions
    const info = backend.info?.()
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
    this._stopWatchingSetupQuestions = this._setupQuestions?.subscribe((request) => {
      if (request) {
        this._openSetupQuestion(request)
      } else {
        this._closeSetupQuestion()
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

  async start(firstRequest?: string, options?: { hidePrompt?: boolean }): Promise<void> {
    if (firstRequest) {
      const prompt = firstRequest.trim()
      if (prompt.startsWith('!')) {
        await this._executeSubmission(prompt)
      } else {
        await this._runPrompt(prompt, options?.hidePrompt ? '' : prompt)
      }
    }
  }

  async submit(input: string): Promise<ChatTurn | undefined> {
    const prompt = input.trim()
    if (!prompt || this._closed) {
      return undefined
    }
    if (EXIT_WORDS.has(prompt.toLowerCase())) {
      this.close()
      return undefined
    }
    if (this._panel?.kind === 'question' && this._respondSetupQuestionText(prompt)) {
      return undefined
    }
    if (/^\/help(?:\s|$)/iu.test(prompt) && !this._resourceChanging && this._panel?.kind !== 'permission') {
      return this._executeSubmission(prompt)
    }
    if (
      this._activeProjector ||
      this._drainingProjector ||
      this._pendingSubmissionRun ||
      this._pendingSubmissions.length > 0
    ) {
      return this._enqueueSubmission(prompt)
    }
    if (this._resourceChanging) {
      return undefined
    }
    return this._executeSubmission(prompt)
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
    if (this._activeProjector && this._backend.queueSteering) {
      if (this._backend.queueSteering(prompt)) {
        return undefined
      }
    }
    const pending = this._enqueueSubmission(prompt, true)
    this.cancel()
    return pending
  }

  steerQueued(id = this._pendingSubmissions.find((pending) => pending.kind === 'user')?.id): boolean {
    if (!id || this._closed) {
      return false
    }
    const index = this._pendingSubmissions.findIndex((pending) => pending.id === id)
    if (index < 0) {
      return false
    }
    const pending = this._pendingSubmissions[index]!
    if (pending.kind !== 'user') {
      return false
    }
    if (!pending.prompt.startsWith('!') && this._activeProjector && this._backend.queueSteering) {
      if (this._backend.queueSteering(pending.prompt)) {
        this._pendingSubmissions.splice(index, 1)
        pending.resolve(undefined)
        this._emit()
        return true
      }
    }
    if (index > 0) {
      this._pendingSubmissions.splice(index, 1)
      this._pendingSubmissions.unshift(pending)
    }
    this.cancel()
    this._emit()
    return true
  }

  updateQueuedPrompt(id: string, prompt: string): boolean {
    const normalized = prompt.trim()
    const pending = this._pendingSubmissions.find(
      (candidate): candidate is PendingUserSubmission => candidate.kind === 'user' && candidate.id === id
    )
    if (!pending || !normalized) {
      return false
    }
    pending.prompt = normalized
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

  private async _executeSubmission(prompt: string): Promise<ChatTurn | undefined> {
    if (prompt.startsWith('!')) {
      return this._runShellCommand(prompt)
    }
    const directSkill = prompt.startsWith('$') ? parseCommandInvocation(prompt) : undefined
    if (directSkill) {
      const turn = await this._activateSkillAndRun(directSkill.name, directSkill.argument)
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
    return this._runStream(prompt, this._backend.streamShell(command))
  }

  private async _runPrompt(prompt: string, displayPrompt = prompt): Promise<ChatTurn | undefined> {
    if (this._closed || this._activeProjector || this._drainingProjector || this._resourceChanging) {
      return undefined
    }
    if (this._setupQuestions && displayPrompt) {
      this._setupGuideAnswer = displayPrompt
    }
    this._panel = undefined
    this._panelStack.length = 0
    return this._runStream(displayPrompt, this._backend.stream(prompt))
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
    return this._runStream(message.body, this._backend.streamPeer(message), 'peer', message.from)
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
    await this._runStream('', this._backend.streamBackgroundResults(), 'background')
  }

  private async _runStream(
    prompt: string,
    source: AsyncGenerator<ChatEvent, ChatRunResult, undefined>,
    turnSource?: ChatTurn['source'],
    peer?: ChatTurn['peer']
  ): Promise<ChatTurn> {
    const turnId = `turn-${this._nextTurn++}`
    const projector = new TurnProjector(turnId, prompt, this._backend.name, turnSource, peer)
    const usageGeneration = this._usageGeneration
    const presentationAbort = new AbortController()
    let toolOutputEmitTimer: ReturnType<typeof setTimeout> | undefined
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
      projector.fail(error)
    } finally {
      clearTimeout(toolOutputEmitTimer)
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
        const { currentTokens, projectedTokens, contextWindow } = this._context
        this._context = {
          ...(currentTokens !== undefined ? { currentTokens } : {}),
          ...(projectedTokens !== undefined ? { projectedTokens } : {}),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
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
      const projector = this._activeProjector
      projector.markCancelled()
      this._completedTurns.push(projector.snapshot())
      this._activeProjector = undefined
      this._drainingProjector = projector
      this._presentationAbort?.abort()
      this._backend.cancel()
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
    this._stopWatchingUsage()
    this._backgroundContinuationPending = false
    const interrupted = this._activeProjector !== undefined || this._drainingProjector !== undefined
    this._exitCode = interrupted && exitCode === 0 ? 130 : exitCode
    if (interrupted) {
      this._hardExitCode = this._exitCode
      this._activeProjector?.markCancelled()
      this._presentationAbort?.abort()
      this._backend.cancel()
    }
    this._resolvePendingSubmissions()
    this._emit()
  }

  async dispose(): Promise<void> {
    this._stopWatchingUsage()
    if (this._activeProjector || this._drainingProjector) {
      this._presentationAbort?.abort()
      this._backend.cancel()
    }
    this._resolvePendingSubmissions()
    this._stopWatchingTasks?.()
    this._stopWatchingTasks = undefined
    this._stopWatchingPermissions?.()
    this._stopWatchingPermissions = undefined
    this._stopWatchingSetupQuestions?.()
    this._stopWatchingSetupQuestions = undefined
    this._stopTaskActivity()
    this._listeners.clear()
    await Promise.allSettled([Promise.resolve().then(() => this._backend.dispose?.()), this._mcp?.dispose()])
  }

  private _enqueueSubmission(prompt: string, priority = false): Promise<ChatTurn | undefined> {
    return new Promise((resolve) => {
      const pending: PendingUserSubmission = {
        kind: 'user',
        id: `queued-${this._nextSubmission++}`,
        prompt,
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
        const turn = await this._executeSubmission(pending.prompt)
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
    if (
      !this._panel ||
      this._resourceChanging ||
      this._panel.kind === 'permission' ||
      this._panel.kind === 'question'
    ) {
      return false
    }
    this._stopTaskActivity()
    this._panel = this._panelStack.pop()
    this._emit()
    return true
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
          this._pushPanel('detail', selected.label, [], { body: selected.description })
        }
        return true
      }
      case 'effort':
      case 'models':
        return row.value.startsWith('effort:')
          ? this._selectEffort(row.value.slice('effort:'.length))
          : this._selectModel(row.value)
      case 'skills':
        return this._openSkillDetail(row.value)
      case 'tasks':
        return row.value === BACKGROUND_TASK_WAIT_TOGGLE
          ? this._toggleBackgroundTaskWaitMode()
          : this._openTaskDetail(row.value)
      case 'permissions':
        return this._updatePermissions(row.value)
      case 'settings':
        return row.value.startsWith('settings:')
          ? this._openSettingsCategory(row.value)
          : this._updateSetting(row.value)
      case 'export':
        if (row.value === 'export:copy-path' || row.value === 'export:copy-command') {
          return this._copyExport(row.value)
        }
        return row.value === EXPORT_TYPESCRIPT
          ? this._exportAgent('typescript')
          : row.value === EXPORT_PYTHON
            ? this._exportAgent('python')
            : false
      case 'permission':
        return this._respondPermission(row.value)
      case 'question':
        return this._respondSetupQuestion(row.value)
      default:
        return false
    }
  }

  openContextPanel(): void {
    this._openPanel('context', 'Context usage', [])
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
  }

  private _createSnapshot(): ChatSnapshot {
    const activeTurn = this._activeProjector?.snapshot()
    return {
      completedTurns: [...this._completedTurns],
      ...(activeTurn ? { activeTurn } : {}),
      queuedPrompts: this._pendingSubmissions.map((pending) => ({
        id: pending.id,
        prompt: sanitizeTerminalText(pending.kind === 'peer' ? pending.message.body : pending.prompt),
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
      ...(this._composerStatus ? { composerStatus: this._composerStatus } : {}),
      ...(this._panel ? { panel: clonePanel(this._panel) } : {}),
      runtime: cloneRuntime(this._runtime),
      settings: globalThis.structuredClone(this._settings),
      ...(this._setupQuestions ? { setupGuide: true } : {}),
      ...(this._setupGuideAnswer ? { setupGuideAnswer: this._setupGuideAnswer } : {}),
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
        this._openPanel(
          'help',
          'Help',
          helpRows(this._backend, {
            sessions: this._sessions !== undefined,
            skills: this._skills !== undefined,
            mcp: this._mcp !== undefined,
            setup: this._requestSetup !== undefined,
            export: this._exportAgentProject !== undefined,
          }),
          {
            searchable: true,
            filters: [
              { id: 'controls', label: 'Shortcuts' },
              { id: 'commands', label: 'Commands' },
              { id: 'tools', label: 'Tools' },
              { id: 'all', label: 'All' },
            ],
          }
        )
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
      case 'setup':
        this._requestSetup?.()
        break
      case 'export':
        await this._handleExportCommand(parseCommandInvocation(prompt)?.argument ?? '')
        break
      case 'exit':
        this.close()
        break
      default: {
        const turn = await this._activateSkillAndRun(command, argument)
        if (turn === null) {
          this._openError('unknown command', `/${command}`, 'Type / to browse commands or use /skills to list skills.')
        }
        break
      }
    }
  }

  private _openTasksPanel(): void {
    this._openPanel(
      'tasks',
      `tasks (${this._tasks.length})`,
      taskRows(this._tasks, this._backend.backgroundTasksWaitForCompletion?.())
    )
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
    this._openPanel('tasks', 'updating background behavior', [
      {
        label: 'Wait for completion',
        description: `Rebuilding the agent with wait for completion ${next ? 'on' : 'off'}.`,
      },
    ])
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
    const slider = effortSlider(this._backend.listEfforts?.() ?? [])
    if (!slider || slider.disabled) {
      this._openError('effort unavailable', this._runtime.model, 'This model does not support reasoning effort.')
      return
    }
    this._openPanel('effort', 'effort', [], {
      slider: { ...slider, focused: true },
      body: `${modelDisplayName(this._runtime.model)}\n${this._runtime.model}`,
    })
  }

  async openModelPanel(): Promise<void> {
    if (!this._backend.listModels) {
      this._openError('models unavailable', this._runtime.model, 'This backend does not expose model selection.')
      return
    }
    const loading = this._openPanel('models', 'models', [{ label: 'loading', description: 'Discovering models.' }])
    try {
      const models = await this._backend.listModels()
      if (this._panel?.id !== loading.id) {
        return
      }
      const efforts = this._backend.listEfforts?.() ?? []
      const slider = effortSlider(efforts)
      this._openPanel('models', `models (${models.length})`, modelRows(models, this._runtime.model), {
        searchable: true,
        filters: modelFilters(
          models.map((model) => model.catalog).filter((catalog): catalog is string => !!catalog),
          this._backend.protocol
        ),
        ...(slider ? { slider } : {}),
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
      if ((this._panel?.kind === 'models' || this._panel?.kind === 'effort') && this._panel.slider) {
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
    const loading = this._openPanel('sessions', 'sessions', [
      { label: 'loading', description: `Reading ${sessionsRuntime.directory}` },
    ])
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
    const rows = sessionRows(sessions, sessionsRuntime.directory)
    if (!panelId) {
      return this._openPanel('sessions', `sessions (${sessions.length})`, rows, { searchable: true })
    }
    const panel = this._makePanel('sessions', `sessions (${sessions.length})`, rows, { searchable: true })
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
      this._openError('sessions command failed', `/sessions ${argument}`, 'Use /sessions or /sessions rename <name>.')
      return
    }
    const name = rename[1] ?? ''
    if (!name) {
      this._openError('session rename failed', '/sessions rename', 'Use /sessions rename <name>.')
      return
    }
    if (!this._sessions?.renameCurrent || this._backend.protocol !== 'strands') {
      this._openError('session rename unavailable', name, 'The current backend does not expose a file-backed session.')
      return
    }
    this._resourceChanging = true
    try {
      const renamed = await this._sessions.renameCurrent(name)
      this._runtime.session = renamed.name
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

  private async _openSkillsPanel(): Promise<void> {
    if (!this._skills || this._backend.protocol !== 'strands') {
      this._openError('skills unavailable', 'skills', 'No skills runtime is configured for this backend.')
      return
    }
    const loading = this._openPanel('skills', 'skills', [
      { label: 'loading', description: 'Parsing configured skills with the Strands SDK.' },
    ])
    try {
      const skills = await this._skills.list()
      if (this._panel?.id !== loading.id) {
        return
      }
      this._skillDetails.clear()
      for (const skill of skills) {
        this._skillDetails.set(skill.name, skill)
        this._skillNames.add(skill.name.toLowerCase())
      }
      this._openPanel('skills', `skills (${skills.length})`, skillRows(skills), {
        searchable: true,
        ...(this._skills.paths?.length ? { body: `Checked: ${this._skills.paths.join(', ')}` } : {}),
      })
    } catch (error) {
      if (this._panel?.id === loading.id) {
        this._openError('skill discovery failed', 'skills', errorMessage(error))
      }
    }
  }

  private async _activateSkillAndRun(name: string, argument: string): Promise<ChatTurn | null | undefined> {
    if (!this._skills || this._backend.protocol !== 'strands') {
      return null
    }
    this._resourceChanging = true
    let skill: SkillInfo | undefined
    try {
      skill = await this._skills.activate(name)
    } catch (error) {
      this._openError('skill activation failed', name, errorMessage(error))
      return undefined
    } finally {
      this._resourceChanging = false
    }
    if (!skill) {
      return null
    }
    this._skillNames.add(skill.name.toLowerCase())
    this._skillDetails.set(skill.name, skill)
    return this._runPrompt(argument || `Use the ${skill.name} skill.`)
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
      if (await this._backend.compact()) {
        this._context = {}
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
    this._resourceChanging = true
    this._openPanel('progress', 'starting fresh conversation', [
      { label: this._backend.name, description: 'Rebuilding through createHarness() without restoring context.' },
    ])
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
    }
  }

  private _openSkillDetail(name: string): boolean {
    const skill = this._skillDetails.get(name)
    if (!skill) {
      return false
    }
    this._pushPanel('detail', `skill: ${skill.name}`, skillDetailRows(skill), {
      body: skill.instructions || '(No instructions.)',
    })
    return true
  }

  private async _openMcpPanel(): Promise<void> {
    if (!this._mcp) {
      this._openError('MCP unavailable', 'mcp', 'No MCP runtime is configured.')
      return
    }
    const loading = this._openPanel('mcp', 'MCP servers', [
      { label: 'loading', description: 'Checking server connections and tools.' },
    ])
    try {
      const servers = await this._mcp.list(true)
      if (this._panel?.id !== loading.id) {
        return
      }
      this._openPanel(
        'mcp',
        `MCP servers (${servers.length})`,
        mcpRows(servers),
        mcpOptions(servers, this._mcp.paths, this._mcp.warnings)
      )
    } catch (error) {
      if (this._panel?.id === loading.id) {
        this._openError('MCP connection failed', 'mcp', errorMessage(error))
      }
    }
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

  private _openPermissionsPanel(): void {
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
    this._openPanel('permissions', 'permissions', permissionSettingsRows(status, this._runtime.tools), {
      ...(status.mode === 'bypassPermissions'
        ? { body: 'WARNING: Permission checks are bypassed. Configured interventions and sandboxing still apply.' }
        : {}),
    })
  }

  private async _updatePermissions(value: string): Promise<boolean> {
    const [prefix, action, encodedValue] = value.split(':')
    if (prefix !== 'permissions' || !action || !encodedValue) {
      return false
    }
    if (action === 'mode' && (encodedValue === 'default' || encodedValue === 'bypassPermissions')) {
      return this._setPermissionMode(encodedValue)
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
      this._openPermissionsPanel()
      return true
    } catch (error) {
      this._openError('permission update failed', toolName, errorMessage(error))
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
      this._openPermissionsPanel()
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
    const path = destination.startsWith('~/') ? resolve(homedir(), destination.slice(2)) : destination
    await this._exportAgent(language, resolve(this._runtime.cwd, path))
  }

  private _openExportPanel(): void {
    if (!this._exportAgentProject) {
      this._openError('export unavailable', '/export', 'This connection cannot export an agent project.')
      return
    }
    this._exportedPath = undefined
    this._openPanel(
      'export',
      `Export · ${this._backend.name}`,
      [
        {
          label: 'TypeScript',
          description: 'Runnable @strands-agents/harness project',
          value: EXPORT_TYPESCRIPT,
        },
        {
          label: 'Python',
          description: 'Runnable strands-harness project',
          value: EXPORT_PYTHON,
        },
      ].filter((row) => !this._project || row.value === `export:${this._project.language}`),
      {
        body: [
          `Agent: ${this._backend.name}`,
          `Source: ${this._project?.entrypoint ?? 'Current agent configuration'}`,
          `Location: ${this._project?.root ?? this._runtime.cwd}`,
          this._project
            ? `Language: ${this._project.language === 'typescript' ? 'TypeScript' : 'Python'} · preserves authored source`
            : 'Choose a language, then choose where to save the ZIP.',
          ...(!canChooseDirectory()
            ? [`Save with /export ${this._project?.language ?? '<typescript|python>'} <path.zip>.`]
            : []),
        ].join('\n'),
      }
    )
  }

  private async _exportAgent(language: 'typescript' | 'python', destination?: string): Promise<boolean> {
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
      const path = await this._exportAgentProject(language, destination)
      if (path) {
        this._exportedPath = path
        this._openPanel(
          'export',
          'Export complete',
          [
            { label: 'Copy path', description: path, value: 'export:copy-path' },
            { label: 'Copy launch command', description: agentLaunchCommand(path), value: 'export:copy-command' },
          ],
          {
            body: [
              `Agent: ${this._backend.name}`,
              `Source: ${this._project?.entrypoint ?? 'Current agent configuration'}`,
              `Language: ${language === 'typescript' ? 'TypeScript' : 'Python'}`,
              `Saved to: ${path}`,
            ].join('\n'),
          }
        )
      } else if (destination === undefined && !canChooseDirectory()) {
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
    if (setting === 'setup') {
      if (!this._requestSetup) return false
      this._requestSetup()
      return true
    }
    const update = parseSettingUpdate(setting, this._settings)
    if (!update) {
      return false
    }
    this._resourceChanging = true
    try {
      await this._setSettings?.(update)
    } catch (error) {
      this._openError('setting update failed', setting.split('=')[0]!, errorMessage(error))
      return false
    } finally {
      this._resourceChanging = false
    }
    this._settings = globalThis.structuredClone({ ...this._settings, ...update })
    this._panel = {
      ...this._panel,
      rows: sanitizeRows(
        settingsRows(
          this._settings,
          this._requestSetup !== undefined,
          this._panel.settingsCategory ?? DEFAULT_SETTINGS_CATEGORY
        )
      ),
    }
    this._emit()
    return true
  }

  private _openSettingsCategory(value: string, replace = false): boolean {
    const category = SETTINGS_CATEGORIES.find(({ id }) => value === `settings:${id}`)
    if (!category) {
      return false
    }
    const rows = settingsRows(this._settings, this._requestSetup !== undefined, category.id)
    const options: ChatPanelOptions = {
      filters: settingsCategoryFilters(),
      settingsCategory: category.id,
      settingsCategories: SETTINGS_CATEGORIES,
    }
    if (replace) {
      this._openPanel('settings', category.label, rows, options)
    } else if (this._panel?.kind === 'settings') {
      this._panel = this._makePanel('settings', category.label, rows, options)
      this._emit()
    } else {
      this._pushPanel('settings', category.label, rows, options)
    }
    return true
  }

  private _respondPermission(value: string): boolean {
    const [prefix, encodedRequestId, encodedOptionId] = value.split(':')
    if (prefix !== 'permission' || !encodedRequestId || !encodedOptionId) {
      return false
    }
    const requestId = decodeURIComponent(encodedRequestId)
    const optionId = decodeURIComponent(encodedOptionId)
    if (!this._backend.respondPermission?.(requestId, optionId)) {
      return false
    }
    this._closePermissionPanel()
    return true
  }

  private _respondSetupQuestion(value: string): boolean {
    const [prefix, encodedRequestId, encodedChoiceId] = value.split(':')
    if (prefix !== 'question' || !encodedRequestId || !encodedChoiceId) {
      return false
    }
    const previousAnswer = this._setupGuideAnswer
    this._setupGuideAnswer = this._panel?.rows.find((row) => row.value === value)?.label
    const responded =
      this._setupQuestions?.respond(decodeURIComponent(encodedRequestId), decodeURIComponent(encodedChoiceId)) ?? false
    if (!responded) {
      this._setupGuideAnswer = previousAnswer
    }
    return responded
  }

  private _respondSetupQuestionText(answer: string): boolean {
    const value = this._panel?.rows.find((row) => row.value?.startsWith('question:'))?.value
    const [, encodedRequestId] = value?.split(':') ?? []
    if (!encodedRequestId) {
      return false
    }
    const previousAnswer = this._setupGuideAnswer
    const normalizedAnswer = sanitizeTerminalText(answer).trim()
    this._setupGuideAnswer = normalizedAnswer
    try {
      const responded =
        this._setupQuestions?.respondText(decodeURIComponent(encodedRequestId), normalizedAnswer) ?? false
      if (!responded) {
        this._setupGuideAnswer = previousAnswer
      }
      return responded
    } catch (error) {
      this._setupGuideAnswer = previousAnswer
      throw error
    }
  }

  private _openPermissionPanel(request: ChatPermissionRequest): void {
    this._pushPanel('permission', `Allow ${request.toolName}?`, permissionRequestRows(request), {
      body: formatPermissionPanelBody(request),
      ...(request.diff ? { diff: request.diff } : {}),
    })
  }

  private _openSetupQuestion(request: SetupQuestionRequest): void {
    this._setupGuideAnswer = undefined
    this._pushPanel('question', 'Dr. Harness', setupQuestionRows(request), { body: request.question })
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
  }

  private _closePermissionPanel(): void {
    if (this._panel?.kind !== 'permission') {
      return
    }
    this._panel = this._panelStack.pop()
    this._emit()
  }

  private _closeSetupQuestion(): void {
    if (this._panel?.kind !== 'question') {
      return
    }
    this._panel = this._panelStack.pop()
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
      this._panel = {
        ...this._panel,
        title: `tasks (${this._tasks.length})`,
        rows: sanitizeRows(taskRows(this._tasks, this._backend.backgroundTasksWaitForCompletion?.())),
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
    this._pushPanel('detail', taskDetailTitle(task, activity), taskDetailRows(task, activity), {
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
    const slider = effortSlider(this._backend.listEfforts?.() ?? [])
    const updated = this._makePanel('models', panel.title, rows, {
      ...(panel.searchable !== undefined ? { searchable: panel.searchable } : {}),
      ...(panel.filters ? { filters: panel.filters } : {}),
      ...(slider ? { slider } : {}),
      body: `${modelDisplayName(this._runtime.model)}\n${this._runtime.model}`,
    })
    this._panel = { ...updated, id: panel.id }
  }

  private _openPanel(
    kind: ChatPanel['kind'],
    title: string,
    rows: ChatPanel['rows'],
    options: ChatPanelOptions = {}
  ): ChatPanel {
    this._panelStack.length = 0
    const panel = this._makePanel(kind, title, rows, options)
    this._panel = panel
    this._emit()
    return panel
  }

  private _pushPanel(
    kind: ChatPanel['kind'],
    title: string,
    rows: ChatPanel['rows'],
    options: ChatPanelOptions
  ): ChatPanel {
    if (this._panel) {
      this._panelStack.push(this._panel)
    }
    const panel = this._makePanel(kind, title, rows, options)
    this._panel = panel
    this._emit()
    return panel
  }

  private _makePanel(
    kind: ChatPanel['kind'],
    title: string,
    rows: ChatPanel['rows'],
    options: ChatPanelOptions
  ): ChatPanel {
    return makePanel(`panel-${this._nextPanel++}`, kind, title, rows, options)
  }

  private _openError(title: string, label: string, description: string): void {
    this._openPanel('error', title, [{ label, description, tone: 'danger' }])
  }
}
