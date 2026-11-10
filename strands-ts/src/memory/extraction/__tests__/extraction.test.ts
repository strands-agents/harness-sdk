import { describe, it, expect, vi } from 'vitest'
import { MemoryManager } from '../../memory-manager.js'
import { InvocationTrigger, IntervalTrigger } from '../triggers.js'
import {
  ExtractionCoordinator,
  SAVE_FAILURES_BEFORE_BACKOFF,
  BACKOFF_PROBE_INTERVAL,
  type ExtractionBinding,
} from '../coordinator.js'
import { resolveExtractionConfig } from '../resolve-extraction-config.js'
import { Tracer } from '../../../telemetry/tracer.js'
import type { Model } from '../../../models/model.js'
import type { ExtractionConfig, Extractor } from '../types.js'
import type { MemoryStore, MemoryEntry, AddMessagesContext } from '../../types.js'
import type { MessageData } from '../../../types/messages.js'
import { Message, TextBlock, ToolUseBlock } from '../../../types/messages.js'
import { AfterInvocationEvent, MessageAddedEvent } from '../../../hooks/events.js'
import { createMockAgent, type MockAgent } from '../../../__fixtures__/agent-helpers.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'

/**
 * Builds a writable store with an extraction config. `sink` chooses which write method(s) it has,
 * letting tests target each route (extractor → `add`; no extractor → `addMessages`) and the
 * construction-time sink validation.
 */
function createExtractionStore(
  name: string,
  extraction: boolean | ExtractionConfig | undefined,
  sink: 'add' | 'addMessages' | 'both' = 'both',
  options?: { entries?: MemoryEntry[] }
): MemoryStore & {
  add: ReturnType<typeof vi.fn>
  addMessages: ReturnType<typeof vi.fn>
} {
  const store = {
    name,
    writable: true,
    extraction,
    search: vi.fn().mockResolvedValue(options?.entries ?? []),
    add: vi.fn().mockResolvedValue(undefined),
    addMessages: vi.fn().mockResolvedValue(undefined),
  } as unknown as MemoryStore & { add: ReturnType<typeof vi.fn>; addMessages: ReturnType<typeof vi.fn> }

  if (sink === 'add') delete (store as Partial<MemoryStore>).addMessages
  if (sink === 'addMessages') delete (store as Partial<MemoryStore>).add
  return store
}

/** Wraps a store into the {@link ExtractionBinding} pair the coordinator takes, resolving its config. */
function asExtractionStore(store: MemoryStore): ExtractionBinding {
  return { store, config: resolveExtractionConfig(store.extraction, store)! }
}

function userMsg(text: string): Message {
  return new Message({ role: 'user', content: [new TextBlock(text)] })
}

/** Drives the lifecycle: adds messages, then fires the AfterInvocationEvent hook(s). */
async function addMessages(agent: MockAgent, ...messages: Message[]): Promise<void> {
  for (const message of messages) {
    await invokeAll(agent, new MessageAddedEvent({ agent, message, invocationState: {} }))
  }
}

async function invokeAll(agent: MockAgent, event: AfterInvocationEvent | MessageAddedEvent): Promise<void> {
  const hooks = agent.trackedHooks.filter((h) => h.eventType === event.constructor)
  for (const hook of hooks) {
    await hook.callback(event)
  }
}

/**
 * Fires the AfterInvocationEvent hook(s), then flushes the manager so the fire-and-forget background
 * extraction has completed before assertions run.
 */
async function fireInvocation(agent: MockAgent, mm: MemoryManager): Promise<void> {
  await invokeAll(agent, new AfterInvocationEvent({ agent, invocationState: {} }))
  await mm.flush()
}

describe('MemoryManager extraction', () => {
  describe('constructor validation', () => {
    it('throws when an extraction store is not writable', () => {
      const store: MemoryStore = {
        name: 's',
        writable: false,
        search: vi.fn(),
        extraction: { trigger: [new InvocationTrigger()] },
      }
      expect(() => new MemoryManager({ stores: [store] })).toThrow('not writable')
    })

    it('throws when an extraction config has no triggers', () => {
      const store = createExtractionStore('s', { trigger: [] })
      expect(() => new MemoryManager({ stores: [store] })).toThrow('no triggers')
    })

    it('allows a store writable only via addMessages', () => {
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'addMessages')
      expect(() => new MemoryManager({ stores: [store] })).not.toThrow()
    })

    it('throws when a writable store has neither add nor addMessages', () => {
      const store: MemoryStore = { name: 's', writable: true, search: vi.fn() }
      expect(() => new MemoryManager({ stores: [store] })).toThrow('no add or addMessages')
    })

    it('rejects addToolConfig targeting an addMessages-only store', () => {
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'addMessages')
      expect(() => new MemoryManager({ stores: [store], addToolConfig: true })).toThrow(
        'no writable stores implement add'
      )
    })

    it('throws when extraction has an extractor but the store has no add', () => {
      const extractor: Extractor = { extract: vi.fn() }
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()], extractor }, 'addMessages')
      expect(() => new MemoryManager({ stores: [store] })).toThrow('has an extractor but no add method')
    })
  })

  describe('config resolution', () => {
    it('enables extraction with defaults via the boolean shorthand', async () => {
      // `extraction: true` on an addMessages-capable store -> passthrough (no implicit model call).
      const store = createExtractionStore('s', true, 'addMessages')
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      await addMessages(agent, userMsg('remember this'))
      // The default trigger fires every DEFAULT_EXTRACTION_TRIGGER_TURNS turns; flush forces the write.
      await mm.flush()
      expect(store.addMessages).toHaveBeenCalledTimes(1)
    })

    it('treats extraction: false as disabled (no hooks, no writes)', async () => {
      const store = createExtractionStore('s', false, 'addMessages')
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      await addMessages(agent, userMsg('ignored'))
      await mm.flush()
      expect(store.addMessages).not.toHaveBeenCalled()
      expect(agent.trackedHooks.filter((h) => h.eventType === AfterInvocationEvent)).toHaveLength(0)
    })

    it('defaults an add-only store to a ModelExtractor (extractor route)', async () => {
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'add')
      // The default ModelExtractor calls the agent's model; the mock returns a JSON array of facts.
      const model = new MockMessageModel()
      model.addTurn({ type: 'textBlock', text: '[{"content":"a durable fact"}]' })
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent({ extra: { model: model as unknown as Model } })
      await mm.initAgent(agent)

      await addMessages(agent, userMsg('I like dark mode'))
      await fireInvocation(agent, mm)

      expect(store.add).toHaveBeenCalledWith('a durable fact', undefined)
    })

    it('defaults a both-sinks store to the passthrough (no implicit model call)', async () => {
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'both')
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      await addMessages(agent, userMsg('hi'))
      await fireInvocation(agent, mm)

      expect(store.addMessages).toHaveBeenCalledTimes(1)
      expect(store.add).not.toHaveBeenCalled()
    })
  })

  describe('no-extractor passthrough', () => {
    it('hands the raw MessageData batch to addMessages, roles preserved', async () => {
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'addMessages')
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      await addMessages(
        agent,
        userMsg('I prefer dark mode'),
        new Message({ role: 'assistant', content: [new TextBlock('Noted')] })
      )
      await fireInvocation(agent, mm)

      expect(store.addMessages).toHaveBeenCalledTimes(1)
      const batch = store.addMessages.mock.calls[0]![0] as MessageData[]
      expect(batch).toHaveLength(2)
      expect(batch[0]!.role).toBe('user')
      expect(batch[1]!.role).toBe('assistant')
    })
  })

  describe('addMessages context (per-message seqs)', () => {
    it('passes sequenceNumbers index-aligned with the filtered batch', async () => {
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'addMessages')
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      await addMessages(agent, userMsg('first'), userMsg('second'))
      await fireInvocation(agent, mm)

      const batch = store.addMessages.mock.calls[0]![0] as MessageData[]
      const ctx = store.addMessages.mock.calls[0]![1] as AddMessagesContext
      // Assert the whole context so an unexpected field added to the envelope later is caught.
      expect(ctx).toEqual({ sequenceNumbers: [0, 1] })
      expect(ctx.sequenceNumbers).toHaveLength(batch.length)
    })

    it('keeps a message seq when a message before it is filtered to empty (gap)', async () => {
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'addMessages')
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      // seq 0 (kept), seq 1 (tool-only, filtered to empty and dropped), seq 2 (kept).
      const toolOnly = new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ name: 't', toolUseId: '1', input: {} })],
      })
      await addMessages(agent, userMsg('a'), toolOnly, userMsg('b'))
      await fireInvocation(agent, mm)

      const batch = store.addMessages.mock.calls[0]![0] as MessageData[]
      const ctx = store.addMessages.mock.calls[0]![1] as AddMessagesContext
      expect(batch).toHaveLength(2)
      // The dropped message leaves a gap: 1 is missing, the surviving messages keep their own seqs.
      expect(ctx).toEqual({ sequenceNumbers: [0, 2] })
    })

    it('re-fires the same seqs for a multi-message batch whose save failed (stable across retries)', async () => {
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'addMessages')
      store.addMessages.mockRejectedValueOnce(new Error('backend down'))
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      await addMessages(agent, userMsg('first'), userMsg('second'))
      await fireInvocation(agent, mm) // fails, mark rolled back
      await fireInvocation(agent, mm) // retries the same batch

      expect(store.addMessages).toHaveBeenCalledTimes(2)
      const first = store.addMessages.mock.calls[0]![1] as AddMessagesContext
      const second = store.addMessages.mock.calls[1]![1] as AddMessagesContext
      expect(first).toEqual({ sequenceNumbers: [0, 1] })
      // The retry carries the identical context in order, not a fresh renumbering.
      expect(second).toEqual(first)
    })

    it('anchors the seq to the message, not the batch position', async () => {
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'addMessages')
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      // First turn (seq 0) saves cleanly; second turn (seq 1) fails then retries.
      await addMessages(agent, userMsg('turn one'))
      await fireInvocation(agent, mm)
      store.addMessages.mockRejectedValueOnce(new Error('backend down'))
      await addMessages(agent, userMsg('turn two'))
      await fireInvocation(agent, mm) // fails, rolled back
      await fireInvocation(agent, mm) // retries turn two

      expect(store.addMessages).toHaveBeenCalledTimes(3)
      const retried = store.addMessages.mock.calls[2]![1] as AddMessagesContext
      // Retried batch carries the message's original seq (1), not a renumbered 0.
      expect(retried).toEqual({ sequenceNumbers: [1] })
    })

    it('gives each store index-aligned seqs from the shared buffer', async () => {
      const a = createExtractionStore('a', { trigger: [new InvocationTrigger()] }, 'addMessages')
      const b = createExtractionStore('b', { trigger: [new InvocationTrigger()] }, 'addMessages')
      const mm = new MemoryManager({ stores: [a, b] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      await addMessages(agent, userMsg('first'), userMsg('second'))
      await fireInvocation(agent, mm)

      const ctxA = a.addMessages.mock.calls[0]![1] as AddMessagesContext
      const ctxB = b.addMessages.mock.calls[0]![1] as AddMessagesContext
      expect(ctxA).toEqual({ sequenceNumbers: [0, 1] })
      expect(ctxB).toEqual({ sequenceNumbers: [0, 1] })
    })

    it('does not pass sequenceNumbers on the extractor route', async () => {
      const extractor: Extractor = { extract: vi.fn().mockResolvedValue([{ content: 'fact' }]) }
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()], extractor }, 'both')
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      await addMessages(agent, userMsg('something happened'))
      await fireInvocation(agent, mm)

      expect(store.addMessages).not.toHaveBeenCalled()
      // The extractor receives (messages, context); the context is the extractor envelope only
      // (defaultModel + tracer), with no sequenceNumbers — that field is for the addMessages route.
      expect(extractor.extract).toHaveBeenCalledTimes(1)
      const extractArgs = (extractor.extract as ReturnType<typeof vi.fn>).mock.calls[0]!
      expect(extractArgs).toHaveLength(2)
      expect(extractArgs[1]).not.toHaveProperty('sequenceNumbers')
      expect(extractArgs[1]).toHaveProperty('defaultModel')
    })
  })

  describe('extractor route', () => {
    it('calls the extractor and writes each entry via add', async () => {
      const extractor: Extractor = {
        extract: vi.fn().mockResolvedValue([{ content: 'fact one' }, { content: 'fact two', metadata: { k: 'v' } }]),
      }
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()], extractor }, 'both')
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      await addMessages(agent, userMsg('something happened'))
      await fireInvocation(agent, mm)

      expect(extractor.extract).toHaveBeenCalledTimes(1)
      expect(store.add).toHaveBeenCalledTimes(2)
      expect(store.add.mock.calls[0]![0]).toBe('fact one')
      expect(store.add.mock.calls[1]![0]).toBe('fact two')
      expect(store.add.mock.calls[1]![1]).toEqual({ k: 'v' })
      // Extractor route never uses the batch sink.
      expect(store.addMessages).not.toHaveBeenCalled()
    })

    it('passes the agent auxModel as defaultModel to the extractor', async () => {
      const extractor: Extractor = { extract: vi.fn().mockResolvedValue([]) }
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()], extractor })
      const mm = new MemoryManager({ stores: [store] })
      const fakeModel = { id: 'aux' }
      const agent = createMockAgent({ extra: { model: { id: 'model' }, auxModel: fakeModel } as never })
      await mm.initAgent(agent)

      await addMessages(agent, userMsg('hi'))
      await fireInvocation(agent, mm)

      expect(extractor.extract).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ defaultModel: fakeModel })
      )
    })

    it('writes entries concurrently rather than serially', async () => {
      // Both add() calls should be in flight before either resolves -> the second is invoked while
      // the first is still pending (would be impossible with a serial await loop).
      let firstInvokedDuringSecond = false
      let secondStarted = false
      const extractor: Extractor = {
        extract: vi.fn().mockResolvedValue([{ content: 'a' }, { content: 'b' }]),
      }
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()], extractor }, 'add')
      let firstResolve!: () => void
      store.add
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              firstResolve = (): void => {
                firstInvokedDuringSecond = secondStarted
                resolve()
              }
            })
        )
        .mockImplementationOnce(() => {
          secondStarted = true
          firstResolve()
          return Promise.resolve()
        })

      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)
      await addMessages(agent, userMsg('x'))
      await fireInvocation(agent, mm)

      expect(store.add).toHaveBeenCalledTimes(2)
      expect(firstInvokedDuringSecond).toBe(true)
    })

    it('rolls back and retries the whole batch if any entry write fails', async () => {
      const extractor: Extractor = {
        extract: vi.fn().mockResolvedValue([{ content: 'a' }, { content: 'b' }]),
      }
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()], extractor }, 'add')
      // First batch: second entry fails -> AggregateError -> mark rolled back.
      store.add.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('write failed'))

      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)
      await addMessages(agent, userMsg('x'))
      await fireInvocation(agent, mm) // fails, rolled back
      await fireInvocation(agent, mm) // retries the same batch

      // 2 writes first attempt + 2 on retry.
      expect(store.add).toHaveBeenCalledTimes(4)
      expect(extractor.extract).toHaveBeenCalledTimes(2)
    })
  })

  describe('message filter', () => {
    it('drops toolUse/toolResult blocks by default and empties', async () => {
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'addMessages')
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      const toolOnly = new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ name: 't', toolUseId: '1', input: {} })],
      })
      await addMessages(agent, userMsg('keep me'), toolOnly)
      await fireInvocation(agent, mm)

      const batch = store.addMessages.mock.calls[0]![0] as MessageData[]
      // tool-only message dropped entirely; text message kept.
      expect(batch).toHaveLength(1)
      expect(batch[0]!.role).toBe('user')
    })

    it('honors a custom filter', async () => {
      const store = createExtractionStore(
        's',
        { trigger: [new InvocationTrigger()], filter: { exclude: ['text'] } },
        'addMessages'
      )
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      await addMessages(agent, userMsg('this is text and should be excluded'))
      await fireInvocation(agent, mm)

      // The only message was text, excluded -> emptied -> nothing to write.
      expect(store.addMessages).not.toHaveBeenCalled()
    })
  })

  describe('high-water-mark dedup', () => {
    it('processes only messages added since the last fire', async () => {
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'addMessages')
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      await addMessages(agent, userMsg('turn one'))
      await fireInvocation(agent, mm)
      await addMessages(agent, userMsg('turn two'))
      await fireInvocation(agent, mm)

      expect(store.addMessages).toHaveBeenCalledTimes(2)
      expect(store.addMessages.mock.calls[0]![0] as MessageData[]).toHaveLength(1)
      const second = store.addMessages.mock.calls[1]![0] as MessageData[]
      expect(second).toHaveLength(1)
      expect((second[0]!.content[0] as { text: string }).text).toBe('turn two')
    })

    it('does nothing when no new messages since the mark', async () => {
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'addMessages')
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      await addMessages(agent, userMsg('only turn'))
      await fireInvocation(agent, mm)
      await fireInvocation(agent, mm) // no new messages

      expect(store.addMessages).toHaveBeenCalledTimes(1)
    })

    it('retries the same messages on the next fire if a write fails', async () => {
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'addMessages')
      store.addMessages.mockRejectedValueOnce(new Error('backend down'))
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      await addMessages(agent, userMsg('important'))
      await fireInvocation(agent, mm) // fails, mark rolled back
      await fireInvocation(agent, mm) // retries

      expect(store.addMessages).toHaveBeenCalledTimes(2)
      expect(store.addMessages.mock.calls[1]![0] as MessageData[]).toHaveLength(1)
    })
  })

  describe('backing off and recovering from a failing store', () => {
    /** Runs one turn: adds a message, fires the trigger, flushes. */
    async function turn(agent: MockAgent, mm: MemoryManager, text: string): Promise<void> {
      await addMessages(agent, userMsg(text))
      await fireInvocation(agent, mm)
    }

    /** A coordinator with one always-failing store, driven via process() for exact attempt counts. */
    function failingCoordinator(): {
      coordinator: ExtractionCoordinator
      store: ReturnType<typeof createExtractionStore>
    } {
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'addMessages')
      store.addMessages.mockRejectedValue(new Error('backend down'))
      const coordinator = new ExtractionCoordinator([asExtractionStore(store)], {} as Model, new Tracer())
      return { coordinator, store }
    }

    it('backs off to periodic probes after SAVE_FAILURES_BEFORE_BACKOFF failures in a row', async () => {
      const { coordinator, store } = failingCoordinator()

      // Each call buffers a message and requests a save; every save fails. Run enough backed-off
      // requests for exactly two probe intervals.
      const PROBES = 2
      for (let i = 0; i < SAVE_FAILURES_BEFORE_BACKOFF + BACKOFF_PROBE_INTERVAL * PROBES; i++) {
        coordinator.record(userMsg(`m${i}`).toJSON())
        await coordinator.process(store)
      }

      // Attempts every request until backoff, then only every BACKOFF_PROBE_INTERVAL-th request.
      expect(store.addMessages).toHaveBeenCalledTimes(SAVE_FAILURES_BEFORE_BACKOFF + PROBES)
    })

    it('recovers and saves the buffered backlog when the store comes back', async () => {
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'addMessages')
      store.addMessages.mockRejectedValue(new Error('down'))
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      // Enter backoff.
      for (let i = 0; i < SAVE_FAILURES_BEFORE_BACKOFF; i++) {
        await turn(agent, mm, `down${i}`)
      }
      // Store recovers; run probe-interval turns so a probe lands and succeeds.
      store.addMessages.mockReset()
      store.addMessages.mockResolvedValue(undefined)
      for (let i = 0; i < BACKOFF_PROBE_INTERVAL; i++) {
        await turn(agent, mm, `up${i}`)
      }

      // The recovering probe saved, and its batch includes the messages buffered during the outage.
      expect(store.addMessages).toHaveBeenCalled()
      const saved = store.addMessages.mock.calls.flatMap((c) => c[0] as MessageData[])
      const texts = saved.flatMap((m) => m.content.map((b) => ('text' in b ? b.text : '')))
      expect(texts).toContain('down0')
      expect(texts).toContain('up0')
    })

    it('a healthy store keeps saving every request while a sibling is backed off', async () => {
      const bad = createExtractionStore('bad', { trigger: [new InvocationTrigger()] }, 'addMessages')
      bad.addMessages.mockRejectedValue(new Error('down'))
      const good = createExtractionStore('good', { trigger: [new InvocationTrigger()] }, 'addMessages')
      const coordinator = new ExtractionCoordinator(
        [asExtractionStore(bad), asExtractionStore(good)],
        {} as Model,
        new Tracer()
      )

      const PROBES = 2
      const requests = SAVE_FAILURES_BEFORE_BACKOFF + BACKOFF_PROBE_INTERVAL * PROBES
      for (let i = 0; i < requests; i++) {
        coordinator.record(userMsg(`m${i}`).toJSON())
        await coordinator.process(bad)
        await coordinator.process(good)
      }

      // Good store saves every request; bad store stops at backoff + its probes.
      expect(good.addMessages).toHaveBeenCalledTimes(requests)
      expect(bad.addMessages).toHaveBeenCalledTimes(SAVE_FAILURES_BEFORE_BACKOFF + PROBES)
    })

    it('flush resolves even when a store is failing', async () => {
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'addMessages')
      store.addMessages.mockRejectedValue(new Error('down'))
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      await addMessages(agent, userMsg('x'))
      await expect(fireInvocation(agent, mm)).resolves.toBeUndefined()
      await expect(mm.flush()).resolves.toBeUndefined()
    })

    it('flush bypasses backoff and writes the backlog of a recovered store', async () => {
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'addMessages')
      store.addMessages.mockRejectedValue(new Error('down'))
      const coordinator = new ExtractionCoordinator([asExtractionStore(store)], {} as Model, new Tracer())

      // Drive the store into backoff.
      for (let i = 0; i < SAVE_FAILURES_BEFORE_BACKOFF; i++) {
        coordinator.record(userMsg(`down${i}`).toJSON())
        await coordinator.process(store)
      }
      // Store recovers and a final message arrives, but no probe has landed yet.
      store.addMessages.mockReset()
      store.addMessages.mockResolvedValue(undefined)
      coordinator.record(userMsg('final').toJSON())

      // A single flush must write the backlog despite backoff (not be probe-gated to a no-op).
      await coordinator.flush()

      expect(store.addMessages).toHaveBeenCalledTimes(1)
      const saved = (store.addMessages.mock.calls[0]![0] as MessageData[]).flatMap((m) =>
        m.content.map((b) => ('text' in b ? b.text : ''))
      )
      expect(saved).toContain('final')
      expect(saved).toContain('down0')
    })

    it('a fully-filtered (empty) turn does not reset the failure streak', async () => {
      // A no-extractor store; the default filter drops tool blocks. A turn of only tool blocks
      // filters to empty, so the backend is never called - it must not be mistaken for a recovery and
      // clear the prior failures. We prove that by showing backoff still engages at the threshold.
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'addMessages')
      store.addMessages.mockRejectedValue(new Error('down'))
      const coordinator = new ExtractionCoordinator([asExtractionStore(store)], {} as Model, new Tracer())

      // One short of backoff.
      for (let i = 0; i < SAVE_FAILURES_BEFORE_BACKOFF - 1; i++) {
        coordinator.record(userMsg(`m${i}`).toJSON())
        await coordinator.process(store)
      }
      // An all-tool-blocks turn filters to empty: backend not called, streak not reset.
      const toolOnly = new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ name: 't', toolUseId: '1', input: {} })],
      })
      coordinator.record(toolOnly.toJSON())
      await coordinator.process(store)
      // The Nth real failure now tips into backoff (it would not if the empty turn had reset to 0).
      coordinator.record(userMsg('nth').toJSON())
      await coordinator.process(store)

      // Backed off: the next request is probe-gated, so the backend isn't called immediately.
      store.addMessages.mockClear()
      coordinator.record(userMsg('after').toJSON())
      await coordinator.process(store)
      expect(store.addMessages).not.toHaveBeenCalled()
    })
  })

  describe('triggers', () => {
    it('IntervalTrigger fires every N invocations', async () => {
      const store = createExtractionStore('s', { trigger: [new IntervalTrigger({ turns: 2 })] }, 'addMessages')
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      // Fire the raw hook (not the flushing helper) so we observe interval gating, not flush's
      // force-completion.
      await addMessages(agent, userMsg('a'))
      await invokeAll(agent, new AfterInvocationEvent({ agent, invocationState: {} })) // count 1, no fire
      expect(store.addMessages).not.toHaveBeenCalled()

      await addMessages(agent, userMsg('b'))
      await fireInvocation(agent, mm) // count 2, fire (+ flush drains it)
      expect(store.addMessages).toHaveBeenCalledTimes(1)
      expect(store.addMessages.mock.calls[0]![0] as MessageData[]).toHaveLength(2)
    })

    it('IntervalTrigger rejects non-positive turns', () => {
      expect(() => new IntervalTrigger({ turns: 0 })).toThrow('positive integer')
    })

    it('accepts a single trigger (not wrapped in an array)', async () => {
      const store = createExtractionStore('s', { trigger: new InvocationTrigger() }, 'addMessages')
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      await addMessages(agent, userMsg('hi'))
      await fireInvocation(agent, mm)

      expect(store.addMessages).toHaveBeenCalledTimes(1)
    })

    it('composes multiple triggers (extraction fires on any)', async () => {
      // Both an interval(every 2) and an invocation(every turn): the invocation trigger fires turn 1.
      const store = createExtractionStore(
        's',
        { trigger: [new IntervalTrigger({ turns: 2 }), new InvocationTrigger()] },
        'addMessages'
      )
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      await addMessages(agent, userMsg('a'))
      await fireInvocation(agent, mm)

      // Invocation trigger fired on turn 1 even though interval would not have.
      expect(store.addMessages).toHaveBeenCalledTimes(1)
    })

    it('does not register hooks when no store has extraction', async () => {
      const store: MemoryStore = { name: 's', writable: true, search: vi.fn(), add: vi.fn() }
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)
      expect(agent.trackedHooks).toHaveLength(0)
    })
  })

  describe('background execution', () => {
    it('does not block the AfterInvocationEvent hook on the store write', async () => {
      // A store whose write hangs until we release it. If extraction blocked the loop, awaiting the
      // hook would never resolve while the write is pending.
      let release!: () => void
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'addMessages')
      store.addMessages.mockReturnValue(blocked)

      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)
      await addMessages(agent, userMsg('hello'))

      // Fire the hook directly (not via the flushing helper) — it must resolve while the write hangs.
      await invokeAll(agent, new AfterInvocationEvent({ agent, invocationState: {} }))
      expect(store.addMessages).toHaveBeenCalledTimes(1)

      // The write is still pending; releasing it lets flush() resolve.
      release()
      await mm.flush()
    })

    it('flush awaits the in-flight extraction write', async () => {
      let resolved = false
      let release!: () => void
      const blocked = new Promise<void>((resolve) => {
        release = (): void => {
          resolved = true
          resolve()
        }
      })
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'addMessages')
      store.addMessages.mockReturnValue(blocked)

      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)
      await addMessages(agent, userMsg('hello'))
      await invokeAll(agent, new AfterInvocationEvent({ agent, invocationState: {} }))

      const flushed = mm.flush()
      release()
      await flushed
      expect(resolved).toBe(true)
    })

    it('flush is a no-op when extraction is not configured', async () => {
      const store: MemoryStore = { name: 's', writable: true, search: vi.fn(), add: vi.fn() }
      const mm = new MemoryManager({ stores: [store] })
      mm.initAgent(createMockAgent())
      await expect(mm.flush()).resolves.toBeUndefined()
    })

    it('flush force-extracts a buffered tail whose trigger never fired', async () => {
      // IntervalTrigger(5) but the session ends after 2 turns -> the trigger never fires. flush()
      // must still extract the buffered messages rather than lose them on graceful shutdown.
      const store = createExtractionStore('s', { trigger: [new IntervalTrigger({ turns: 5 })] }, 'addMessages')
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      await addMessages(agent, userMsg('a'))
      await invokeAll(agent, new AfterInvocationEvent({ agent, invocationState: {} })) // count 1, no fire
      await addMessages(agent, userMsg('b'))
      await invokeAll(agent, new AfterInvocationEvent({ agent, invocationState: {} })) // count 2, no fire
      expect(store.addMessages).not.toHaveBeenCalled()

      await mm.flush()

      expect(store.addMessages).toHaveBeenCalledTimes(1)
      expect(store.addMessages.mock.calls[0]![0] as MessageData[]).toHaveLength(2)
    })

    it('flush does not re-extract messages already processed by a fired trigger', async () => {
      const store = createExtractionStore('s', { trigger: [new InvocationTrigger()] }, 'addMessages')
      const mm = new MemoryManager({ stores: [store] })
      const agent = createMockAgent()
      await mm.initAgent(agent)

      await addMessages(agent, userMsg('a'))
      await fireInvocation(agent, mm) // invocation trigger already extracted + flushed
      expect(store.addMessages).toHaveBeenCalledTimes(1)

      await mm.flush() // nothing fresh -> no-op
      expect(store.addMessages).toHaveBeenCalledTimes(1)
    })
  })
})
