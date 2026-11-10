import { describe, expect, it, afterAll, beforeAll, afterEach } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Task } from '@a2a-js/sdk'
import express from 'express'
import { ClientFactory } from '@a2a-js/sdk/client'
import { Agent } from '@strands-agents/sdk'
import { A2AAgent, A2AStreamUpdateEvent, A2AResultEvent } from '$/sdk/a2a/index.js'
import { A2AExpressServer } from '$/sdk/a2a/express-server.js'
import { TextBlock } from '$/sdk/types/messages.js'
import { encodeBase64 } from '$/sdk/types/media.js'
import { collectGenerator } from '$/sdk/__fixtures__/model-test-helpers.js'
import { bedrock } from '../__fixtures__/model-providers.js'

describe.skipIf(bedrock.skip)('A2AExpressServer', () => {
  describe('serve', () => {
    let a2aServer: A2AExpressServer
    let abortController: AbortController

    beforeAll(async () => {
      const agent = new Agent({
        model: bedrock.createModel(),
        printer: false,
        systemPrompt: 'You are a helpful assistant. Always respond in a single short sentence.',
      })

      a2aServer = new A2AExpressServer({
        agent,
        name: 'Test A2A Agent',
        description: 'Integration test agent',
        port: 0,
      })

      abortController = new AbortController()
      await a2aServer.serve({ signal: abortController.signal })
    })

    afterAll(() => {
      abortController?.abort()
    })

    it('serves agent card at well-known endpoint', async () => {
      const factory = new ClientFactory()
      const client = await factory.createFromUrl(`http://127.0.0.1:${a2aServer.port}`)
      const card = await client.getAgentCard()

      expect(card.name).toBe('Test A2A Agent')
      expect(card.description).toBe('Integration test agent')
      expect(card.capabilities?.streaming).toBe(true)
    })

    it('processes an image sent as a file part', async () => {
      const imagePath = join(process.cwd(), 'test/integ/__resources__/yellow.png')
      const imageBytes = new Uint8Array(await readFile(imagePath))

      const factory = new ClientFactory()
      const rawClient = await factory.createFromUrl(`http://127.0.0.1:${a2aServer.port}`)

      const result = (await rawClient.sendMessage({
        message: {
          kind: 'message',
          messageId: globalThis.crypto.randomUUID(),
          role: 'user',
          parts: [
            {
              kind: 'file',
              file: { bytes: encodeBase64(imageBytes), mimeType: 'image/png' },
            },
            { kind: 'text', text: 'What color is this image? Reply with just the color name.' },
          ],
        },
      })) as Task

      expect(result.kind).toBe('task')
      expect(result.status.state).toBe('completed')

      const texts = result
        .artifacts!.flatMap((a) => a.parts)
        .filter((p) => p.kind === 'text')
        .map((p) => (p as { kind: 'text'; text: string }).text)
        .join('')

      expect(texts.toLowerCase()).toContain('yellow')
    })
  })

  describe('createMiddleware', () => {
    const servers: Server[] = []

    afterEach(() => {
      for (const server of servers) {
        server.close()
      }
      servers.length = 0
    })

    /**
     * Starts an A2A server on an OS-assigned port and returns the URL.
     */
    async function startServer(agent: Agent): Promise<{ url: string }> {
      return new Promise((resolve, reject) => {
        const app = express()
        const server = app.listen(0, 'localhost', () => {
          const { port } = server.address() as AddressInfo
          servers.push(server)

          const url = `http://localhost:${port}`
          const a2aServer = new A2AExpressServer({
            agent,
            name: 'Test Agent',
            description: 'Agent for A2A integration tests',
            httpUrl: url,
          })
          app.use(a2aServer.createMiddleware())

          resolve({ url })
        })
        server.on('error', reject)
      })
    }

    it('invoke returns AgentResult with response text', async () => {
      const agent = new Agent({
        model: bedrock.createModel({ maxTokens: 256 }),
        printer: false,
        systemPrompt: 'Respond with exactly one word: "pong".',
      })

      const { url } = await startServer(agent)
      const remoteAgent = new A2AAgent({ url })

      const result = await remoteAgent.invoke('ping')

      expect(result.stopReason).toBe('endTurn')
      expect(result.lastMessage.role).toBe('assistant')
      expect(result.lastMessage.content).toHaveLength(1)
      expect(result.lastMessage.content[0]).toBeInstanceOf(TextBlock)
      expect((result.lastMessage.content[0] as TextBlock).text.toLowerCase()).toContain('pong')
    })

    it('stream yields A2AStreamUpdateEvents and A2AResultEvent', async () => {
      const agent = new Agent({
        model: bedrock.createModel({ maxTokens: 256 }),
        printer: false,
        systemPrompt: 'Respond with exactly one word: "pong".',
      })

      const { url } = await startServer(agent)
      const remoteAgent = new A2AAgent({ url })

      const { items, result } = await collectGenerator(remoteAgent.stream('ping'))

      const streamUpdates = items.filter((e) => e instanceof A2AStreamUpdateEvent)
      const resultEvents = items.filter((e) => e instanceof A2AResultEvent)

      expect(streamUpdates.length).toBeGreaterThan(0)
      expect(resultEvents).toHaveLength(1)

      for (const update of streamUpdates) {
        expect(['message', 'task', 'status-update', 'artifact-update']).toContain(
          (update as A2AStreamUpdateEvent).event.kind
        )
      }

      expect(result.stopReason).toBe('endTurn')
      expect(result.lastMessage.role).toBe('assistant')
      expect((result.lastMessage.content[0] as TextBlock).text.toLowerCase()).toContain('pong')
    })
  })
})
