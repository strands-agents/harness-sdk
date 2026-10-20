import { AudioIO } from '@strands-agents/sdk/bidi/io/audio'
import { BedrockNovaSonicModel, BidiAgent } from '@strands-agents/sdk/bidi'

const io = new AudioIO()

const agent = new BidiAgent({
  model: new BedrockNovaSonicModel({ region: 'us-east-1' }),
  systemPrompt: 'You are a helpful assistant. Keep replies short.',
})

// Streams microphone audio to the model, plays its speech, and renders transcripts and tool calls.
await agent.run({ inputs: [io.input()], outputs: [io.output()] })
