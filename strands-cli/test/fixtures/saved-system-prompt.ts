import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HARNESS_CONTRACT } from '@strands-agents/harness'
import { Model, type Message, type ModelStreamEvent, type StreamOptions } from '@strands-agents/sdk'
import { expect } from 'vitest'

export const SAVED_SYSTEM_PROMPT = 'Saved system prompt.'
export const SAVED_INSTRUCTIONS = 'Saved agent definition instructions.'

/**
 * Writes a session whose files carry a system prompt and agent instructions different from the ones
 * the CLI builds: a snapshot with its own `systemPrompt`, and an `agent.json` agent definition.
 */
export async function writeSessionWithSavedSystemPrompt(sessionDirectory: string, sessionId: string): Promise<void> {
  const snapshots = join(sessionDirectory, sessionId, 'scopes', 'agent', 'agent', 'snapshots')
  await mkdir(snapshots, { recursive: true })
  await writeFile(
    join(snapshots, 'snapshot_latest.json'),
    JSON.stringify({
      scope: 'agent',
      schemaVersion: '1.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      data: {
        systemPrompt: SAVED_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ text: 'earlier request' }] }],
      },
      appData: {},
    })
  )
  await writeFile(
    join(sessionDirectory, sessionId, 'agent.json'),
    JSON.stringify({ version: 1, instructions: SAVED_INSTRUCTIONS })
  )
}

/** Matches a system prompt the harness built from its own contract. */
export const harnessSystemPrompt = (): unknown =>
  expect.stringMatching(new RegExp(`^${HARNESS_CONTRACT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))

/** Replies `done` and records the system prompt and first message text of every model call. */
export class SystemPromptRecordingModel extends Model {
  readonly systemPrompts: unknown[] = []
  readonly firstMessageTexts: string[] = []
  private config = { modelId: 'system-prompt-recording', contextWindowLimit: 10_000 }

  updateConfig(config: { modelId?: string; contextWindowLimit?: number }): void {
    this.config = { ...this.config, ...config }
  }

  getConfig(): { modelId: string; contextWindowLimit: number } {
    return this.config
  }

  async *stream(messages: readonly Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.systemPrompts.push(options?.systemPrompt)
    const first = messages[0]?.content[0]
    this.firstMessageTexts.push(first?.type === 'textBlock' ? first.text : '')
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    yield { type: 'modelContentBlockStartEvent' }
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'done' } }
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
  }
}
