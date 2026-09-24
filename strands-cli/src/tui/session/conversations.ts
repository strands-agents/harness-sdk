import { ConversationVoice } from './voice.js'
import { sanitizePanelRow } from '../chat/panels.js'
import type {
  ChatController,
  ChatControllerApi,
  ChatPanel,
  ChatPanelRow,
  ChatSnapshot,
  ChatTurn,
  ChatVoiceStore,
} from '../chat/controller.js'
import { parseCommandInvocation } from '../chat/commands.js'
import { isUnresolvedBackgroundTask } from '../chat/controller-helpers.js'
import { errorMessage, sanitizeTerminalText } from '../terminal/sanitize.js'
import type { AgentMessaging } from '../messaging.js'
import { conversationStatus, conversationTitle, readConversationValue, unquote } from './conversation-helpers.js'
import { sessionWorkspaceLabel, type SessionTarget } from './sessions.js'
import type { VoiceInput } from '../voice/session.js'

const MANAGER_COMMANDS = new Set(['agents', 'fork', 'rename', 'voice'])
const AGENTS_PANEL_TITLE = 'Agents'

interface ConversationRecord {
  id: string
  title: string
  description: string
  controller: ChatController
  unsubscribe: () => void
}

interface ConversationManagerOptions {
  fork(source: ChatController): Promise<ChatController>
  resume?(source: ChatController, target: SessionTarget): Promise<ChatController>
  dispose?(): void | Promise<void>
  agentMessaging?: AgentMessaging
  voice?: VoiceInput
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
  private _activeId: string
  private _panel: ChatPanel | undefined
  private _snapshot: ChatSnapshot
  private _nextConversation = 2
  private _nextPanel = 1
  private _forking = false
  private _resuming = false
  private _closed = false
  private _disposed = false

  constructor(primary: ChatController, options: ConversationManagerOptions) {
    this._fork = options.fork
    this._resume = options.resume
    this._disposeShared = options.dispose
    this._agentMessaging = options.agentMessaging
    this._voice = new ConversationVoice(options.voice, () => this._active, {
      panel: (rows): void => {
        this._panel = rows ? this._makePanel('voice', 'voice', rows) : undefined
        this._emit()
      },
      error: (title, label, message): void => this._openError(title, label, message),
    })
    if (this._voice.store) {
      this.voice = this._voice.store
    }
    this._activeId = 'agent-1'
    this._addConversation(
      this._activeId,
      primary.backend.name,
      primary,
      primary.backend.info?.().description || 'Primary agent'
    )
    this._snapshot = this._buildSnapshot()
    this._stopAgentMessaging = this._agentMessaging?.subscribe(() => {
      if (this._panel?.kind === 'agents' && this._panel.title === AGENTS_PANEL_TITLE) {
        this._openAgentsPanel(false)
      }
      this._emit()
    })
    this._voice.connect(() => {
      if (this._panel?.kind === 'voice') {
        const id = this._panel.id
        this._panel = { ...this._makePanel('voice', 'voice', this._voice.rows()), id }
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

  captureConversation(conversationId = this._activeId): ReturnType<ChatController['captureConversation']> {
    if (
      this._forking ||
      this._resuming ||
      [...this._conversations.values()].some(
        ({ controller }) => controller.busy || controller.getSnapshot().tasks.some(isUnresolvedBackgroundTask)
      )
    ) {
      return Promise.reject(
        new Error('Finish or cancel running work in all conversations before applying setup changes.')
      )
    }
    const conversation = this._conversations.get(conversationId)
    if (!conversation) {
      return Promise.reject(new Error('The conversation that requested setup is no longer available.'))
    }
    return conversation.controller.captureConversation()
  }

  pauseVoiceInput(): (target: ChatControllerApi) => void {
    return this._voice.pauseInput()
  }

  showError(title: string, message: string): void {
    this._openError(title, '', message)
  }

  get busy(): boolean {
    return this._forking || this._resuming || this._active.controller.busy
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

  start(firstRequest?: string, options?: { hidePrompt?: boolean }): Promise<void> {
    return this._active.controller.start(firstRequest, options)
  }

  async submit(input: string): Promise<ChatTurn | undefined> {
    const prompt = input.trim()
    if (!prompt || this._closed) {
      return undefined
    }
    if (['exit', 'quit', '/exit'].includes(prompt.toLowerCase())) {
      this.close()
      return undefined
    }
    const invocation = parseCommandInvocation(prompt)
    const command = invocation?.prefix === '/' ? invocation.name.toLowerCase() : undefined
    const argument = invocation?.argument ?? ''
    if (command === 'agents') {
      this._openAgentsPanel()
      return undefined
    }
    if (command === 'fork') {
      return this._forkConversation(unquote(argument))
    }
    if (command === 'rename') {
      this._renameConversation(unquote(argument))
      return undefined
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
    const invocation = parseCommandInvocation(input.trim())
    if (invocation?.prefix === '/' && MANAGER_COMMANDS.has(invocation.name.toLowerCase())) {
      return this.submit(input)
    }
    return this._active.controller.steer(input)
  }

  steerQueued(id?: string): boolean {
    return this._active.controller.steerQueued(id)
  }

  updateQueuedPrompt(id: string, prompt: string): boolean {
    return this._active.controller.updateQueuedPrompt(id, prompt)
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
    await Promise.allSettled([
      ...[...this._conversations.values()].map((conversation) => conversation.controller.dispose()),
      this._voice.dispose(),
      this._disposeShared?.(),
    ])
    this._listeners.clear()
    this._voice.clearListeners()
  }

  dismissPanel(): boolean {
    if (this._panel) {
      this._panel = undefined
      this._emit()
      return true
    }
    return this._active.controller.dismissPanel()
  }

  async activatePanelRow(row: ChatPanelRow): Promise<boolean> {
    if (this._panel?.kind === 'voice') {
      return row.value ? this._voice.handlePanelAction(row.value) : false
    }
    if (this._panel?.kind === 'agents') {
      const id = readConversationValue(row.value)
      return id ? this._switchConversation(id) : false
    }
    if (!this._panel && this._snapshot.panel?.kind === 'sessions' && row.value && this._resume) {
      return this._resumeConversation(row.value)
    }
    return this._active.controller.activatePanelRow(row)
  }

  openModelPanel(): Promise<void> {
    this._panel = undefined
    return this._active.controller.openModelPanel()
  }

  openContextPanel(): void {
    this._panel = undefined
    this._active.controller.openContextPanel()
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
    const blocked = source.controller.sessionResumeBlockReason()
    if (blocked) {
      this._openError('session resume blocked', target.sessionId, blocked)
      return false
    }
    if (this._resuming || !this._resume) {
      return false
    }

    this._resuming = true
    const workspace = sessionWorkspaceLabel(target.workspace, target.sessionDirectory)
    const title = target.name ?? target.sessionId
    this._panel = this._makePanel('sessions', 'Opening saved session', [
      {
        label: title,
        description: `Starting a separate conversation in ${target.workspace}.`,
      },
    ])
    this._emit()
    try {
      const controller = await this._resume(source.controller, target)
      if (this._closed || this._disposed) {
        controller.close()
        await controller.dispose()
        return false
      }
      const id = `agent-${this._nextConversation++}`
      this._addConversation(id, `${title} · ${workspace}`, controller, 'Saved session')
      this._activeId = id
      this._panel = undefined
      this._emit()
      return true
    } catch (error) {
      this._openError('session resume failed', target.sessionId, errorMessage(error))
      return false
    } finally {
      this._resuming = false
      this._emit()
    }
  }

  private async _forkConversation(prompt: string): Promise<ChatTurn | undefined> {
    const source = this._active
    if (source.controller.backend.reconstructable?.() === false) {
      this._openError(
        'fork unavailable',
        source.title,
        'This source must expose a reconstructable agent factory before it can be forked.'
      )
      return undefined
    }
    if (source.controller.busy) {
      this._openError(
        'fork unavailable',
        source.title,
        'Wait for this turn to finish or interrupt it before forking the conversation.'
      )
      return undefined
    }
    if (this._forking) {
      return undefined
    }

    this._forking = true
    this._panel = this._makePanel('agents', 'Forking agent', [
      {
        label: prompt ? conversationTitle(prompt) : `Fork ${this._nextConversation}`,
        description: `Copying ${source.title} with its current conversation and agent configuration.`,
      },
    ])
    this._emit()
    try {
      const controller = await this._fork(source.controller)
      if (this._closed || this._disposed) {
        controller.close()
        await controller.dispose()
        return undefined
      }
      const id = `agent-${this._nextConversation++}`
      const title = prompt ? conversationTitle(prompt) : `Fork ${this._nextConversation - 1}`
      this._addConversation(id, title, controller, `Fork of ${source.title}`)
      this._activeId = id
      this._panel = undefined
      this._emit()
      return prompt ? controller.submit(prompt) : undefined
    } catch (error) {
      this._openError('fork failed', source.title, errorMessage(error))
      return undefined
    } finally {
      this._forking = false
      this._emit()
    }
  }

  private _addConversation(id: string, title: string, controller: ChatController, description: string): void {
    const endpointId = controller.peerEndpointId ?? id
    const streamSpokenReply = this._voice.followConversation(controller, () => endpointId === this._activeId)
    const record: ConversationRecord = {
      id: endpointId,
      title: sanitizeTerminalText(title),
      description: sanitizeTerminalText(description),
      controller,
      unsubscribe: controller.subscribe(() => {
        streamSpokenReply()
        if (this._panel?.kind === 'agents') {
          this._openAgentsPanel(false)
        }
        this._emit()
      }),
    }
    this._conversations.set(endpointId, record)
    this._agentMessaging?.rename(endpointId, record.title)
  }

  private _switchConversation(id: string): boolean {
    if (!this._conversations.has(id)) {
      return false
    }
    this._activeId = id
    this._panel = undefined
    this._emit()
    return true
  }

  private _renameConversation(name: string): void {
    const title = conversationTitle(name)
    if (!name.trim()) {
      this._openError('rename failed', '/rename', 'Use /rename <name> to name the currently viewed agent.')
      return
    }
    this._active.title = title
    this._agentMessaging?.rename(this._active.id, title)
    this._panel = undefined
    this._emit()
  }

  private _openAgentsPanel(emit = true): void {
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
          label: conversation.title,
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
            description: 'Live delegate',
            bold: true,
            current: false,
            badge: {
              text: endpoint.status,
              tone: 'success',
            },
          }) satisfies ChatPanelRow
      )
    this._panel = this._makePanel('agents', AGENTS_PANEL_TITLE, [...conversations, ...generalists])
    if (existingId) {
      this._panel = { ...this._panel, id: existingId }
    }
    if (emit) {
      this._emit()
    }
  }

  private _openError(title: string, label: string, description: string): void {
    this._panel = this._makePanel('error', title, [{ label, description, tone: 'danger' }])
    this._emit()
  }

  private _makePanel(kind: ChatPanel['kind'], title: string, rows: readonly ChatPanelRow[]): ChatPanel {
    return {
      id: `manager-panel-${this._nextPanel++}`,
      kind,
      title: sanitizeTerminalText(title),
      rows: rows.map((row) => ({
        ...sanitizePanelRow(row),
        ...(row.section !== undefined ? { section: sanitizeTerminalText(row.section) } : {}),
      })),
    }
  }

  private _buildSnapshot(): ChatSnapshot {
    const active = this._active.controller.getSnapshot()
    const { panel: activePanel, ...base } = active
    const panel = activePanel?.kind === 'permission' ? activePanel : (this._panel ?? activePanel)
    return {
      ...base,
      ...(panel ? { panel } : {}),
      status: this._closed ? 'closed' : active.status,
      ...(this._voice.snapshot ? { voice: { ...this._voice.snapshot } } : {}),
      runtime: {
        ...active.runtime,
        configuration: [
          ...(active.runtime.configuration ?? []),
          { label: 'agent', value: `${this._active.title} (${this._conversations.size} total)` },
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
