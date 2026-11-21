/**
 * Writes or reads a harness session with harness-ts `createHarness`, for the Rust cross-SDK
 * session test (`harness-rs/strands-harness/tests/cross_sdk_session.rs`).
 *
 * Run from the repo root with `TSX_TSCONFIG_PATH=harness-rs/conformance/tsconfig.json`, which points
 * `@strands-agents/sdk` at the pinned `strands-ts/src`:
 * - `npx tsx harness-rs/conformance/session.ts write <sessionDir> <sessionId> <text>` invokes the
 *   agent once with `<text>`; a scripted model replies `reply to: <text>`.
 * - `npx tsx harness-rs/conformance/session.ts read <sessionDir> <sessionId>` restores the session
 *   and prints its messages as JSON: `[{ "role": ..., "text": ... }]`.
 */

import { Model, type BaseModelConfig, type Message, type ModelStreamEvent } from '@strands-agents/sdk'

import { createHarness } from '../../harness-ts/src/index.js'

class ScriptedModel extends Model {
  private _config: BaseModelConfig = { modelId: 'scripted-model' }

  updateConfig(modelConfig: BaseModelConfig): void {
    this._config = { ...this._config, ...modelConfig }
  }

  getConfig(): BaseModelConfig {
    return this._config
  }

  async *stream(messages: Message[]): AsyncGenerator<ModelStreamEvent> {
    const last = messages.at(-1)
    const text = last?.content.map((block) => (block.type === 'textBlock' ? block.text : '')).join('') ?? ''
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    yield { type: 'modelContentBlockStartEvent' }
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: `reply to: ${text}` } }
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
  }
}

const [mode, dir, id, text] = process.argv.slice(2)
if ((mode !== 'write' && mode !== 'read') || !dir || !id || (mode === 'write' && !text)) {
  throw new Error('usage: session.ts <write|read> <sessionDir> <sessionId> [text]')
}

const agent = await createHarness({
  model: new ScriptedModel(),
  session: { id, dir },
  builtinTools: [],
  builtinPlugins: [],
  memory: false,
  skills: false,
  contextManager: false,
  printer: false,
})

if (mode === 'write') {
  await agent.invoke(text!)
} else {
  await agent.initialize()
  const messages = agent.messages.map((message) => ({
    role: message.role,
    text: message.content.map((block) => (block.type === 'textBlock' ? block.text : '')).join(''),
  }))
  process.stdout.write(JSON.stringify(messages))
}
