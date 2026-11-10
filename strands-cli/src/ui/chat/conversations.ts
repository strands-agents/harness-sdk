import { ConversationVoice } from './voice.js'
import { makePanel } from './panel-state.js'
import {
  ChatController,
  type ChatControllerApi,
  type NewChatPanel,
  type ChatPanel,
  type ChatPanelRow,
  type ChatSnapshot,
  type ChatSettings,
  type ChatVoiceStore,
} from './controller.js'
import type { ChatConversations, ChatInput, ChatTurn } from '../../agent/types.js'
import { parseCommandInvocation, unquote, type CommandAssistance } from './commands.js'
import { isUnresolvedBackgroundTask, conversationStatus, conversationTitle, readConversationValue } from './state.js'
import { errorMessage, sanitizeTerminalText } from '../../terminal/text.js'
import type { AgentMessaging } from '../../agent/messaging.js'
import type { ImportedAgentProject } from '../../project/import.js'
import { watchAgentProject } from '../../project/watch.js'
import { sessionWorkspaceLabel, type SessionTarget } from '../../session/sessions.js'
import type { VoiceInput } from '../../agent/voice.js'

const MANAGER_COMMANDS = new Set(['agents', 'fork', 'voice', 'rename'])
const AGENTS_PANEL_TITLE = 'Agents'

interface ConversationRecord {
  id: string
  description: string
  controller: ChatController
  unsubscribe: () => void
}

export interface InitialConversations {
  activeId: string
  entries: readonly (Omit<ConversationRecord, 'unsubscribe'> & { title: string })[]
}

interface ConversationManagerOptions {
  fork(source: ChatController): Promise<ChatController>
  resume?(source: ChatController, target: SessionTarget): Promise<ChatController>
  dispose?(): void | Promise<void>
  agentMessaging?: AgentMessaging
  voice?: VoiceInput
  project?: ImportedAgentProject
  projectPrivatePaths?: readonly string[] | null
  reloadProject?(conversationId: string, paths: readonly string[]): void
}

export class ConversationManager implements ChatControllerApi {
  readonly voice?: ChatVoiceStore
  private readonly _listeners = new Set<() => void>()
  private readonly _conversations = new Map<string, ConversationRecord>()
  private readonly _fork: ConversationManagerOptions['fork']
  private readonly _resume: ConversationManagerOptions['resume']
  private readonly _disposeShared: ConversationManagerOptions['dispose']
  private readonly _agentMessaging: AgentMessaging | undefined
  private readonly _stopAgentMessaging: (() => void) | undefined
  private readonly _voice: ConversationVoice
  private readonly _reloadProject: ConversationManagerOptions['reloadProject']
  private readonly _stopProjectWatch: (() => void) | undefined
  private _activeId: string
  private _panel: ChatPanel | undefined
  private _taskOwnerId: string | undefined
  private _snapshot: ChatSnapshot
  private _nextConversation = 2
  private _nextPanel = 1
  private _opening: 'fork' | 'resume' | undefined
  private _projectReloadPending = false
  private readonly _changedPaths = new Set<string>()
  private _sourceWatching = false
  private _closed = false
  private _disposed = false

  constructor(initial: ChatController | InitialConversations, options: ConversationManagerOptions) {
    if (!('entries' in initial)) {
      initial = {
        activeId: 'agent-1',
        entries: [
          {
            id: 'agent-1',
            title: initial.name,
            description: initial.backend.info?.().description || 'Primary agent',
            controller: initial,
          },
        ],
      }
    }
    this._fork = options.fork
    this._resume = options.resume
    this._disposeShared = options.dispose
    this._agentMessaging = options.agentMessaging
    this._reloadProject = options.reloadProject
    this._voice = new ConversationVoice(options.voice, () => this._active, {
      panel: (rows): void => {
        this._panel = rows ? this._makePanel({ kind: 'voice', title: 'Voice', rows }) : undefined
        if (!rows) {
          while (this._active.controller.dismissPanel()) {
            if (this._active.controller.getSnapshot().panel?.kind === 'error') break
          }
        }
        this._emit()
      },
      error: (title, label, message): void => this._openError(title, label, message),
    })
    if (this._voice.store) {
      this.voice = this._voice.store
    }
    this._activeId = initial.activeId
    for (const { id, title, description, controller } of initial.entries) {
      this._addConversation(id, title, controller, description)
    }
    this._snapshot = this._buildSnapshot()
    const project = options.project
    this._sourceWatching = Boolean(project && options.reloadProject && options.projectPrivatePaths !== null)
    this._stopProjectWatch =
      project && options.reloadProject && options.projectPrivatePaths !== null
        ? watchAgentProject(
            project,
            (paths = []) => {
              this.clearReloadStatus()
              for (const path of paths) this._changedPaths.add(path)
              for (const { controller } of this._conversations.values()) {
                controller.refreshConfiguration()
              }
              this._projectReloadPending = true
              this._reloadProjectIfReady()
            },
            (error) => {
              this._sourceWatching = false
              this.clearReloadStatus()
              this._openError('live reload unavailable', project.root, errorMessage(error))
            },
            options.projectPrivatePaths
          )
        : undefined
    if (project && options.reloadProject && options.projectPrivatePaths === null) {
      this._openError(
        'live reload unavailable',
        project.root,
        'Private storage could not be located. Automatic reload and export are disabled for this agent.'
      )
    }
    this._stopAgentMessaging = this._agentMessaging?.subscribe(() => {
      this._attachDelegates()
      if (this._panel?.kind === 'agents' && this._panel.title === AGENTS_PANEL_TITLE) {
        this._openAgentsPanel(false)
      }
      this._emit()
    })
    this._snapshot = this._buildSnapshot()
    this._voice.connect(() => {
      if (this._panel?.kind === 'voice') {
        const id = this._panel.id
        this._panel = { ...this._makePanel({ kind: 'voice', title: 'Voice', rows: this._voice.rows() }), id }
      }
      this._emit()
    })
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener)
    return () => {
      this._listeners.delete(listener)
    }
  }

  readonly getSnapshot = (): ChatSnapshot => this._snapshot

  get resumeSession(): ChatController['resumeSession'] {
    return this._active.controller.resumeSession
  }

  async captureConversations(): Promise<ChatConversations> {
    if (
      this._opening ||
      [...this._conversations.values()].some(
        ({ controller }) => controller.busy || controller.getSnapshot().tasks.some(isUnresolvedBackgroundTask)
      )
    ) {
      throw new Error('Finish or cancel running work in all conversations before applying setup changes.')
    }
    const entries: ChatConversations['entries'][number][] = []
    for (const { id, description, controller } of this._conversations.values()) {
      if (this._agentMessaging?.getEndpoint(id)?.backgroundTask) continue
      entries.push({ id, title: controller.name, description, conversation: await controller.captureConversation() })
    }
    return { activeId: entries.some(({ id }) => id === this._activeId) ? this._activeId : entries[0]!.id, entries }
  }

  pauseVoiceInput(): () => void {
    return this._voice.pauseInput()
  }

  clearReloadStatus(): void {
    for (const { controller } of this._conversations.values()) controller.clearReloadStatus()
  }

  markReloaded(paths: readonly string[]): void {
    this._active.controller.markReloaded(paths)
  }

  showError(title: string, message: string): void {
    this._openError(title, '', message)
  }

  get busy(): boolean {
    return this._opening !== undefined || this._active.controller.busy
  }

  get hardExitCode(): number | undefined {
    for (const conversation of this._conversations.values()) {
      if (conversation.controller.hardExitCode !== undefined) {
        return conversation.controller.hardExitCode
      }
    }
    return undefined
  }

  toggleVoiceMute(): boolean {
    return this._voice.toggleMuted()
  }

  get backend(): ChatController['backend'] {
    return this._active.controller.backend
  }

  actionableCommandToken(input: string): string | undefined {
    const invocation = parseCommandInvocation(input)
    if (invocation?.prefix === '/' && MANAGER_COMMANDS.has(invocation.name.toLowerCase())) {
      return invocation.token
    }
    return this._active.controller.actionableCommandToken(input)
  }

  commandAssistance(input: string): CommandAssistance | undefined {
    return this._active.controller.commandAssistance(input)
  }

  start(firstRequest?: string): Promise<void> {
    return this._active.controller.start(firstRequest)
  }

  async submit(input: ChatInput): Promise<ChatTurn | undefined> {
    const prompt = typeof input === 'string' ? input.trim() : input.text.trim()
    const hasAttachments = typeof input !== 'string' && input.attachments.length > 0
    if ((!prompt && !hasAttachments) || this._closed) {
      return undefined
    }
    if (!hasAttachments && ['exit', 'quit', '/exit'].includes(prompt.toLowerCase())) {
      this.close()
      return undefined
    }
    if (this._taskOwnerId && !this.dismissPanel()) return undefined
    if (hasAttachments) {
      this._panel = undefined
      this._emit()
      return this._active.controller.submit({ text: prompt, attachments: input.attachments })
    }
    const invocation = parseCommandInvocation(prompt)
    const command = invocation?.prefix === '/' ? invocation.name.toLowerCase() : undefined
    const argument = invocation?.argument ?? ''
    if (command === 'agents') {
      this._openAgentsPanel()
      return undefined
    }
    if (command === 'rename') {
      if (argument) await this._renameAgent(this._activeId, unquote(argument))
      else this._openAgentNameInput(this._activeId)
      return undefined
    }
    if (command === 'fork') {
      return this._forkConversation(unquote(argument))
    }
    if (command === 'voice') {
      await this._voice.handleCommand(argument)
      return undefined
    }
    this._panel = undefined
    this._emit()
    return this._active.controller.submit(prompt)
  }

  steer(input: string): Promise<ChatTurn | undefined> {
    if (['exit', 'quit', '/exit'].includes(input.trim().toLowerCase())) {
      return this.submit(input)
    }
    const invocation = parseCommandInvocation(input.trim())
    if (invocation?.prefix === '/' && MANAGER_COMMANDS.has(invocation.name.toLowerCase())) {
      return this.submit(input)
    }
    return this._active.controller.steer(input)
  }

  setSettings(settings: Partial<ChatSettings>): Promise<boolean> {
    return this._active.controller.setSettings(settings)
  }

  updateQueuedPrompt(id: string, prompt: string): boolean {
    return this._active.controller.updateQueuedPrompt(id, prompt)
  }

  steerQueued(id?: string): boolean {
    return this._active.controller.steerQueued(id)
  }

  removeQueuedPrompt(id: string): boolean {
    return this._active.controller.removeQueuedPrompt(id)
  }

  moveQueuedPrompt(id: string, direction: -1 | 1): boolean {
    return this._active.controller.moveQueuedPrompt(id, direction)
  }

  cancel(): boolean {
    return this._active.controller.cancel()
  }

  close(exitCode = 0): void {
    if (this._closed) {
      return
    }
    this._closed = true
    this._panel = undefined
    for (const conversation of this._conversations.values()) {
      conversation.controller.close(exitCode)
    }
    void this._voice.stop()
    this._emit()
  }

  async dispose(): Promise<void> {
    if (this._disposed) {
      return
    }
    this._disposed = true
    for (const conversation of this._conversations.values()) {
      conversation.unsubscribe()
    }
    this._voice.disconnect()
    this._stopAgentMessaging?.()
    this._stopProjectWatch?.()
    await Promise.allSettled([
      ...[...this._conversations.values()].map((conversation) => conversation.controller.dispose()),
      this._voice.dispose(),
      this._disposeShared?.(),
    ])
    this._listeners.clear()
    this._voice.clearListeners()
  }

  dismissPanel(): boolean {
    if (this._snapshot.panel?.kind === 'permission') return false
    if (this._taskOwnerId) {
      const owner = this._conversations.get(this._taskOwnerId)
      if (owner?.controller.getSnapshot().panel?.kind === 'permission') return false
      this._taskOwnerId = undefined
      owner?.controller.dismissPanel()
      this._emit()
      return true
    }
    if (this._panel?.kind === 'agents' && this._panel.renameInput) {
      delete this._panel.renameInput
      this._openAgentsPanel()
      return true
    }
    if (this._panel) {
      this._panel = undefined
      this._emit()
      return true
    }
    return this._active.controller.dismissPanel()
  }

  async activatePanelRow(row: ChatPanelRow): Promise<boolean> {
    if (this._active.controller.getSnapshot().panel?.kind === 'permission') {
      return this._active.controller.activatePanelRow(row)
    }
    if (this._taskOwnerId) {
      return this._conversations.get(this._taskOwnerId)?.controller.activatePanelRow(row) ?? false
    }
    if (this._panel?.kind === 'voice') {
      return row.value ? this._voice.handlePanelAction(row.value) : false
    }
    if (this._panel?.kind === 'agents') {
      const editing = this._panel.renameInput
      if (editing) {
        if (row.value === 'rename:cancel') return this.dismissPanel()
        if (row.value?.startsWith('rename:save:')) {
          return this._renameAgent(editing.id, decodeURIComponent(row.value.slice('rename:save:'.length)))
        }
        return false
      }
      if (row.value?.endsWith('=rename')) {
        const id = readConversationValue(row.value.slice(0, -'=rename'.length))
        return id ? this._openAgentNameInput(id) : false
      }
      const task = this._agentMessaging
        ?.list()
        .find((endpoint) => row.value === `delegate:${encodeURIComponent(endpoint.id)}`)?.backgroundTask
      if (task) return this.openTask(task.id, task.ownerId)
      const id = readConversationValue(row.value)
      return id ? this._switchConversation(id) : false
    }
    if (!this._panel && this._snapshot.panel?.kind === 'sessions' && row.value && this._resume) {
      return this._resumeConversation(row.value)
    }
    return this._active.controller.activatePanelRow(row)
  }

  openModelPanel(): Promise<void> {
    if (this._taskOwnerId && !this.dismissPanel()) return Promise.resolve()
    this._panel = undefined
    return this._active.controller.openModelPanel()
  }

  openContextPanel(): void {
    if (this._taskOwnerId && !this.dismissPanel()) return
    this._panel = undefined
    this._active.controller.openContextPanel()
  }

  openTask(taskId: string, ownerId = this._activeId): boolean {
    if (this._snapshot.panel?.kind === 'permission') return false
    const delegate = this._agentMessaging
      ?.list()
      .find((endpoint) => endpoint.backgroundTask?.id === taskId && endpoint.backgroundTask.ownerId === ownerId)
    if (delegate && this._conversations.has(delegate.id)) return this._switchConversation(delegate.id)
    const owner = this._conversations.get(ownerId)
    if (!owner?.controller.openTask(taskId)) return false
    this._taskOwnerId = ownerId
    this._emit()
    return true
  }

  returnToParent(): boolean {
    if (this._snapshot.panel?.kind === 'permission') return false
    const ownerId = this._agentMessaging?.getEndpoint(this._activeId)?.backgroundTask?.ownerId
    return ownerId !== undefined && this._switchConversation(ownerId)
  }

  openSkillDetail(name: string): boolean {
    return this._active.controller.openSkillDetail(name)
  }

  openMcpDetail(name: string): boolean {
    if (this._panel || this._closed || this._opening) {
      return false
    }
    return this._active.controller.openMcpDetail(name)
  }

  async retryMcpServer(name: string): Promise<boolean> {
    if (this._panel || this._closed || this._opening) {
      return false
    }
    return this._active.controller.retryMcpServer(name)
  }

  private get _active(): ConversationRecord {
    return this._conversations.get(this._activeId)!
  }

  private async _resumeConversation(reference: string): Promise<boolean> {
    const source = this._active
    let target: SessionTarget | undefined
    try {
      target = await source.controller.sessionTarget(reference)
    } catch (error) {
      this._openError('session resume failed', reference, errorMessage(error))
      return false
    }
    if (!target) {
      return false
    }
    if (target.active) {
      source.controller.dismissPanel()
      return true
    }
    const blocked =
      source.controller.sessionResumeBlockReason() ??
      (this._opening ? 'Wait for the conversation that is opening to finish.' : undefined)
    if (blocked) {
      this._openError('session resume blocked', target.sessionId, blocked)
      return false
    }
    if (!this._resume) {
      return false
    }

    this._opening = 'resume'
    const workspace = sessionWorkspaceLabel(target.workspace, target.sessionDirectory)
    const title = target.name ?? target.sessionId
    this._panel = this._makePanel({
      kind: 'sessions',
      title: 'Opening saved session',
      rows: [
        {
          label: title,
          description: `Starting a separate conversation in ${target.workspace}.`,
        },
      ],
    })
    this._emit()
    try {
      const controller = await this._resume(source.controller, target)
      if (this._closed || this._disposed) {
        controller.close()
        await controller.dispose()
        return false
      }
      const id = controller.peerEndpointId ?? `agent-${this._nextConversation++}`
      this._addConversation(id, target.agentName ?? `${controller.name} · ${workspace}`, controller, 'Saved session')
      this._activeId = id
      this._panel = undefined
      this._emit()
      return true
    } catch (error) {
      this._openError('session resume failed', target.sessionId, errorMessage(error))
      return false
    } finally {
      this._opening = undefined
      this._emit()
      this._reloadProjectIfReady()
    }
  }

  private async _forkConversation(prompt: string): Promise<ChatTurn | undefined> {
    const source = this._active
    if (source.controller.backend.reconstructable?.() === false) {
      this._openError(
        'fork unavailable',
        source.controller.name,
        'This source must expose a reconstructable agent factory before it can be forked.'
      )
      return undefined
    }
    if (source.controller.busy) {
      this._openError(
        'fork unavailable',
        source.controller.name,
        'Wait for this turn to finish or interrupt it before forking the conversation.'
      )
      return undefined
    }
    if (this._opening) {
      this._openError(
        'fork unavailable',
        source.controller.name,
        'Wait for the conversation that is opening to finish.'
      )
      return undefined
    }

    this._opening = 'fork'
    this._panel = undefined
    this._emit()
    try {
      const controller = await this._fork(source.controller)
      if (this._closed || this._disposed) {
        controller.close()
        await controller.dispose()
        return undefined
      }
      const id = controller.peerEndpointId ?? `agent-${this._nextConversation++}`
      const title = prompt ? conversationTitle(prompt) : `Fork ${id.slice('agent-'.length)}`
      this._addConversation(id, title, controller, `Fork of ${source.controller.name}`)
      this._activeId = id
      this._panel = undefined
      this._emit()
      return prompt ? controller.submit(prompt) : undefined
    } catch (error) {
      this._openError('fork failed', source.controller.name, errorMessage(error))
      return undefined
    } finally {
      this._opening = undefined
      this._emit()
      this._reloadProjectIfReady()
    }
  }

  private _addConversation(id: string, title: string, controller: ChatController, description: string): void {
    const endpointId = controller.peerEndpointId ?? id
    controller.setAgentName(title)
    this._nextConversation = Math.max(this._nextConversation, (Number(endpointId.slice('agent-'.length)) || 0) + 1)
    const streamSpokenReply = this._voice.followConversation(controller, () => endpointId === this._activeId)
    const record: ConversationRecord = {
      id: endpointId,
      description: sanitizeTerminalText(description),
      controller,
      unsubscribe: controller.subscribe(() => {
        streamSpokenReply()
        const panel = controller.getSnapshot().panel
        if (this._taskOwnerId === endpointId && panel?.kind !== 'detail' && panel?.kind !== 'permission') {
          this._taskOwnerId = undefined
        }
        if (this._panel?.kind === 'agents') {
          this._openAgentsPanel(false)
        }
        this._emit()
        this._reloadProjectIfReady()
      }),
    }
    this._conversations.set(endpointId, record)
    this._agentMessaging?.rename(endpointId, controller.name)
  }

  private _attachDelegates(): void {
    for (const info of this._agentMessaging?.list() ?? []) {
      if (this._conversations.has(info.id)) continue
      const endpoint = this._agentMessaging?.getEndpoint(info.id)
      if (!endpoint?.chat) continue
      const owner = this._conversations.get(info.backgroundTask?.ownerId ?? '')
      if (!owner) continue
      endpoint.chat.attached = true
      const controller = new ChatController(endpoint.chat.backend, {
        peerEndpointId: info.id,
        settings: owner.controller.getSnapshot().settings,
        runtime: {
          cwd: owner.controller.getSnapshot().runtime.cwd,
          version: owner.controller.getSnapshot().runtime.version,
        },
      })
      endpoint.status = (): 'working' | 'idle' => (controller.busy ? 'working' : 'idle')
      endpoint.enqueue = (message): boolean => controller.enqueuePeerMessage(message, true)
      this._addConversation(info.id, info.name, controller, info.description ?? `Subagent of ${owner.controller.name}`)
      void controller.follow(endpoint.chat.prompt, endpoint.chat.stream)
    }
  }

  private _openAgentNameInput(id: string): boolean {
    const conversation = this._conversations.get(id)
    if (!conversation) return false
    this._openAgentsPanel(false)
    this._panel = this._makePanel({
      ...this._panel!,
      kind: 'agents',
      renameInput: { id, defaultName: conversation.controller.name },
    })
    this._emit()
    return true
  }

  private async _renameAgent(id: string, name: string): Promise<boolean> {
    const conversation = this._conversations.get(id)
    if (!conversation) return false
    try {
      await conversation.controller.renameAgent(name)
      this._agentMessaging?.rename(id, conversation.controller.name)
      if (this._panel?.kind === 'agents' && this._panel.renameInput?.id === id) {
        delete this._panel.renameInput
        this._openAgentsPanel(false)
      }
      this._emit()
      return true
    } catch (error) {
      this._openError('agent rename failed', name, errorMessage(error))
      return false
    }
  }

  private _reloadProjectIfReady(): void {
    if (
      !this._projectReloadPending ||
      !this._reloadProject ||
      this._closed ||
      this._disposed ||
      this._opening ||
      [...this._conversations.values()].some(
        ({ controller }) => controller.busy || controller.getSnapshot().tasks.some(isUnresolvedBackgroundTask)
      )
    ) {
      return
    }
    this._projectReloadPending = false
    const paths = [...this._changedPaths]
    this._changedPaths.clear()
    this._reloadProject(this._activeId, paths)
  }

  private _switchConversation(id: string): boolean {
    if (!this._conversations.has(id)) {
      return false
    }
    this._activeId = id
    this._taskOwnerId = undefined
    this._panel = undefined
    this._emit()
    return true
  }

  private _openAgentsPanel(emit = true): void {
    const renameInput = this._panel?.kind === 'agents' ? this._panel.renameInput : undefined
    const existingId =
      this._panel?.kind === 'agents' && this._panel.title === AGENTS_PANEL_TITLE ? this._panel.id : undefined
    const conversations = [...this._conversations.values()]
      .sort((left, right) => {
        if (left.id === this._activeId) {
          return -1
        }
        if (right.id === this._activeId) {
          return 1
        }
        return left.id.localeCompare(right.id)
      })
      .map((conversation) => {
        const status = conversationStatus(conversation.controller.getSnapshot())
        return {
          label: conversation.controller.name,
          description: conversation.description,
          value: `conversation:${encodeURIComponent(conversation.id)}`,
          bold: true,
          current: conversation.id === this._activeId,
          badge: {
            text: status.label,
            tone: status.tone,
          },
        }
      })
    const generalists = (this._agentMessaging?.list() ?? [])
      .filter((endpoint) => !this._conversations.has(endpoint.id))
      .map(
        (endpoint) =>
          ({
            label: endpoint.name,
            description: endpoint.description ?? 'Live delegate',
            ...(endpoint.backgroundTask ? { value: `delegate:${encodeURIComponent(endpoint.id)}` } : {}),
            bold: true,
            current: false,
            badge: {
              text: endpoint.status,
              tone: 'success',
            },
          }) satisfies ChatPanelRow
      )
    this._panel = this._makePanel({
      kind: 'agents',
      title: AGENTS_PANEL_TITLE,
      ...(renameInput ? { renameInput } : {}),
      rows: [...conversations, ...generalists],
    })
    if (existingId) {
      this._panel = { ...this._panel, id: existingId }
    }
    if (emit) {
      this._emit()
    }
  }

  private _openError(title: string, label: string, description: string): void {
    this._panel = this._makePanel({
      kind: 'error',
      title,
      rows: [{ label, description, tone: 'danger' }],
    })
    this._emit()
  }

  private _makePanel(panel: NewChatPanel): ChatPanel {
    return makePanel(`manager-panel-${this._nextPanel++}`, panel)
  }

  private _buildSnapshot(): ChatSnapshot {
    const active = this._active.controller.getSnapshot()
    const { panel: activePanel, ...base } = active
    const taskPanel = this._taskOwnerId
      ? this._conversations.get(this._taskOwnerId)?.controller.getSnapshot().panel
      : undefined
    const panel = activePanel?.kind === 'permission' ? activePanel : (taskPanel ?? this._panel ?? activePanel)
    const afterTurnId = active.activeTurn?.id ?? active.completedTurns.at(-1)?.id
    const ownerId = this._agentMessaging?.getEndpoint(this._activeId)?.backgroundTask?.ownerId
    const parent = ownerId ? this._conversations.get(ownerId) : undefined
    return {
      ...base,
      conversationId: this._activeId,
      ...(parent ? { parentAgent: { id: parent.id, name: parent.controller.name } } : {}),
      ...(panel ? { panel } : {}),
      notices:
        this._opening === 'fork' && !this._closed && !this._disposed
          ? [
              ...active.notices,
              {
                id: 'manager-fork-progress',
                text: 'Forking agent…',
                status: 'running',
                ...(afterTurnId ? { afterTurnId } : {}),
              },
            ]
          : active.notices,
      status: this._closed ? 'closed' : active.status,
      ...(this._voice.snapshot ? { voice: { ...this._voice.snapshot } } : {}),
      runtime: {
        ...active.runtime,
        ...(active.runtime.devWorkspace ? { sourceWatching: this._sourceWatching } : {}),
        configuration: [
          ...(active.runtime.configuration ?? []),
          { label: 'agent', value: `${this._active.controller.name} (${this._conversations.size} total)` },
        ],
      },
    }
  }

  private _emit(): void {
    this._snapshot = this._buildSnapshot()
    for (const listener of this._listeners) {
      listener()
    }
  }
}
