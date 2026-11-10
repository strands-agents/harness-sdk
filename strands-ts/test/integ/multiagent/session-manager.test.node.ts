/**
 * Integration tests for multi-agent session management (Swarm and Graph resume).
 * Node-only: uses FileStorage which requires fs.
 *
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { v7 as uuidv7 } from 'uuid'
import { Agent } from '$/sdk/agent/agent.js'
import {
  Swarm,
  Status,
  Graph,
  BeforeNodeCallEvent,
  BeforeMultiAgentInvocationEvent,
  MultiAgentState,
} from '$/sdk/multiagent/index.js'
import type { EdgeDefinition } from '$/sdk/multiagent/index.js'
import { SessionManager } from '$/sdk/session/session-manager.js'
import { FileStorage } from '$/sdk/session/file-storage.js'
import { bedrock } from '../__fixtures__/model-providers.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSessionManager(sessionId: string, storageDir: string): SessionManager {
  return new SessionManager({ sessionId, storage: { snapshot: new FileStorage(storageDir) } })
}

function createResearcherWriterNodes(createModel: () => ReturnType<typeof bedrock.createModel>) {
  return [
    new Agent({
      model: createModel(),
      printer: false,
      id: 'researcher',
      description: 'Researches a topic then hands off to the writer.',
      systemPrompt:
        'You are a researcher. Research the answer, then always hand off to the writer. Never produce a final response yourself.',
    }),
    new Agent({
      model: createModel(),
      printer: false,
      id: 'writer',
      description: 'Writes a polished final answer in one sentence.',
      systemPrompt: 'Write the final answer in one sentence. Do not hand off.',
    }),
  ]
}

// ─── Swarm Resume ────────────────────────────────────────────────────────────

describe.skipIf(bedrock.skip)('Multi-Agent Session Management - Swarm', () => {
  const createModel = (maxTokens = 1024) => bedrock.createModel({ maxTokens })
  let tempDir: string

  beforeAll(async () => {
    tempDir = join(tmpdir(), `strands-multiagent-session-integ-${Date.now()}`)
    await fs.mkdir(tempDir, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('resumes from the pending handoff target after maxSteps stops the swarm', async () => {
    const sessionId = uuidv7()
    const swarmId = 'resume-swarm'

    // First invocation: researcher hands off to writer, but maxSteps=1 stops before writer runs
    const swarm1 = new Swarm({
      id: swarmId,
      nodes: createResearcherWriterNodes(createModel),
      start: 'researcher',
      maxSteps: 1,
      plugins: [makeSessionManager(sessionId, tempDir)],
    })

    await expect(swarm1.invoke('What is the tallest mountain?')).rejects.toThrow('swarm reached step limit')

    // Second invocation: new Swarm + SessionManager simulates process restart
    const swarm2 = new Swarm({
      id: swarmId,
      nodes: createResearcherWriterNodes(createModel),
      start: 'researcher',
      plugins: [makeSessionManager(sessionId, tempDir)],
    })

    const result = await swarm2.invoke('What is the tallest mountain?')

    expect(result.status).toBe(Status.COMPLETED)
    expect(result.results.map((r) => r.nodeId)).toStrictEqual(['researcher', 'writer'])

    const text = result.content.find((b) => b.type === 'textBlock')
    expect(text?.text).toMatch(/Everest/i)
  })
})

// ─── Graph Resume ────────────────────────────────────────────────────────────
describe.skipIf(bedrock.skip)('Multi-Agent Session Management - Graph', () => {
  const createModel = (maxTokens = 1024) => bedrock.createModel({ maxTokens })
  let tempDir: string

  beforeAll(async () => {
    tempDir = join(tmpdir(), `strands-graph-session-integ-${Date.now()}`)
    await fs.mkdir(tempDir, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  /**
   * Graph topology (parallel branches + sub-graph):
   *
   *   researcher ──→ analyst ──→ reporter
   *       │                         ↑
   *       └──→ sub-graph ───────────┘
   *             (drafter → reviewer)
   *
   * - `researcher` is the source node.
   * - `analyst` and `sub-graph` run in parallel after researcher completes.
   * - `reporter` waits for both analyst AND sub-graph (AND-join).
   * - `sub-graph` is a nested Graph with two nodes: drafter → reviewer.
   *
   * First run: researcher and analyst complete, sub-graph is cancelled via hook.
   * Resume: sub-graph executes (dep researcher=COMPLETED), then reporter fires
   *         (deps analyst=COMPLETED, sub-graph=COMPLETED).
   *
   * This tests:
   * - sessionManager constructor arg (not plugins)
   * - parallel execution (default maxConcurrency)
   * - sub-graph (MultiAgentNode) resume
   * - AND-join dependency resolution across resume boundary
   * - cross-boundary data flow (reporter receives outputs from both runs)
   */
  it('resumes graph with parallel branches and sub-graph across session boundary', async () => {
    const sessionId = uuidv7()
    const graphId = 'resume-subgraph'

    function makeAgent(id: string, prompt: string) {
      return new Agent({ model: createModel(), printer: false, id, systemPrompt: prompt })
    }

    function createSubGraph() {
      return new Graph({
        id: 'sub-graph',
        nodes: [
          makeAgent('drafter', 'You are a drafter. Write a one-sentence draft about the topic.'),
          makeAgent(
            'reviewer',
            'You are a reviewer. Improve the draft in one sentence. Mention "Everest" if the topic is about mountains.'
          ),
        ],
        edges: [['drafter', 'reviewer']],
      })
    }

    function createNodes() {
      return [
        makeAgent('researcher', 'You are a researcher. State the topic of the question in one sentence.'),
        makeAgent('analyst', 'You are an analyst. Add one key fact about the topic from the researcher.'),
        createSubGraph(),
        makeAgent(
          'reporter',
          'You are a reporter. Combine all inputs into a final two-sentence summary. Mention "Everest" if the topic is about mountains.'
        ),
      ]
    }

    const edges: [string, string][] = [
      ['researcher', 'analyst'],
      ['researcher', 'sub-graph'],
      ['analyst', 'reporter'],
      ['sub-graph', 'reporter'],
    ]

    // ── Run 1: cancel sub-graph so only researcher + analyst complete ──
    const graph1 = new Graph({
      id: graphId,
      nodes: createNodes(),
      edges,
      sessionManager: makeSessionManager(sessionId, tempDir),
    })

    graph1.addHook(BeforeNodeCallEvent, (event) => {
      if (event.nodeId === 'sub-graph') {
        event.cancel = 'simulated crash'
      }
    })

    const result1 = await graph1.invoke('What is the tallest mountain in the world?')

    const completedRun1 = result1.results.filter((r) => r.status === Status.COMPLETED).map((r) => r.nodeId)
    expect(completedRun1).toContain('researcher')
    expect(completedRun1).toContain('analyst')
    expect(completedRun1).not.toContain('sub-graph')
    expect(completedRun1).not.toContain('reporter')

    // Verify sessionManager property is accessible
    expect(graph1.sessionManager).toBeDefined()

    // ── Run 2: fresh Graph + SessionManager, no cancel hook ──
    const graph2 = new Graph({
      id: graphId,
      nodes: createNodes(),
      edges,
      sessionManager: makeSessionManager(sessionId, tempDir),
    })

    const result2 = await graph2.invoke('What is the tallest mountain in the world?')

    const completedRun2 = result2.results.filter((r) => r.status === Status.COMPLETED).map((r) => r.nodeId)

    // Sub-graph and reporter should now be completed
    expect(completedRun2).toContain('sub-graph')
    expect(completedRun2).toContain('reporter')

    // Researcher and analyst should not be re-executed (exactly one COMPLETED each)
    expect(completedRun2.filter((id) => id === 'researcher')).toHaveLength(1)
    expect(completedRun2.filter((id) => id === 'analyst')).toHaveLength(1)

    // All completed nodes produced content
    for (const nodeResult of result2.results.filter((r) => r.status === Status.COMPLETED)) {
      expect(nodeResult.content.length).toBeGreaterThan(0)
    }

    // Reporter is the terminus — verify it received data from both branches
    // (analyst from run 1, sub-graph from run 2) by checking for topic-relevant content
    const reporterText = result2.results
      .filter((r) => r.nodeId === 'reporter' && r.status === Status.COMPLETED)
      .flatMap((r) => r.content)
      .find((b) => b.type === 'textBlock')?.text
    expect(reporterText).toBeTruthy()
    expect(reporterText).toMatch(/Everest|mountain|tallest/i)
  })

  /**
   * Graph topology with conditional edge:
   *
   *   researcher ──→ writer  (conditional: only if app state has 'approved' flag)
   *       │              ↑
   *       └──→ analyst ──┘  (unconditional)
   *
   * - `researcher` and `analyst` are sources (no incoming edges).
   * - `writer` has an AND-join: needs both researcher and analyst COMPLETED,
   *   AND the researcher→writer conditional edge handler to return true.
   *
   * Run 1: researcher and analyst both complete normally. But the conditional
   *   edge handler checks `state.app.get('approved')` which is not set, so
   *   _findReady evaluates the handler → false → writer is blocked.
   *   All deps are COMPLETED but the handler rejects the transition.
   *
   * Run 2 (resume): state is restored (researcher=COMPLETED, analyst=COMPLETED,
   *   writer=PENDING). A BeforeMultiAgentInvocationEvent hook sets approved=true.
   *   _findResumeTargets evaluates the handler via _allDependenciesSatisfied
   *   → true → writer is ready and executes.
   *
   * This directly tests that _findResumeTargets evaluates edge handlers,
   * not just source node statuses.
   */
  it('resumes with conditional edge handlers evaluated correctly', async () => {
    const sessionId = uuidv7()
    const graphId = 'resume-conditional'

    function makeAgent(id: string, prompt: string) {
      return new Agent({ model: createModel(), printer: false, id, systemPrompt: prompt })
    }

    function createNodes() {
      return [
        makeAgent('researcher', 'You are a researcher. State one fact about the topic.'),
        makeAgent('analyst', 'You are an analyst. Add one supporting detail about the topic.'),
        makeAgent(
          'writer',
          'You are a writer. Write a polished one-sentence answer. Mention "Everest" if the topic is about mountains.'
        ),
      ]
    }

    const edges: EdgeDefinition[] = [
      {
        source: 'researcher',
        target: 'writer',
        handler: (state: MultiAgentState) => state.app.get('approved') === true,
      },
      ['analyst', 'writer'],
    ]

    // ── Run 1: no approval flag → writer blocked by handler despite all deps COMPLETED ──
    const graph1 = new Graph({
      id: graphId,
      nodes: createNodes(),
      edges,
      sessionManager: makeSessionManager(sessionId, tempDir),
    })

    const result1 = await graph1.invoke('What is the tallest mountain?')

    const completedRun1 = result1.results.filter((r) => r.status === Status.COMPLETED).map((r) => r.nodeId)
    expect(completedRun1).toContain('researcher')
    expect(completedRun1).toContain('analyst')
    // Writer should NOT have run — both deps are COMPLETED but the handler returned false
    expect(completedRun1).not.toContain('writer')

    // ── Run 2: set approval flag before resume so handler passes ──
    const graph2 = new Graph({
      id: graphId,
      nodes: createNodes(),
      edges,
      sessionManager: makeSessionManager(sessionId, tempDir),
    })

    // Initialize first so the session manager's restore hook is registered,
    // then add our hook — hooks run in registration order, so restore happens
    // before we set the flag.
    await graph2.initialize()
    graph2.addHook(BeforeMultiAgentInvocationEvent, (event) => {
      event.state.app.set('approved', true)
    })

    const result2 = await graph2.invoke('What is the tallest mountain?')

    const completedRun2 = result2.results.filter((r) => r.status === Status.COMPLETED).map((r) => r.nodeId)
    expect(completedRun2).toContain('writer')

    // Researcher and analyst should not be re-executed
    expect(completedRun2.filter((id) => id === 'researcher')).toHaveLength(1)
    expect(completedRun2.filter((id) => id === 'analyst')).toHaveLength(1)

    const writerText = result2.results
      .filter((r) => r.nodeId === 'writer' && r.status === Status.COMPLETED)
      .flatMap((r) => r.content)
      .find((b) => b.type === 'textBlock')?.text
    expect(writerText).toBeTruthy()
    expect(writerText).toMatch(/Everest|mountain|tallest/i)
  })
})
