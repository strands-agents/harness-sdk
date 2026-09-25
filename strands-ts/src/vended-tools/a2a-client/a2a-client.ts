import type { ClientFactory as ClientFactoryType } from '@a2a-js/sdk/client'
import type { AgentCard, TextPart } from '@a2a-js/sdk'
import { tool } from '../../tools/tool-factory.js'
import type { JSONValue } from '../../types/json.js'
import type { MessageData } from '../../types/messages.js'
import { A2AAgent } from '../../a2a/a2a-agent.js'
import { A2AStreamUpdateEvent } from '../../a2a/events.js'
import { z } from 'zod'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

/**
 * Zod schema for A2A client input validation.
 */
const a2aClientInputSchema = z.object({
  operation: z
    .enum(['discover', 'send_message'])
    .describe("Action to perform — 'discover' to fetch the agent card, or 'send_message' to send a message"),
  endpoint: z.string().describe('Base URL of the target A2A agent. Must be one of the permitted endpoints.'),
  message: z
    .string()
    .nullable()
    .optional()
    .describe("Text to send to the agent. Required when operation is 'send_message'; ignored otherwise."),
})

/**
 * Default description shown to the model for the A2A client tool.
 *
 * @example
 * ```typescript
 * import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory, RestTransportFactory, createAuthenticatingFetchWithRetry } from '@a2a-js/sdk/client'
 *
 * const authFetch = createAuthenticatingFetchWithRetry(fetch, {
 *   headers: async () => ({ Authorization: 'Bearer your-token' }),
 *   shouldRetryWithHeaders: async () => undefined,
 * })
 *
 * const a2aClient = makeA2AClient({
 *   allowedEndpoints: {
 *     'https://agent.example.com': undefined,
 *     'https://secure-agent.example.com': new ClientFactory({
 *       transports: [
 *         new JsonRpcTransportFactory({ fetchImpl: authFetch }),
 *         new RestTransportFactory({ fetchImpl: authFetch }),
 *       ],
 *       cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
 *     }),
 *   },
 * })
 * const agent = new Agent({ model, tools: [a2aClient] })
 * ```
 */
export const DEFAULT_A2A_CLIENT_DESCRIPTION =
  'Interacts with remote A2A (Agent-to-Agent) protocol agents. ' +
  "Use operation='discover' to fetch an agent card from an endpoint. " +
  "Use operation='send_message' to send a message and receive a response. " +
  'Only the listed endpoints are permitted.'

export interface MakeA2AClientOptions {
  name?: string
  description?: string
  allowedEndpoints: Record<string, ClientFactoryType | undefined>
  maxBytes?: number
}

/**
 * Create an A2A client tool that communicates with remote A2A-protocol agents.
 * Each endpoint may carry its own ClientFactory for per-endpoint authentication.
 * A fresh A2AAgent is constructed on every call (stateless).
 */
export function makeA2AClient(options: MakeA2AClientOptions): ReturnType<typeof tool> {
  const endpoints = Object.keys(options.allowedEndpoints)
  if (endpoints.length === 0) {
    throw new Error('allowedEndpoints must contain at least one endpoint')
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`maxBytes must be a positive integer, got ${String(maxBytes)}`)
  }

  const description =
    options.description ?? `${DEFAULT_A2A_CLIENT_DESCRIPTION} Permitted endpoints: ${[...endpoints].sort().join(', ')}.`

  return tool({
    name: options.name ?? 'a2a_client',
    description,
    inputSchema: a2aClientInputSchema,
    callback: async (input) => {
      const { operation, endpoint, message } = input

      if (!Object.hasOwn(options.allowedEndpoints, endpoint)) {
        throw new Error(
          `Endpoint '${endpoint}' is not in the allowed endpoints list. ` +
            `Permitted endpoints: ${[...endpoints].sort().join(', ')}`
        )
      }

      const clientFactory = options.allowedEndpoints[endpoint]
      const agent = new A2AAgent({
        url: endpoint,
        ...(clientFactory !== undefined ? { clientFactory } : {}),
      })

      if (operation === 'discover') {
        return handleDiscover(agent, maxBytes) as unknown as Promise<JSONValue>
      }

      if (operation === 'send_message') {
        if (!message) {
          throw new Error("'message' is required for send_message operation")
        }
        return handleSendMessage(agent, message, maxBytes) as unknown as Promise<JSONValue>
      }

      throw new Error(`Unknown operation: '${String(operation)}'`)
    },
  })
}

async function handleDiscover(agent: A2AAgent, maxBytes: number): Promise<AgentCard> {
  let agentCard: AgentCard
  try {
    agentCard = await agent.getAgentCard()
  } catch (error) {
    throw new Error(`Failed to discover agent card at '${agent.id}': ${String(error)}`, { cause: error })
  }

  const size = new TextEncoder().encode(JSON.stringify(agentCard)).length
  if (size > maxBytes) {
    throw new Error(`Agent card response exceeds maxBytes limit (${size} > ${maxBytes})`)
  }
  return agentCard
}

async function handleSendMessage(
  agent: A2AAgent,
  message: string,
  maxBytes: number
): Promise<{ message: MessageData }> {
  let taskState: string | undefined
  let statusText = ''
  let resultMessage: MessageData

  try {
    const gen = agent.stream(message)
    let next = await gen.next()
    while (!next.done) {
      const event = next.value instanceof A2AStreamUpdateEvent ? next.value.event : undefined
      if (event?.kind === 'task' || event?.kind === 'status-update') {
        taskState = event.status.state
        statusText = (event.status.message?.parts ?? [])
          .filter((p): p is TextPart => p.kind === 'text')
          .map((p) => p.text)
          .join(' ')
      }
      next = await gen.next()
    }
    const { role, content } = next.value.lastMessage.toJSON()
    resultMessage = { role, content }
  } catch (error) {
    throw new Error(`Failed to send message to '${agent.id}': ${String(error)}`, { cause: error })
  }

  if (taskState !== undefined && taskState !== 'completed') {
    throw new Error(
      `Remote agent at '${agent.id}' did not complete: task state is '${taskState}'. ${statusText}`.trimEnd()
    )
  }

  const result = { message: resultMessage }
  const size = new TextEncoder().encode(JSON.stringify(result)).length
  if (size > maxBytes) {
    throw new Error(`Response exceeds maxBytes limit (${size} > ${maxBytes})`)
  }
  return result
}
