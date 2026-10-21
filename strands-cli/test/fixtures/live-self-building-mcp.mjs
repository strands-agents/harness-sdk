import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
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
      serverInfo: { name: 'self-building-probe', version: '1.0.0' },
    })
  } else if (request.method === 'tools/list') {
    send(request.id, {
      tools: [
        {
          name: 'lifecycle_probe',
          description: 'Return a fresh receipt for the supplied challenge.',
          inputSchema: {
            type: 'object',
            properties: { challenge: { type: 'string' } },
            required: ['challenge'],
            additionalProperties: false,
          },
        },
      ],
    })
  } else if (request.method === 'tools/call' && request.params.name === 'lifecycle_probe') {
    const receipt = {
      challenge: request.params.arguments.challenge,
      receipt: randomUUID(),
      server: import.meta.url,
      pid: process.pid,
    }
    appendFileSync(process.env.STRANDS_CLI_TEST_MCP_AUDIT, `${JSON.stringify(receipt)}\n`)
    send(request.id, { content: [{ type: 'text', text: JSON.stringify(receipt) }] })
  } else {
    send(request.id, {})
  }
})
