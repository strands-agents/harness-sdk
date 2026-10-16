import { WebSocketServer } from 'ws'

import { BedrockNovaSonicModel, BidiAgent, WebSocketIO } from '@strands-agents/sdk/bidi'

const server = new WebSocketServer({ port: 8080 })
console.log('listening on ws://localhost:8080')

server.on('connection', (socket) => {
  const io = new WebSocketIO({ socket })

  const agent = new BidiAgent({
    model: new BedrockNovaSonicModel({ region: 'us-east-1' }),
    systemPrompt: 'You are a helpful assistant. Keep replies short.',
  })

  // One agent per connection; the socket stays owned by this handler, which closes it when done.
  agent
    .run({ inputs: [io.input()], outputs: [io.output()] })
    .catch((error: unknown) => console.error('connection failed', error))
    .finally(() => socket.close())
})
