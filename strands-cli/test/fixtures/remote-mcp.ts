import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { URL } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export async function startRemoteMcpServer(
  kind: 'http' | 'sse',
  headers: Record<string, string>,
  options: { withholdSseEndpoint?: boolean } = {}
) {
  const servers: Server[] = []
  const pendingSseConnections = new Set<ServerResponse>()
  const httpSessions = new Map<string, StreamableHTTPServerTransport>()
  const sseSessions = new Map<string, SSEServerTransport>()
  const connect = async (transport: SSEServerTransport | StreamableHTTPServerTransport): Promise<void> => {
    const server = new Server({ name: 'remote-test', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: ['probe', 'probe_hidden', 'unrelated'].map((name) => ({
        name,
        description: 'Return a deterministic marker.',
        inputSchema: { type: 'object' as const },
      })),
    }))
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      if (request.params.name !== 'probe') throw new Error(`Unexpected tool: ${request.params.name}`)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ marker: 'remote-mcp-ok', client: server.getClientVersion()?.name }),
          },
        ],
      }
    })
    servers.push(server)
    await server.connect(transport as Transport)
  }
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (Object.entries(headers).some(([name, value]) => request.headers[name.toLowerCase()] !== value)) {
      response.writeHead(403).end('Missing test headers')
      return
    }
    const url = new URL(request.url!, 'http://127.0.0.1')
    if (kind === 'sse') {
      if (request.method === 'GET' && url.pathname === '/sse') {
        if (options.withholdSseEndpoint) {
          pendingSseConnections.add(response)
          response.once('close', () => pendingSseConnections.delete(response))
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.write(': waiting for endpoint\n\n')
          return
        }
        const transport = new SSEServerTransport('/messages', response)
        sseSessions.set(transport.sessionId, transport)
        await connect(transport)
        return
      }
      const transport = sseSessions.get(url.searchParams.get('sessionId') ?? '')
      if (request.method === 'POST' && url.pathname === '/messages' && transport) {
        await transport.handlePostMessage(request, response)
        return
      }
      response.writeHead(404).end()
      return
    }
    const sessionId = request.headers['mcp-session-id']
    let transport = typeof sessionId === 'string' ? httpSessions.get(sessionId) : undefined
    if (!sessionId && request.method === 'POST') {
      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          httpSessions.set(id, newTransport)
        },
      })
      await connect(newTransport)
      transport = newTransport
    }
    if (!transport) {
      response.writeHead(404).end()
      return
    }
    await transport.handleRequest(request, response)
  }
  const httpServer = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      response.writeHead(500).end(String(error))
    })
  })
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', resolve)
  })
  return {
    url: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/${kind === 'sse' ? 'sse' : 'mcp'}`,
    // Protocol negotiation can allocate a transport without establishing a session.
    connections: () => httpSessions.size + sseSessions.size,
    pendingSseConnections: () => pendingSseConnections.size,
    async close(): Promise<void> {
      await Promise.all(servers.map((server) => server.close()))
      const closed = new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()))
      })
      httpServer.closeAllConnections()
      await closed
    },
  }
}
