import { describe, it, expect, inject, beforeAll, onTestFinished } from 'vitest'
import { BedrockAgentClient, DeleteKnowledgeBaseDocumentsCommand } from '@aws-sdk/client-bedrock-agent'
import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'

import { Agent, MemoryManager, InvocationTrigger, IntervalTrigger, InvokeModelStage } from '$/sdk/index.js'
import type { Message } from '$/sdk/index.js'
import type { ExtractionConfig } from '$/sdk/memory/extraction/types.js'
import { BedrockKnowledgeBaseStore } from '$/sdk/vended-memory-stores/bedrock-knowledge-base/index.js'
import { bedrock } from '../__fixtures__/model-providers.js'
import { getMessageText } from '../__fixtures__/model-test-helpers.js'
import { hasToolUse, waitFor } from '../__fixtures__/test-helpers.js'
import { uniqueMarker, waitForIndexed, cleanupCustomDocument, searchUntil } from './_bedrock-kb-test-helpers.js'

// Manual overrides — swap these to point at your own resources for local development.
const OVERRIDES: Partial<{
  knowledgeBaseId: string
  customDataSourceId: string
}> = {
  // knowledgeBaseId: 'YOUR-KB-ID',
  // customDataSourceId: 'YOUR-CUSTOM-DS-ID',
}

function config() {
  const kb = inject('provider-bedrock-kb')
  return {
    knowledgeBaseId: OVERRIDES.knowledgeBaseId ?? kb.knowledgeBaseId!,
    customDataSourceId: OVERRIDES.customDataSourceId ?? kb.customDataSourceId!,
  }
}

// The manager's default tool names (memory-manager.ts: `config.name ?? 'search_memory'` / `'add_memory'`).
// Kept here so an assertion can't silently go stale if a default changes.
const SEARCH_TOOL = 'search_memory'
const ADD_TOOL = 'add_memory'

// Seeded facts reused across the injection and search tests: a retrievable phrase plus the token each
// test asserts the model surfaced.
function willowFact(): { text: string; answer: string } {
  const answer = uniqueMarker('willow-tag')
  return { text: `The weeping willow in the meditation garden carries botanical tag ${answer}.`, answer }
}
function doveFact(): { text: string; answer: string } {
  const answer = uniqueMarker('dove-ring')
  return { text: `The dove in the wildlife sanctuary wears identification ring ${answer}.`, answer }
}

/**
 * These tests drive the full {@link MemoryManager} — extraction, injection, and the search/add
 * tools — through a real {@link Agent} against a live Bedrock Knowledge Base. They need BOTH a
 * Bedrock model and the KB, so they skip unless both are available (the store-level tests in
 * bedrock-knowledge-base-store.test.node.ts need only the KB).
 *
 * Each block enables ONLY the manager feature it asserts and turns the rest off, so a pass cannot
 * be explained by an unintended path (e.g. injection tests disable the search tool, so a correct
 * answer can only have come from the auto-injected <memory> context).
 */
const shouldSkip = () => inject('provider-bedrock-kb').shouldSkip || bedrock.skip

describe('BedrockKnowledgeBaseStore MemoryManager E2E', () => {
  let agentClient: BedrockAgentClient
  let runtimeClient: BedrockAgentRuntimeClient

  beforeAll(async () => {
    if (shouldSkip()) return
    const credentials = await fromNodeProviderChain()()
    agentClient = new BedrockAgentClient({ credentials })
    runtimeClient = new BedrockAgentRuntimeClient({ credentials })
  })

  // ---------------------------------------------------------------------------
  // Helpers (defined inside the describe so they capture the clients from beforeAll)
  // ---------------------------------------------------------------------------

  /** Builds a writable CUSTOM store with a unique scope so tests never cross-contaminate retrieval. */
  function makeStore(
    name: string,
    options?: { scope?: string; extraction?: boolean | ExtractionConfig }
  ): BedrockKnowledgeBaseStore {
    const { knowledgeBaseId, customDataSourceId } = config()
    return new BedrockKnowledgeBaseStore({
      config: {
        knowledgeBaseId,
        dataSourceType: 'CUSTOM',
        dataSourceId: customDataSourceId,
        runtimeClient,
        agentClient,
      },
      name,
      writable: true,
      scope: options?.scope ?? uniqueMarker('mm-scope'),
      ...(options?.extraction !== undefined && { extraction: options.extraction }),
    })
  }

  /**
   * Wraps `store.add` so every document id written *through the manager* (extraction, add_memory) is
   * captured for cleanup — the manager discards the returned id. The instance property shadows the
   * prototype method; the manager reads the same reference and its `typeof add === 'function'` check
   * still passes. Returns the (live) id array; registers best-effort cleanup via onTestFinished.
   *
   * Deletes directly here rather than delegating to `cleanupCustomDocument` (which registers its own
   * `onTestFinished`): registering a finished-hook from inside a finished-hook is unreliable in
   * vitest, and the captured ids aren't known until the test body has run anyway.
   */
  function captureAddedIds(store: BedrockKnowledgeBaseStore): string[] {
    const { knowledgeBaseId, customDataSourceId } = config()
    const ids: string[] = []
    const orig = store.add.bind(store)
    store.add = async (content, metadata) => {
      const result = await orig(content, metadata)
      ids.push(result.documentId)
      return result
    }
    onTestFinished(async () => {
      if (ids.length === 0) return
      try {
        await agentClient.send(
          new DeleteKnowledgeBaseDocumentsCommand({
            knowledgeBaseId,
            dataSourceId: customDataSourceId,
            documentIdentifiers: ids.map((id) => ({ dataSourceType: 'CUSTOM', custom: { id } })),
          })
        )
      } catch {
        // best-effort — don't mask test failures
      }
    })
    return ids
  }

  /** Seeds a fact directly, waits for it to index, and registers cleanup. Returns the document id. */
  async function seedFact(store: BedrockKnowledgeBaseStore, content: string): Promise<string> {
    const { knowledgeBaseId, customDataSourceId } = config()
    const { documentId } = await store.add(content)
    cleanupCustomDocument(agentClient, knowledgeBaseId, customDataSourceId, documentId)
    await waitForIndexed(agentClient, knowledgeBaseId, customDataSourceId, {
      dataSourceType: 'CUSTOM',
      custom: { id: documentId },
    })
    return documentId
  }

  /**
   * Registers an observer on the InvokeModelStage input phase AFTER the agent initializes, so it runs
   * after the manager's injection middleware (input handlers compose in registration order, each
   * seeing the prior's output). Returns a getter for the messages the model last saw — i.e. the
   * ephemeral, post-injection input — without depending on the model's response.
   */
  async function observeModelInput(agent: Agent): Promise<() => readonly Message[] | undefined> {
    await agent.initialize()
    let seen: readonly Message[] | undefined
    agent.addMiddleware(InvokeModelStage.Input, async (ctx) => {
      seen = ctx.messages
      return ctx
    })
    return () => seen
  }

  /**
   * Forces the named tool on the FIRST model call only, via an InvokeModelStage.Input middleware that
   * sets `ctx.toolChoice` once and then steps aside. This removes the one nondeterministic variable in
   * the tool tests — whether the model *chooses* to call the tool from a natural-language hint — while
   * still exercising the real path (the manager registers the tool; the agent invokes it; the result
   * flows back). It must fire only once: forcing the tool on every call would loop forever, since the
   * model could never emit its final text answer after the tool result. `toolChoice` isn't on the
   * public InvokeOptions, but the agent honors `ctx.toolChoice` (agent.ts) — this is how to set it.
   */
  async function forceToolOnce(agent: Agent, toolName: string): Promise<void> {
    await agent.initialize()
    let forced = false
    agent.addMiddleware(InvokeModelStage.Input, async (ctx) => {
      if (forced) return ctx
      forced = true
      return { ...ctx, toolChoice: { tool: { name: toolName } } }
    })
  }

  // ---------------------------------------------------------------------------
  // Extraction — automatic distillation of a turn into the KB via store.add.
  // Tools off (searchToolConfig: false, add tool off) so the only write path is extraction.
  // The store implements only `add`, so resolveExtractionConfig auto-selects a ModelExtractor on the
  // agent's model. Each `it` varies only WHEN extraction fires.
  //
  // The trigger tests do NOT call flush(): flush() force-saves every store regardless of triggers, so
  // it would prove "flush works", not "the trigger fired". Instead they poll the captured id list to
  // await the real autonomous path (AfterInvocationEvent -> trigger.fire() -> background process()).
  // flush() gets its own dedicated test below.
  // ---------------------------------------------------------------------------

  describe.skipIf(shouldSkip())('extraction', () => {
    it('extracts and stores a fact with InvocationTrigger (fires every turn, no flush)', async () => {
      const store = makeStore('integ-mm-extract-invocation', {
        extraction: { trigger: [new InvocationTrigger()] },
      })
      const ids = captureAddedIds(store)
      const memoryManager = new MemoryManager({ stores: [store], searchToolConfig: false })
      const agent = new Agent({ model: bedrock.createModel({ maxTokens: 1024 }), memoryManager, printer: false })

      const marker = uniqueMarker('extract-invocation')
      await agent.invoke(`Please remember this fact: the project codename is ${marker}.`)

      // No flush (see block note): the trigger fires on its own; the write is in the background.
      expect(await waitFor(() => ids.length > 0)).toBe(true)
      expect(await searchUntil(store, marker, (c) => c.includes(marker))).toBeDefined()

      // Drain any still-in-flight background writes so they're captured before cleanup runs (a single
      // turn can extract multiple entries, each resolving on its own). The autonomous-path assertions
      // above already ran without flush — this only guarantees deterministic cleanup.
      await memoryManager.flush()
    }, 120_000)

    it('honors IntervalTrigger cadence (extracts every 2 turns, not before, no flush)', async () => {
      const store = makeStore('integ-mm-extract-interval', {
        extraction: { trigger: [new IntervalTrigger({ turns: 2 })] },
      })
      const ids = captureAddedIds(store)
      const memoryManager = new MemoryManager({ stores: [store], searchToolConfig: false })
      const agent = new Agent({ model: bedrock.createModel({ maxTokens: 1024 }), memoryManager, printer: false })

      const marker = uniqueMarker('extract-interval')
      // Turn 1: the trigger should NOT fire yet (cadence is every 2 turns). Give the background path a
      // moment to prove it stays idle — nothing should be written.
      await agent.invoke(`Please remember this fact: the project codename is ${marker}.`)
      expect(await waitFor(() => ids.length > 0, { timeoutMs: 5_000 })).toBe(false)

      // Turn 2: the trigger fires, draining buffered messages from both turns (still no flush).
      await agent.invoke('Thanks. Keep that in mind.')
      expect(await waitFor(() => ids.length > 0)).toBe(true)
      expect(await searchUntil(store, marker, (c) => c.includes(marker))).toBeDefined()

      // Drain stragglers for deterministic cleanup (see InvocationTrigger test).
      await memoryManager.flush()
    }, 120_000)

    it('flush() force-saves on demand when the trigger has not fired (extraction: true, every 5 turns)', async () => {
      const store = makeStore('integ-mm-extract-true', { extraction: true })
      const ids = captureAddedIds(store)
      const memoryManager = new MemoryManager({ stores: [store], searchToolConfig: false })
      const agent = new Agent({ model: bedrock.createModel({ maxTokens: 1024 }), memoryManager, printer: false })

      const marker = uniqueMarker('extract-true')
      await agent.invoke(`Please remember this fact: the project codename is ${marker}.`)

      // The default IntervalTrigger(5) has NOT fired after one turn, so the autonomous path writes
      // nothing — this is what makes flush() observable here.
      expect(await waitFor(() => ids.length > 0, { timeoutMs: 5_000 })).toBe(false)

      // flush() bypasses the trigger schedule and force-saves the buffered turn on demand.
      await memoryManager.flush()
      expect(ids.length).toBeGreaterThan(0)
      expect(await searchUntil(store, marker, (c) => c.includes(marker))).toBeDefined()
    }, 120_000)
  })

  // ---------------------------------------------------------------------------
  // Injection — retrieved memory folded into the model input ephemerally (NOT the search tool).
  // searchToolConfig: false so the ONLY path to the seeded fact is auto-injection.
  // ---------------------------------------------------------------------------

  describe.skipIf(shouldSkip())('injection', () => {
    it('folds a <memory> block into the model input and never touches durable history', async () => {
      const store = makeStore('integ-mm-inject')
      const fact = willowFact()
      await seedFact(store, fact.text)

      const memoryManager = new MemoryManager({ stores: [store], injection: true, searchToolConfig: false })
      const agent = new Agent({ model: bedrock.createModel({ maxTokens: 1024 }), memoryManager, printer: false })
      const getSeen = await observeModelInput(agent)

      // The answer is a non-guessable code, so a correct response can only come from the injected fact.
      const prompt = 'What botanical tag does the weeping willow in the meditation garden carry?'
      const result = await agent.invoke(prompt)

      // 1. The model input carried the injected memory (ephemeral fold into the latest user message).
      const seen = getSeen()
      expect(seen).toBeDefined()
      const injectedText = seen!.map((m) => getMessageText(m)).join('\n')
      expect(injectedText).toContain('<memory>')
      expect(injectedText).toContain(`source="${store.name}"`)
      expect(injectedText).toContain(fact.answer)

      // 2. Durable history is untouched: the stored user message is byte-identical to the original
      //    prompt (injection folds into the per-call copy only, never agent.messages), and the search
      //    tool was never used (it's disabled) — proving the answer came from injection, not a tool.
      const firstUserMessage = agent.messages.find((m) => m.role === 'user')
      expect(firstUserMessage).toBeDefined()
      expect(getMessageText(firstUserMessage!)).toBe(prompt)
      expect(hasToolUse(agent.messages, SEARCH_TOOL)).toBe(false)

      // 3. The model actually used the injected fact (the unique tag can't be guessed).
      expect(getMessageText(result.lastMessage)).toContain(fact.answer)
    }, 120_000)

    it('injects from multiple stores with per-store source attribution', async () => {
      const storeA = makeStore('alpha')
      const storeB = makeStore('beta')
      const willow = willowFact()
      const dove = doveFact()
      await seedFact(storeA, willow.text)
      await seedFact(storeB, dove.text)

      const memoryManager = new MemoryManager({
        stores: [storeA, storeB],
        injection: true,
        searchToolConfig: false,
      })
      const agent = new Agent({ model: bedrock.createModel({ maxTokens: 1024 }), memoryManager, printer: false })
      const getSeen = await observeModelInput(agent)

      await agent.invoke("What is the willow's botanical tag, and what is the dove's identification ring?")

      const seen = getSeen()
      expect(seen).toBeDefined()
      const injectedText = seen!.map((m) => getMessageText(m)).join('\n')
      // Both stores contributed entries, each attributed to its own source AND carrying its own fact
      // (asserting the unique codes too, so an empty <entry source="..."> can't satisfy the test).
      expect(injectedText).toContain('source="alpha"')
      expect(injectedText).toContain('source="beta"')
      expect(injectedText).toContain(willow.answer)
      expect(injectedText).toContain(dove.answer)
    }, 120_000)
  })

  // ---------------------------------------------------------------------------
  // search_memory tool — explicit, model-driven retrieval. Injection is disabled so the only path to
  // the fact is the tool: injection is on by default and would otherwise fold the seeded fact into
  // the prompt, letting a correct answer bypass the tool.
  // ---------------------------------------------------------------------------

  describe.skipIf(shouldSkip())('search_memory tool', () => {
    it('the model retrieves a seeded fact via the search_memory tool', async () => {
      const store = makeStore('integ-mm-search-tool')
      const fact = doveFact()
      await seedFact(store, fact.text)

      const memoryManager = new MemoryManager({ stores: [store], injection: false })
      const agent = new Agent({ model: bedrock.createModel({ maxTokens: 1024 }), memoryManager, printer: false })
      await forceToolOnce(agent, SEARCH_TOOL)

      const result = await agent.invoke(
        "Use your memory tools to look up the dove's identification ring in the wildlife sanctuary, then tell me."
      )

      expect(hasToolUse(agent.messages, SEARCH_TOOL)).toBe(true)
      expect(getMessageText(result.lastMessage)).toContain(fact.answer)
    }, 120_000)

    it('routes a search across multiple stores and finds the fact wherever it lives', async () => {
      const storeA = makeStore('integ-mm-search-a')
      const storeB = makeStore('integ-mm-search-b')
      // Fact lives only in store B — the manager must fan out across both.
      const fact = doveFact()
      await seedFact(storeB, fact.text)

      const memoryManager = new MemoryManager({ stores: [storeA, storeB], injection: false })
      const agent = new Agent({ model: bedrock.createModel({ maxTokens: 1024 }), memoryManager, printer: false })
      await forceToolOnce(agent, SEARCH_TOOL)

      const result = await agent.invoke(
        "Use your memory tools to look up the dove's identification ring in the wildlife sanctuary, then tell me."
      )

      expect(hasToolUse(agent.messages, SEARCH_TOOL)).toBe(true)
      expect(getMessageText(result.lastMessage)).toContain(fact.answer)
    }, 120_000)
  })

  // ---------------------------------------------------------------------------
  // add_memory tool — model-driven persistence. Search tool + injection off so the only path is the
  // add tool.
  // ---------------------------------------------------------------------------

  describe.skipIf(shouldSkip())('add_memory tool', () => {
    it('the model persists a fact via the add_memory tool', async () => {
      const store = makeStore('integ-mm-add-tool')
      const ids = captureAddedIds(store)

      const memoryManager = new MemoryManager({
        stores: [store],
        addToolConfig: true,
        searchToolConfig: false,
        injection: false,
      })
      const agent = new Agent({ model: bedrock.createModel({ maxTokens: 1024 }), memoryManager, printer: false })
      await forceToolOnce(agent, ADD_TOOL)

      const marker = uniqueMarker('add-tool')
      await agent.invoke(
        `Please remember for later, using your memory tools: the quietest grove in the forest is cataloged as ${marker}.`
      )

      expect(hasToolUse(agent.messages, ADD_TOOL)).toBe(true)
      expect(ids.length).toBeGreaterThan(0)
      expect(await searchUntil(store, marker, (c) => c.includes(marker))).toBeDefined()
    }, 120_000)
  })
})
