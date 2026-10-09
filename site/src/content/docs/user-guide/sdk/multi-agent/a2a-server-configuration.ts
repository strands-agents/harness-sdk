// @ts-nocheck
// NOTE: Type-checking is disabled because the examples reference remote services not available at build time.

import { Agent } from '@strands-agents/sdk'
import { A2AExpressServer } from '@strands-agents/sdk/a2a/express'

async function serverConfigExample() {
  // --8<-- [start:server_config]
  const server = new A2AExpressServer({
    agentFactory: (contextId) =>
      new Agent({
        systemPrompt: 'You are a helpful agent.',
      }),
    name: 'My Agent',
    description: 'A helpful agent',
    // Retain at most 1000 per context agents; evict least recently used
    maxContexts: 1000,
    host: '0.0.0.0',
    port: 8080,
    version: '1.0.0',
    httpUrl: 'https://my-agent.example.com', // Public URL override
    skills: [
      { id: 'math', name: 'Math', description: 'Performs calculations', tags: [] },
    ],
  })

  await server.serve()
  // --8<-- [end:server_config]
}

async function expressMiddlewareExample() {
  // --8<-- [start:express_middleware]
  const express = (await import('express')).default

  const server = new A2AExpressServer({
    agentFactory: (contextId) =>
      new Agent({ systemPrompt: 'You are a customizable agent.' }),
    name: 'My Agent',
    description: 'A customizable agent',
  })

  // Get the A2A middleware as an Express Router
  const a2aRouter = server.createMiddleware()

  // Create your own Express app with custom routes/middleware
  const app = express()
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })
  app.use(a2aRouter)

  app.listen(9000, '127.0.0.1', () => {
    console.log('Server listening on http://127.0.0.1:9000')
  })
  // --8<-- [end:express_middleware]
}

async function abortExample() {
  // --8<-- [start:abort_signal]
  const server = new A2AExpressServer({
    agentFactory: (contextId) => new Agent({ systemPrompt: 'You are a helpful agent.' }),
    name: 'My Agent',
  })

  const controller = new AbortController()
  await server.serve({ signal: controller.signal })

  // Later, to stop the server:
  controller.abort()
  // --8<-- [end:abort_signal]
}

void serverConfigExample()
void expressMiddlewareExample()
void abortExample()
