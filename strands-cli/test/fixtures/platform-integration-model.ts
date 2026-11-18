import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Model, type Message, type ModelStreamEvent, type StreamOptions } from '@strands-agents/sdk'

export class PlatformIntegrationModel extends Model {
  getConfig() {
    return { modelId: 'platform-integration', contextWindowLimit: 10_000 }
  }

  updateConfig(): void {}

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    if (
      messages.some((message) => message.role === 'user' && messageText(message).startsWith('exercise built-in tools'))
    ) {
      const path = join(process.cwd(), 'builtin tool probe.txt')
      const steps = [
        { name: 'write', input: { path, content: 'before edit\n' }, expected: 'Wrote' },
        { name: 'edit', input: { path, old_str: 'before', new_str: 'after' }, expected: '' },
        { name: 'read', input: { path }, expected: 'after edit' },
        { name: 'shell', input: { command: 'echo __SHELL_TOOL_OK__' }, expected: '__SHELL_TOOL_OK__' },
        { name: 'web_fetch', input: { url: process.env.STRANDS_CLI_TEST_FETCH_URL }, expected: '__FETCH_TOOL_OK__' },
      ]
      const results = messages.flatMap((message) =>
        message.content
          .filter((block) => block.type === 'toolResultBlock')
          .filter((block) => block.toolUseId.startsWith('builtin-'))
      )
      for (const [index, result] of results.entries()) {
        assert.equal(result.status, 'success', JSON.stringify(result))
        const text = result.content
          .map((block) => (block.type === 'textBlock' ? block.text : JSON.stringify(block)))
          .join('')
        assert.ok(text.includes(steps[index]!.expected), `${steps[index]!.name}: ${text}`)
      }
      const step = steps[results.length]
      if (!step) {
        yield* response('BUILTIN_TOOLS_OK')
        return
      }
      assert.ok(
        options?.toolSpecs?.some(({ name }) => name === step.name),
        `Missing built-in tool: ${step.name}`
      )
      yield { type: 'modelMessageStartEvent', role: 'assistant' }
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: step.name, toolUseId: `builtin-${results.length}` },
      }
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: JSON.stringify(step.input) },
      }
      yield { type: 'modelContentBlockStopEvent' }
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }
      yield metadata()
      return
    }
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
        `HISTORY=${history}`,
        // Completion markers must remain visible after a long echoed history.
        `LOCAL_SKILL=${systemPrompt.includes('local-platform-skill')}`,
        `REMOTE_SKILL=${systemPrompt.includes('remote-platform-skill')}`,
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
