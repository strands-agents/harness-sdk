import { BedrockNovaSonicModel, BidiAgent } from '@strands-agents/sdk/bidi'
import { ConsoleIO } from '@strands-agents/sdk/bidi/io/console'

const io = new ConsoleIO({ placeholder: 'Type a message and press Enter' })

const agent = new BidiAgent({
  model: new BedrockNovaSonicModel({ region: 'us-east-1' }),
  systemPrompt: 'You are a helpful assistant. Keep replies short.',
})

// Streams typed input to the model and renders text, reasoning, transcripts, and tool calls.
await agent.run({ inputs: [io.input()], outputs: [io.output()] })
