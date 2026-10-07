import { Model, type Message, type ModelStreamEvent, type StreamOptions } from '@strands-agents/sdk'

export class PlatformIntegrationModel extends Model {
  getConfig() {
    return { modelId: 'platform-integration', contextWindowLimit: 10_000 }
  }

  updateConfig(): void {}

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const latest = messages.at(-1)
    const toolResult = latest?.content.find((block) => block.type === 'toolResultBlock')
    if (toolResult) {
      const text = toolResult.content.flatMap((block) => (block.type === 'textBlock' ? [block.text] : [])).join('')
      yield* response(`MCP_RESULT=${text}`)
      return
    }

    const prompt = messageText(latest)
    if (prompt.includes('invoke the MCP probe')) {
      const tool = options?.toolSpecs?.find(({ name }) => name.endsWith('probe'))
      if (!tool) throw new Error(`MCP probe missing from ${JSON.stringify(options?.toolSpecs)}`)
      yield { type: 'modelMessageStartEvent', role: 'assistant' }
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: tool.name, toolUseId: 'platform-probe' },
      }
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: '{}' } }
      yield { type: 'modelContentBlockStopEvent' }
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }
      yield metadata()
      return
    }

    const systemPrompt = JSON.stringify(options?.systemPrompt)
    const history = messages
      .filter(({ role }) => role === 'user')
      .map(messageText)
      .join('|')
    yield* response(
      [
        `LOCAL_SKILL=${systemPrompt.includes('local-platform-skill')}`,
        `REMOTE_SKILL=${systemPrompt.includes('remote-platform-skill')}`,
        `HISTORY=${history}`,
      ].join(' ')
    )
  }
}

export const model = new PlatformIntegrationModel()

function messageText(message: Message | undefined): string {
  return message?.content.flatMap((block) => (block.type === 'textBlock' ? [block.text] : [])).join('') ?? ''
}

async function* response(text: string): AsyncIterable<ModelStreamEvent> {
  yield { type: 'modelMessageStartEvent', role: 'assistant' }
  yield { type: 'modelContentBlockStartEvent' }
  yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } }
  yield { type: 'modelContentBlockStopEvent' }
  yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
  yield metadata()
}

function metadata(): ModelStreamEvent {
  return {
    type: 'modelMetadataEvent',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    metrics: { latencyMs: 1 },
  }
}
