/**
 * Unit tests for bidirectional agent snapshot capture and restore.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BidiAgent } from '../agent.js'
import { BidiModel } from '../../models/model.js'
import type { BidiModelConfig } from '../../models/configs.js'
import type { BidiMessage, BidiContentDelta } from '../../types/content.js'
import type { BidiOutputEvent } from '../../types/events.js'
import type { BidiAgentConfig } from '../agent.js'
import type { JSONValue } from '../../../types/json.js'
import type { MessageData, SystemContentBlockData, SystemPromptData } from '../../../types/messages.js'
import { systemPromptToData } from '../../../types/messages.js'
import { SNAPSHOT_SCHEMA_VERSION } from '../../../types/snapshot.js'
import type { Snapshot } from '../../../types/snapshot.js'

const loop = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }))

vi.mock('../loop.js', () => ({
  AgentLoop: class {
    async start(): Promise<void> {
      loop.start()
    }
    async stop(): Promise<void> {
      loop.stop()
    }
    async send(): Promise<void> {}
    async *receive(): AsyncGenerator<unknown> {}
  },
}))

/** Minimal bidirectional model standing in for a provider. */
class FakeBidiModel extends BidiModel {
  updateConfig(): void {}

  getConfig(): BidiModelConfig {
    return { modelId: 'mock-model' }
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(_content: BidiMessage | BidiContentDelta): Promise<void> {}
  async *receive(): AsyncGenerator<BidiOutputEvent> {}
}

const MESSAGES: MessageData[] = [
  { role: 'user', content: [{ text: 'hello' }] },
  { role: 'assistant', content: [{ text: 'hi' }] },
]
const STATE: Record<string, JSONValue> = { userId: 'u-1', count: 2 }
const SYSTEM_PROMPT: SystemContentBlockData[] = [{ text: 'You are helpful.' }, { cachePoint: { cacheType: 'default' } }]

/** Build an agent with the mocked loop and model. */
function makeAgent(config: Omit<BidiAgentConfig, 'model'> = {}): BidiAgent {
  return new BidiAgent({ model: new FakeBidiModel(), ...config })
}

/** Serialized history without the tracking ids the SDK generates per message. */
function history(agent: BidiAgent): MessageData[] {
  return agent.messages.map((message) => stripTrackingIds([message.toJSON()])[0]!)
}

/** Drop generated tracking ids so serialized messages compare against fixtures. */
function stripTrackingIds(messages: unknown): MessageData[] {
  return (messages as (MessageData & { trackingId?: string })[]).map(({ trackingId: _trackingId, ...data }) => data)
}

/** The agent's system prompt in its JSON form, for comparison against fixtures. */
function prompt(agent: BidiAgent): SystemPromptData | undefined {
  return agent.systemPrompt === undefined ? undefined : systemPromptToData(agent.systemPrompt)
}

/** Build a snapshot carrying the given data. */
function makeSnapshot(data: Record<string, JSONValue>): Snapshot {
  return {
    scope: 'agent',
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    data: globalThis.structuredClone(data),
    appData: {},
  }
}

describe('BidiAgent snapshots', () => {
  beforeEach(() => {
    loop.start.mockClear()
    loop.stop.mockClear()
  })

  describe('takeSnapshot', () => {
    it('captures messages and state for the session preset', () => {
      const agent = makeAgent({ messages: MESSAGES, appState: STATE, systemPrompt: SYSTEM_PROMPT })

      const snapshot = agent.takeSnapshot({ preset: 'session' })

      expect(snapshot.scope).toBe('agent')
      expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION)
      expect(Object.keys(snapshot.data).sort()).toEqual(['messages', 'state'])
      expect(stripTrackingIds(snapshot.data.messages)).toEqual(MESSAGES)
      expect(snapshot.data.state).toEqual(STATE)
    })

    it('preserves system prompt content blocks when included', () => {
      const agent = makeAgent({ systemPrompt: SYSTEM_PROMPT })

      const { data } = agent.takeSnapshot({ include: ['systemPrompt'] })

      expect(data).toEqual({ systemPrompt: SYSTEM_PROMPT })
    })

    it('removes an excluded field', () => {
      const agent = makeAgent({ messages: MESSAGES, appState: STATE })

      const { data } = agent.takeSnapshot({ preset: 'session', exclude: ['messages'] })

      expect(data).toEqual({ state: STATE })
    })

    it.each([
      ['include', 'modelState'],
      ['include', 'interrupts'],
      ['exclude', 'modelState'],
      ['exclude', 'interrupts'],
    ])('rejects the unsupported field %s: %s', (option, field) => {
      const agent = makeAgent()

      expect(() => agent.takeSnapshot({ preset: 'session', [option]: [field] } as never)).toThrow(
        `Invalid snapshot field: '${field}'`
      )
    })

    it.each([
      ['no options', {}],
      ['everything excluded', { preset: 'session' as const, exclude: ['messages' as const, 'state' as const] }],
    ])('rejects an empty field set with %s', (_name, options) => {
      const agent = makeAgent()

      expect(() => agent.takeSnapshot(options)).toThrow('No fields to include in snapshot')
    })

    it('stores app data verbatim', () => {
      const agent = makeAgent()
      const appData = { checkpoint: 'before-tool', nested: { k: [1, 2] } }

      const snapshot = agent.takeSnapshot({ preset: 'session', appData })

      expect(snapshot.appData).toEqual(appData)
    })

    it('returns copies independent of the agent', () => {
      const agent = makeAgent({ messages: MESSAGES, appState: STATE, systemPrompt: SYSTEM_PROMPT })

      const snapshot = agent.takeSnapshot({ preset: 'session', include: ['systemPrompt'] })
      ;(snapshot.data.messages as unknown as MessageData[]).push({ role: 'user', content: [{ text: 'extra' }] })
      ;(snapshot.data.state as Record<string, JSONValue>).count = 99
      ;(snapshot.data.systemPrompt as unknown as SystemContentBlockData[]).push({ text: 'extra' })

      expect(history(agent)).toEqual(MESSAGES)
      expect(agent.appState.getAll()).toEqual(STATE)
      expect(prompt(agent)).toEqual(SYSTEM_PROMPT)
    })

    it('captures while the agent is started', async () => {
      const agent = makeAgent({ messages: MESSAGES })
      await agent.start()

      try {
        const { data } = agent.takeSnapshot({ preset: 'session' })
        expect(stripTrackingIds(data.messages)).toEqual(MESSAGES)
        expect(data.state).toEqual({})
      } finally {
        await agent.stop()
      }
    })
  })

  describe('loadSnapshot', () => {
    it('round trips into a fresh agent', () => {
      const source = makeAgent({ messages: MESSAGES, appState: STATE, systemPrompt: SYSTEM_PROMPT })
      const target = makeAgent()

      target.loadSnapshot(source.takeSnapshot({ preset: 'session', include: ['systemPrompt'] }))

      expect(history(target)).toEqual(MESSAGES)
      expect(target.appState.getAll()).toEqual(STATE)
      expect(prompt(target)).toEqual(SYSTEM_PROMPT)
    })

    it.each(['messages', 'state', 'systemPrompt'])('leaves the agent unchanged for a missing %s', (omitted) => {
      const data: Record<string, JSONValue> = {
        messages: MESSAGES as unknown as JSONValue,
        state: STATE,
        systemPrompt: SYSTEM_PROMPT as unknown as JSONValue,
      }
      delete data[omitted]
      const target = makeAgent({
        messages: [{ role: 'user', content: [{ text: 'original' }] }],
        appState: { original: true },
        systemPrompt: 'original prompt',
      })

      target.loadSnapshot(makeSnapshot(data))

      const expected: Record<string, unknown> = {
        messages: MESSAGES,
        state: STATE,
        systemPrompt: SYSTEM_PROMPT,
      }
      expected[omitted] = {
        messages: [{ role: 'user', content: [{ text: 'original' }] }],
        state: { original: true },
        systemPrompt: 'original prompt',
      }[omitted]

      expect({
        messages: history(target),
        state: target.appState.getAll(),
        systemPrompt: prompt(target),
      }).toEqual(expected)
    })

    it('ignores fields a bidirectional agent does not support', () => {
      const target = makeAgent()

      target.loadSnapshot(
        makeSnapshot({
          messages: MESSAGES as unknown as JSONValue,
          modelState: { responseId: 'r-1' },
          interrupts: { activated: false },
        })
      )

      expect(history(target)).toEqual(MESSAGES)
      expect(target.modelState.getAll()).toEqual({})
    })

    it('restores copies independent of the snapshot', () => {
      const target = makeAgent()
      const snapshot = makeSnapshot({
        messages: MESSAGES as unknown as JSONValue,
        systemPrompt: SYSTEM_PROMPT as unknown as JSONValue,
      })

      target.loadSnapshot(snapshot)
      ;(snapshot.data.messages as unknown as MessageData[]).push({ role: 'user', content: [{ text: 'extra' }] })
      ;(snapshot.data.systemPrompt as unknown as SystemContentBlockData[]).push({ text: 'extra' })

      expect(history(target)).toEqual(MESSAGES)
      expect(prompt(target)).toEqual(SYSTEM_PROMPT)
    })

    it('rejects an unsupported schema version', () => {
      const target = makeAgent()
      const snapshot = { ...makeSnapshot({ messages: MESSAGES as unknown as JSONValue }), schemaVersion: '0.9' }

      expect(() => target.loadSnapshot(snapshot)).toThrow('Unsupported snapshot schema version')
    })

    it('rejects a multi-agent scope', () => {
      const target = makeAgent({ appState: { original: true } })
      const snapshot: Snapshot = { ...makeSnapshot({ state: { node: 'n-1' } }), scope: 'multiAgent' }

      expect(() => target.loadSnapshot(snapshot)).toThrow("Expected snapshot scope 'agent'")
      expect(target.appState.getAll()).toEqual({ original: true })
    })

    it('rejects loading while the connection is active', async () => {
      const agent = makeAgent()
      const snapshot = makeSnapshot({ messages: MESSAGES as unknown as JSONValue })

      await agent.start()
      try {
        expect(() => agent.loadSnapshot(snapshot)).toThrow('agent started | call stop before loading a snapshot')
        expect(agent.messages).toEqual([])
      } finally {
        await agent.stop()
      }

      agent.loadSnapshot(snapshot)
      expect(history(agent)).toEqual(MESSAGES)
    })
  })
})
