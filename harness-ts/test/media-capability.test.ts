import { Buffer } from 'node:buffer'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelRouter, Tool, type ToolContext, type Message, type ModelStreamEvent } from '@strands-agents/sdk'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'
import { createHarness } from '../src/agent.js'
import { supportsMedia } from '../src/models.js'

// https://github.com/strands-agents/harness-sdk/issues/5556
// The model boundary simulates Bedrock rejecting image tool results; no provider calls are made.
const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

it('disables Bedrock Grok media across accepted model forms', async () => {
  for (const prefix of ['', 'global.', 'us.', 'eu.', 'apac.', 'au.', 'jp.']) {
    expect(await supportsMedia(`bedrock/${prefix}xai.grok-4.7`)).toBe(false)
    expect(await supportsMedia(`${prefix}xai.grok-4.7`)).toBe(false)
    expect(await supportsMedia(new BedrockModel({ modelId: `${prefix}xai.grok-4.7` }))).toBe(false)
  }
  const grok = new BedrockModel({ modelId: 'global.xai.grok-4.7' })
  const claude = new BedrockModel({ modelId: 'global.anthropic.claude-opus-4-8' })
  const openai = new BedrockModel({ modelId: 'us.openai.gpt-6-astra' })
  expect(await supportsMedia(new ModelRouter([grok, claude]))).toBe(false)
  expect(await supportsMedia(new ModelRouter([grok, openai]))).toBe(false)
  expect(await supportsMedia('bedrock/unknown.future-model')).toBe(true)
  expect(await supportsMedia('bedrock/global.anthropic.claude-opus-4-8')).toBe(true)
  expect(await supportsMedia('bedrock/amazon.nova-pro-v1:0')).toBe(true)
  expect(await supportsMedia('bedrock-mantle/xai.grok-4.7')).toBe(true)
})

it.each([undefined, false, true])('exercises actual read and session reload with media=%s', async (media) => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-5556-'))
  dirs.push(dir)
  const path = join(dir, 'pixel.png')
  writeFileSync(
    path,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64'
    )
  )
  const seen: Message[][] = []
  const hasImage = (messages: Message[]) =>
    messages.some((message) =>
      message.content.some(
        (block) =>
          block.type === 'imageBlock' ||
          (block.type === 'toolResultBlock' && block.content.some((item) => item.type === 'imageBlock'))
      )
    )
  function model() {
    const m = new BedrockModel({ modelId: 'global.xai.grok-4.7' })
    vi.spyOn(m, 'stream').mockImplementation(async function* (messages): AsyncGenerator<ModelStreamEvent> {
      seen.push([...messages])
      if (hasImage(messages)) throw new Error("This model doesn't support the image field for user messages")
      yield { type: 'modelMessageStartEvent', role: 'assistant' }
      if (seen.length === 1) {
        yield {
          type: 'modelContentBlockStartEvent',
          start: { type: 'toolUseStart', name: 'read', toolUseId: 'read-1' },
        }
        yield {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: JSON.stringify({ path }) },
        }
        yield { type: 'modelContentBlockStopEvent' }
        yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }
      } else {
        yield { type: 'modelContentBlockStartEvent' }
        yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'ok' } }
        yield { type: 'modelContentBlockStopEvent' }
        yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
      }
    })
    return m
  }
  const options = {
    session: { id: 'repro-1', dir },
    skills: false,
    memory: false,
    contextManager: false,
    builtinPlugins: [],
    builtinTools: {
      shell: false,
      write: false,
      edit: false,
      web_fetch: false,
      web_search: false,
      subagent: false,
      programmatic_tool_caller: false,
      read: media === undefined ? true : { media },
    },
    printer: false,
  } as const
  const agent = await createHarness({ ...options, model: model() })
  if (media !== true) {
    await agent.invoke('Read the image')
    expect(JSON.stringify(seen.at(-1))).toContain('cannot view')
    expect(seen.some(hasImage)).toBe(false)
  } else {
    await expect(agent.invoke('Read the image')).rejects.toThrow("doesn't support the image field")
    expect(hasImage(seen.at(-1)!)).toBe(true)
  }
  const restored = await createHarness({ ...options, model: model() })
  if (media !== true) {
    await restored.invoke('Reply with only the word ok')
    expect(seen.some(hasImage)).toBe(false)
  } else {
    await expect(restored.invoke('Reply with only the word ok')).rejects.toThrow("doesn't support the image field")
    expect(hasImage(seen.at(-1)!)).toBe(true)
  }
})

it.each([
  ['bedrock/global.anthropic.claude-opus-4-8', undefined, true],
  ['bedrock/amazon.nova-pro-v1:0', undefined, true],
  ['bedrock/global.anthropic.claude-opus-4-8', false, false],
  ['bedrock/global.xai.grok-4.7', true, true],
  ['bedrock/global.xai.grok-4.7', undefined, false],
] as const)('wires read for %s with override %s', async (model, media, image) => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-5556-'))
  dirs.push(dir)
  const path = join(dir, 'pixel.png')
  writeFileSync(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const agent = await createHarness({
    model,
    skills: false,
    memory: false,
    session: false,
    builtinTools: { '*': false, read: media === undefined ? true : { media } },
  })
  const read = agent.tools.find((tool) => tool.name === 'read') as Tool
  const result = await read.invoke({ path }, { agent } as ToolContext)
  expect(typeof result !== 'string').toBe(image)
  if (!image) expect(result).toContain('cannot view')
})
