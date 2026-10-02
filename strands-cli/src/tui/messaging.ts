import { tool, type JSONValue, type LocalAgent, type Plugin } from '@strands-agents/sdk'

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

interface PeerEndpoint extends PeerParticipant {
  status(): PeerEndpointInfo['status'] | undefined
  enqueue(message: PeerMessage): boolean
}

export type PeerEndpointInfo = PeerParticipant & {
  status: 'idle' | 'working'
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

  list(): readonly PeerEndpointInfo[] {
    return this._list()
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

  createPlugin(endpointId: string): Required<Pick<Plugin, 'name' | 'initAgent' | 'getTools'>> {
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
        if (parsed.action === 'list') {
          return { agents: this._list(this._requireSenderId(context.agent)) }
        }
        return {
          status: 'queued',
          recipient: this._send(context.agent, parsed.to, parsed.message),
        }
      },
    })
    return {
      name: 'strands:agent-messaging',
      initAgent: (agent): void => {
        this._agentEndpoints.set(agent, endpointId)
      },
      getTools: () => [messageAgent],
    }
  }

  private _list(senderId?: string): PeerEndpointInfo[] {
    const peers: PeerEndpointInfo[] = []
    for (const endpoint of this._endpoints.values()) {
      const status = endpoint.status()
      if (endpoint.id !== senderId && status) {
        peers.push({ id: endpoint.id, name: endpoint.name, status })
      }
    }
    return peers.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  }

  private _emit(): void {
    for (const listener of this._listeners) {
      listener()
    }
  }

  private _send(agent: LocalAgent, to: string, body: string): string {
    const senderId = this._requireSenderId(agent)
    if (senderId === to) {
      throw new Error('An agent cannot send a peer message to itself.')
    }
    const sender = this._requireEndpoint(senderId)
    const recipient = this._requireEndpoint(to)
    if (!recipient.status()) {
      throw new Error(`Agent ${JSON.stringify(to)} is not available for peer messages.`)
    }

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
    if (!recipient.enqueue(message)) {
      throw new Error(`Agent ${JSON.stringify(to)} could not accept the peer message.`)
    }
    return recipient.name
  }

  private _requireSenderId(agent: LocalAgent): string {
    const id = this._agentEndpoints.get(agent)
    if (!id || !this._endpoints.has(id)) {
      throw new Error('This agent is not registered for peer messaging.')
    }
    return id
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
