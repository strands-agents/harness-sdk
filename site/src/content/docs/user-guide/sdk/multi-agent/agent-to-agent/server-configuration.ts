import express, { type Request } from 'express'
import type { User } from '@a2a-js/sdk/server'
import { Agent } from '@strands-agents/sdk'
import { A2AExpressServer } from '@strands-agents/sdk/a2a/express'

async function serverConfigExample() {
  // --8<-- [start:server_config]
  const server = new A2AExpressServer({
    agentFactory: (contextId) =>
      new Agent({ systemPrompt: 'You evaluate arithmetic expressions.' }),
    name: 'Calculator Agent',
    description: 'Evaluates arithmetic expressions',
    maxContexts: 500,
    host: '0.0.0.0',
    port: 8080,
    version: '1.2.0',
    skills: [
      {
        id: 'arithmetic',
        name: 'Arithmetic',
        description: 'Adds, subtracts, multiplies, and divides',
        tags: ['math'],
      },
    ],
  })

  await server.serve()
  // --8<-- [end:server_config]
}

async function abortExample() {
  // --8<-- [start:abort_signal]
  const server = new A2AExpressServer({
    agentFactory: (contextId) => new Agent({ systemPrompt: 'You are a helpful agent.' }),
    name: 'Helper Agent',
    port: 0, // Let the OS assign a free port
  })

  const controller = new AbortController()
  await server.serve({ signal: controller.signal })
  console.log(`Listening on port ${server.port}`)

  // Stop accepting connections
  controller.abort()
  // --8<-- [end:abort_signal]
}

function expressMiddlewareExample() {
  // --8<-- [start:express_middleware]
  const server = new A2AExpressServer({
    agentFactory: (contextId) => new Agent({ systemPrompt: 'You are a helpful agent.' }),
    name: 'Helper Agent',
    description: 'Answers general questions',
  })

  const app = express()
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })
  app.use(server.createMiddleware())

  app.listen(9000, '127.0.0.1')
  // --8<-- [end:express_middleware]
}

function userBuilderExample() {
  // --8<-- [start:user_builder]
  // Trust the identity header set by the authenticating gateway in front of this server
  const userBuilder = async (req: Request): Promise<User> => {
    const userName = req.header('x-authenticated-user')
    return { isAuthenticated: userName !== undefined, userName: userName ?? '' }
  }

  const server = new A2AExpressServer({
    agentFactory: (contextId) => new Agent({ systemPrompt: 'You are a helpful agent.' }),
    name: 'Helper Agent',
    userBuilder,
  })
  // --8<-- [end:user_builder]

  return server
}

function pathMountingExample() {
  // --8<-- [start:path_mounting]
  const server = new A2AExpressServer({
    agentFactory: (contextId) =>
      new Agent({ systemPrompt: 'You evaluate arithmetic expressions.' }),
    name: 'Calculator Agent',
    httpUrl: 'https://my-alb.example.com/calculator',
  })

  const app = express()
  app.use('/calculator', server.createMiddleware())
  app.listen(9000, '0.0.0.0')
  // --8<-- [end:path_mounting]
}

void serverConfigExample()
void abortExample()
void expressMiddlewareExample()
void userBuilderExample()
void pathMountingExample()
