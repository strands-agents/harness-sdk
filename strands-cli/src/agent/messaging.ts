import {
  AfterInvocationEvent,
  InterventionActions,
  InterventionHandler,
  Message,
  MessageAddedEvent,
  TextBlock,
  tool,
  type BeforeModelCallEvent,
  type Agent,
  type JSONValue,
  type LocalAgent,
  type Plugin,
} from '@strands-agents/sdk'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isRecord } from '../values.js'
import type { ChatBackend, ChatEvent, ChatRunResult } from './types.js'

interface BackgroundAgentEndpoint {
  taskId: string
  name: string
  task: string
  toolUseId: string
  agent?: Agent
}

type BackgroundAgentEndpointEvent =
  | {
      type: 'available'
      endpoint: BackgroundAgentEndpoint
    }
  | {
      type: 'unavailable'
      taskId: string
    }

interface BackgroundAgentDescriptor {
  taskId?: string
  name: string
  task: string
}

type BackgroundAgentEndpointListener = (event: BackgroundAgentEndpointEvent) => void

export class BackgroundAgentInbox {
  private readonly _scope = new AsyncLocalStorage<string>()
  private readonly _descriptors = new Map<string, BackgroundAgentDescriptor>()
  private readonly _targets = new Map<string, { enqueue: (prompt: string) => boolean; agent?: Agent }>()
  private readonly _toolUseByTask = new Map<string, string>()
  private readonly _availableTasks = new Set<string>()
  private readonly _settledTools = new Set<string>()
  private readonly _listeners = new Set<BackgroundAgentEndpointListener>()

  run<T>(toolUseId: string, operation: () => Promise<T>): Promise<T> {
    return this._scope.run(toolUseId, operation)
  }

  start(toolUseId: string, name: string, task: string): void {
    this._settledTools.delete(toolUseId)
    const existing = this._descriptors.get(toolUseId)
    this._descriptors.set(toolUseId, {
      ...(existing?.taskId ? { taskId: existing.taskId } : {}),
      name,
      task,
    })
    this._publishAvailable(toolUseId)
  }

  observeAgent(enqueue: (prompt: string) => boolean, agent?: Agent): (() => void) | undefined {
    const toolUseId = this._scope.getStore()
    if (!toolUseId || this._settledTools.has(toolUseId) || this._targets.has(toolUseId)) {
      return undefined
    }
    this._targets.set(toolUseId, { enqueue, ...(agent ? { agent } : {}) })
    this._publishAvailable(toolUseId)
    return () => {
      if (this._targets.get(toolUseId)?.enqueue !== enqueue) {
        return
      }
      this._targets.delete(toolUseId)
      const taskId = this._descriptors.get(toolUseId)?.taskId
      if (taskId) {
        this._closeTask(taskId)
      }
    }
  }

  linkTask(taskId: string, toolUseId: string): void {
    if (this._settledTools.has(toolUseId)) {
      return
    }
    const previousToolUseId = this._toolUseByTask.get(taskId)
    if (previousToolUseId && previousToolUseId !== toolUseId) {
      this._closeTask(taskId)
    }
    const descriptor = this._descriptors.get(toolUseId) ?? { name: 'subagent', task: '' }
    this._descriptors.set(toolUseId, { ...descriptor, taskId })
    this._toolUseByTask.set(taskId, toolUseId)
    this._publishAvailable(toolUseId)
  }

  send(taskId: string, prompt: string): boolean {
    const toolUseId = this._toolUseByTask.get(taskId)
    const target = toolUseId ? this._targets.get(toolUseId) : undefined
    return target?.enqueue(prompt) ?? false
  }

  complete(toolUseId: string): void {
    this._settledTools.add(toolUseId)
    const taskId = this._descriptors.get(toolUseId)?.taskId
    if (taskId) {
      this._closeTask(taskId)
    }
    this._targets.delete(toolUseId)
    this._descriptors.delete(toolUseId)
  }

  subscribe(listener: BackgroundAgentEndpointListener): () => void {
    this._listeners.add(listener)
    return () => {
      this._listeners.delete(listener)
    }
  }

  dispose(): void {
    for (const taskId of [...this._availableTasks]) {
      this._closeTask(taskId)
    }
    this._targets.clear()
    this._descriptors.clear()
    this._toolUseByTask.clear()
    this._settledTools.clear()
    this._listeners.clear()
  }

  private _publishAvailable(toolUseId: string): void {
    const descriptor = this._descriptors.get(toolUseId)
    const taskId = descriptor?.taskId
    if (!descriptor || !taskId || !this._targets.has(toolUseId) || this._availableTasks.has(taskId)) {
      return
    }
    this._availableTasks.add(taskId)
    this._publish({
      type: 'available',
      endpoint: {
        taskId,
        name: descriptor.name,
        task: descriptor.task,
        toolUseId,
        ...(this._targets.get(toolUseId)?.agent ? { agent: this._targets.get(toolUseId)!.agent } : {}),
      },
    })
  }

  private _closeTask(taskId: string): void {
    const toolUseId = this._toolUseByTask.get(taskId)
    this._toolUseByTask.delete(taskId)
    if (toolUseId) {
      const descriptor = this._descriptors.get(toolUseId)
      if (descriptor?.taskId === taskId) {
        this._descriptors.set(toolUseId, { name: descriptor.name, task: descriptor.task })
      }
    }
    if (!this._availableTasks.delete(taskId)) {
      return
    }
    this._publish({ type: 'unavailable', taskId })
  }

  private _publish(event: BackgroundAgentEndpointEvent): void {
    for (const listener of this._listeners) {
      listener(event)
    }
  }
}

const MAX_MESSAGE_CHARS = 20_000
const PEER_MESSAGE_METADATA_KEY = 'strands.peerMessage'

type PeerParticipant = {
  id: string
  name: string
}

export interface PeerMessage {
  from: PeerParticipant
  body: string
}

interface PeerEndpoint extends Omit<PeerEndpointInfo, 'status'> {
  status(): PeerEndpointInfo['status'] | undefined
  enqueue(message: PeerMessage): boolean | Promise<boolean>
  chat?: {
    attached?: boolean
    backend: ChatBackend
    prompt: string
    stream: AsyncGenerator<ChatEvent, ChatRunResult, undefined>
  }
}

export type PeerEndpointInfo = PeerParticipant & {
  status: 'idle' | 'working'
  description?: string
  backgroundTask?: { id: string; ownerId: string }
}

/** @internal */
export interface PeerMessageRouter {
  list(senderId: string): readonly PeerEndpointInfo[] | Promise<readonly PeerEndpointInfo[]>
  send(senderId: string, to: string, body: string): string | Promise<string>
}

export class AgentMessaging {
  private readonly _endpoints = new Map<string, PeerEndpoint>()
  private readonly _agentEndpoints = new WeakMap<object, string>()
  private readonly _listeners = new Set<() => void>()

  register(endpoint: PeerEndpoint): void {
    if (this._endpoints.has(endpoint.id)) {
      throw new Error(`Peer endpoint ${JSON.stringify(endpoint.id)} is already registered.`)
    }
    this._endpoints.set(endpoint.id, endpoint)
    this._emit()
  }

  getEndpoint(id: string): PeerEndpoint | undefined {
    return this._endpoints.get(id)
  }

  rename(id: string, name: string): void {
    const endpoint = this._endpoints.get(id)
    if (endpoint) {
      endpoint.name = name
      this._emit()
    }
  }

  unregister(id: string): void {
    if (this._endpoints.delete(id)) {
      this._emit()
    }
  }

  list(senderId?: string): readonly PeerEndpointInfo[] {
    if (senderId !== undefined) this._requireSender(senderId)
    const peers: PeerEndpointInfo[] = []
    for (const endpoint of this._endpoints.values()) {
      const status = endpoint.status()
      if (endpoint.id !== senderId && status) {
        peers.push({
          id: endpoint.id,
          name: endpoint.name,
          status,
          ...(endpoint.description ? { description: endpoint.description } : {}),
          ...(endpoint.backgroundTask ? { backgroundTask: endpoint.backgroundTask } : {}),
        })
      }
    }
    return peers.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener)
    listener()
    return () => {
      this._listeners.delete(listener)
    }
  }

  unbindAgent(agent: LocalAgent): void {
    this._agentEndpoints.delete(agent)
  }

  bindAgent(agent: LocalAgent, endpointId: string): void {
    this._agentEndpoints.set(agent, endpointId)
  }

  createPlugin(
    endpointId: string,
    router: PeerMessageRouter = this
  ): Required<Pick<Plugin, 'name' | 'initAgent' | 'getTools'>> {
    const messageAgent = tool({
      name: 'message_agent',
      description: 'List the other live agents or send one an asynchronous message.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'send'],
            description: 'List available agents or send a message.',
          },
          to: {
            type: 'string',
            description: 'Target agent ID returned by the list action.',
          },
          message: {
            type: 'string',
            description: 'Complete message to deliver to the target agent.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      callback: (input, context) => {
        if (!context) throw new Error('Tool context is required for agent_message.')
        const parsed = readAgentMessageInput(input)
        const senderId = this._requireSenderId(context.agent)
        if (parsed.action === 'list') {
          const peers = router.list(senderId)
          const listResult = (
            agents: readonly PeerEndpointInfo[]
          ): { agents: Omit<PeerEndpointInfo, 'backgroundTask'>[] } => ({
            agents: agents.map(({ backgroundTask: _backgroundTask, ...agent }) => agent),
          })
          return peers instanceof Promise ? peers.then(listResult) : listResult(peers)
        }
        const recipient = router.send(senderId, parsed.to, parsed.message)
        return recipient instanceof Promise
          ? recipient.then((name) => ({ status: 'queued', recipient: name }))
          : { status: 'queued', recipient }
      },
    })
    return {
      name: 'strands:agent-messaging',
      initAgent: (agent): void => {
        this.bindAgent(agent, endpointId)
      },
      getTools: () => [messageAgent],
    }
  }

  private _emit(): void {
    for (const listener of this._listeners) {
      listener()
    }
  }

  send(senderId: string, to: string, body: string): string | Promise<string> {
    const sender = this._requireSender(senderId)
    if (senderId === to) {
      throw new Error('An agent cannot send a peer message to itself.')
    }
    const recipient = this._requireEndpoint(to)
    const cleanBody = body.trim()
    if (!cleanBody) {
      throw new Error('Peer message content must not be empty.')
    }
    if (cleanBody.length > MAX_MESSAGE_CHARS) {
      throw new Error(`Peer messages are limited to ${MAX_MESSAGE_CHARS.toLocaleString()} characters.`)
    }

    const message: PeerMessage = {
      from: { id: sender.id, name: sender.name },
      body: cleanBody,
    }
    const complete = (accepted: boolean): string => {
      if (!accepted) {
        throw new Error(`Agent ${JSON.stringify(to)} could not accept the peer message.`)
      }
      return recipient.name
    }
    const accepted = this.deliver(to, message)
    return accepted instanceof Promise ? accepted.then(complete) : complete(accepted)
  }

  /** @internal Receives a message whose sender was validated by the owning registry. */
  deliver(to: string, message: PeerMessage): boolean | Promise<boolean> {
    const recipient = this._requireEndpoint(to)
    if (!recipient.status()) {
      throw new Error(`Agent ${JSON.stringify(to)} is not available for peer messages.`)
    }
    return recipient.enqueue(message)
  }

  private _requireSenderId(agent: LocalAgent): string {
    const id = this._agentEndpoints.get(agent)
    if (!id) {
      throw new Error('This agent is not registered for peer messaging.')
    }
    return id
  }

  private _requireSender(id: string): PeerEndpoint {
    const sender = this._endpoints.get(id)
    if (!sender) {
      throw new Error('This agent is not registered for peer messaging.')
    }
    return sender
  }

  private _requireEndpoint(id: string): PeerEndpoint {
    const endpoint = this._endpoints.get(id)
    if (!endpoint) {
      throw new Error(`Unknown peer agent ${JSON.stringify(id)}. Use the list action to discover live agents.`)
    }
    return endpoint
  }
}

export function peerMessagePrompt(message: PeerMessage): string {
  return `Message from ${message.from.name} (${message.from.id}):\n\n${message.body}`
}

export function peerMessageMetadata(message: PeerMessage): Record<string, JSONValue> {
  return {
    [PEER_MESSAGE_METADATA_KEY]: {
      from: { id: message.from.id, name: message.from.name },
      body: message.body,
    },
  }
}

export function readPeerMessageMetadata(value: unknown): PeerMessage | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const candidate = value[PEER_MESSAGE_METADATA_KEY]
  if (!isRecord(candidate) || !isParticipant(candidate.from) || typeof candidate.body !== 'string') {
    return undefined
  }
  return {
    from: candidate.from,
    body: candidate.body,
  }
}

function readAgentMessageInput(input: unknown): { action: 'list' } | { action: 'send'; to: string; message: string } {
  if (!isRecord(input)) {
    throw new Error('message_agent input must be an object.')
  }
  if (input.action === 'list') {
    return { action: 'list' }
  }
  if (input.action !== 'send') {
    throw new Error('message_agent action must be "list" or "send".')
  }
  if (typeof input.to !== 'string' || !input.to.trim()) {
    throw new Error('message_agent requires a target agent ID for the send action.')
  }
  if (typeof input.message !== 'string') {
    throw new Error('message_agent requires message content for the send action.')
  }
  return {
    action: 'send',
    to: input.to.trim(),
    message: input.message,
  }
}

function isParticipant(value: unknown): value is PeerParticipant {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
}

export class LiveSteering extends InterventionHandler {
  readonly name = 'strands:user-message'

  private readonly _updates = new WeakMap<object, Array<{ prompt: string; onConsumed?: () => void }>>()
  private readonly _observed = new WeakSet<object>()
  constructor(private readonly _onAgentObserved?: (agent: LocalAgent) => (() => void) | undefined) {
    super()
  }

  enqueue(agent: LocalAgent, prompt: string, onConsumed?: () => void): boolean {
    const normalized = prompt.trim()
    if (!normalized) {
      return false
    }
    const updates = this._updates.get(agent) ?? []
    updates.push({ prompt: normalized, ...(onConsumed ? { onConsumed } : {}) })
    this._updates.set(agent, updates)
    return true
  }

  drain(agent: LocalAgent): string[] {
    const updates = this._take(agent)
    return updates.map((update) => update.prompt)
  }

  observeAgent(agent: LocalAgent): void {
    if (this._observed.has(agent)) {
      return
    }
    this._observed.add(agent)
    const closeObservedAgent = this._onAgentObserved?.(agent)
    let resume: { message: Message; count: number } | undefined
    agent.addHook(MessageAddedEvent, (event) => {
      if (!resume || event.message !== resume.message) return
      const updates = this._updates.get(event.agent)?.splice(0, resume.count) ?? []
      resume = undefined
      this._markConsumed(updates)
    })
    agent.addHook(AfterInvocationEvent, (event) => {
      const updates = this._updates.get(event.agent) ?? []
      if (updates.length > 0) {
        resume = {
          message: new Message({
            role: 'user',
            content: [new TextBlock(updates.map((update) => update.prompt).join('\n\n'))],
          }),
          count: updates.length,
        }
        event.resume = [resume.message]
      }
      void Promise.resolve().then(() => {
        if (event.resume === undefined) {
          closeObservedAgent?.()
        }
      })
    })
  }

  override beforeModelCall(
    event: BeforeModelCallEvent
  ): ReturnType<typeof InterventionActions.transform | typeof InterventionActions.proceed> {
    const updates = this._take(event.agent)
    if (updates.length === 0) {
      return InterventionActions.proceed()
    }
    const message = new Message({
      role: 'user',
      content: [new TextBlock(updates.map((update) => update.prompt).join('\n\n'))],
    })
    return InterventionActions.transform(
      () => {
        event.agent.messages.push(message)
        this._markConsumed(updates)
      },
      { reason: 'Additional user message' }
    )
  }

  private _take(agent: LocalAgent): Array<{ prompt: string; onConsumed?: () => void }> {
    const updates = this._updates.get(agent) ?? []
    this._updates.delete(agent)
    return updates
  }

  private _markConsumed(updates: Array<{ prompt: string; onConsumed?: () => void }>): void {
    for (const update of updates) {
      update.onConsumed?.()
    }
  }
}
