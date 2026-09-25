import process from 'node:process'
import { TextBlock, ToolResultBlock, tool } from '@strands-agents/sdk'
import { OpenAIRealtimeModel } from '@strands-agents/sdk/experimental/bidi/models/openai'

const lookup = tool({
  name: 'lookup_stock',
  description: 'Get the number of demo shirts in stock.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  callback: (): string => 'There are 12 shirts in stock.',
})

const model = new OpenAIRealtimeModel({
  modelId: process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime',
  voice: 'marin',
})
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 60000)
const interrupt = (): void => controller.abort()
process.once('SIGINT', interrupt)

try {
  await model.start({
    systemPrompt: 'Use lookup_stock to answer stock questions. Keep your answer brief.',
    tools: [lookup.toolSpec],
    cancelSignal: controller.signal,
  })
  await model.send(new TextBlock('How many shirts are in stock?'))
  let awaitingToolResponse = false
  for await (const event of model.receive()) {
    if (event.type === 'bidiTranscriptStop') console.log(`${event.role}: ${event.transcript}`)
    if (event.type === 'bidiAudioDelta') console.log(`Received ${event.audio.length} base64 audio characters`)
    if (event.type === 'bidiResponseStart') awaitingToolResponse = false
    if (event.type === 'toolUseStream') {
      const request = event.currentToolUse
      let result: ToolResultBlock
      try {
        if (request.name !== lookup.name) throw new Error('Unknown tool')
        const output = await lookup.invoke(request.input)
        result = new ToolResultBlock({
          toolUseId: request.toolUseId,
          status: 'success',
          content: [new TextBlock(String(output))],
        })
      } catch (error) {
        result = new ToolResultBlock({
          toolUseId: request.toolUseId,
          status: 'error',
          content: [new TextBlock(String(error))],
        })
      }
      await model.send(result)
      awaitingToolResponse = true
    }
    if (event.type === 'bidiResponseStop' && !awaitingToolResponse) break
  }
} finally {
  clearTimeout(timeout)
  process.removeListener('SIGINT', interrupt)
  await model.stop()
}
