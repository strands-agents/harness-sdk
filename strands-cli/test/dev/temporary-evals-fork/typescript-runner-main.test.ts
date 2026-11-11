import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, it } from 'vitest'

import { temporaryDirectory } from '../../fixtures/tempdir.js'

const RUNNER = fileURLToPath(
  new URL('../../../src/dev/temporary-evals-fork/typescript-runner-main.ts', import.meta.url)
)

const AGENT = `import { createHarness } from '@strands-agents/harness'
import { Model, type Message, type ModelStreamEvent } from '@strands-agents/sdk'

class Echo extends Model {
  getConfig() {
    return { modelId: 'echo', contextWindowLimit: 10_000 }
  }

  updateConfig(): void {}

  async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const latest = messages.at(-1)?.content.find((block) => block.type === 'textBlock')
    const text = latest && 'text' in latest ? \`echo \${latest.text}\` : 'echo'
    console.log('the model writes to stdout')
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    yield { type: 'modelContentBlockStartEvent' }
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } }
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
    yield { type: 'modelMetadataEvent', usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } }
  }
}

console.log('loading the agent')
export const agent = createHarness({ model: new Echo(), instructions: 'Echo the question.', builtinTools: [], skills: false })
`

describe('TEMPORARY TypeScript runner process', () => {
  it('shouldAnswerOverlappingRequestsWithJsonLinesOnlyWhenTheAgentWritesToStdout', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'agent.ts'), AGENT)
    const child = spawn(
      process.execPath,
      ['--import', import.meta.resolve('tsx/esm'), RUNNER, join(root, 'agent.ts'), root],
      {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )
    const lines: string[] = []
    const replies = new Promise<void>((resolve) => {
      createInterface({ input: child.stdout }).on('line', (line) => {
        lines.push(line)
        if (lines.length === 3) resolve()
      })
    })

    child.stdin.write(`${JSON.stringify({ id: 1, type: 'describe' })}\n`)
    child.stdin.write(`${JSON.stringify({ id: 2, type: 'run', values: {}, input: 'first' })}\n`)
    child.stdin.write(
      `${JSON.stringify({ id: 3, type: 'run', values: { instructions: 'Be brief.' }, input: 'second' })}\n`
    )
    await replies
    child.stdin.end()

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    const byId = new Map(parsed.map((reply) => [reply.id, reply]))
    expect(byId.get(1)).toMatchObject({ instructions: 'Echo the question.', model_is_instance: true })
    expect(byId.get(2)).toMatchObject({ output: 'echo first', usage: { totalTokens: 6 }, cycles: 1 })
    expect(byId.get(3)).toMatchObject({ output: 'echo second' })
  }, 60_000)
})
