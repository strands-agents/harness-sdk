import { createInterface } from 'node:readline'

const input = createInterface({ input: process.stdin })
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)

input.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  if (request.method === 'initialize') {
    send(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'platform-integration', version: '1.0.0' },
    })
  } else if (request.method === 'tools/list') {
    send(request.id, {
      tools: [{ name: 'probe', description: 'Return a deterministic marker.', inputSchema: { type: 'object' } }],
    })
  } else if (request.method === 'tools/call') {
    send(request.id, {
      content: [{ type: 'text', text: JSON.stringify({ marker: 'platform-mcp-ok', pid: process.pid }) }],
    })
  } else {
    send(request.id, {})
  }
})
