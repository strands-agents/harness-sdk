import { execFile } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL } from 'node:url'
import { promisify } from 'node:util'
import { ImageBlock, Message } from '@strands-agents/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseArgs } from '../../src/cli/arguments.js'
import { CliConfigStore } from '../../src/config/store.js'
import { AgentMessaging } from '../../src/agent/messaging.js'
import { importAgentProject } from '../../src/project/import.js'
import { TypescriptBackend, type TypescriptInit } from '../../src/project/typescript-backend.js'
import { createTypescriptChat } from '../../src/ui/chat/runtime.js'

import { projectOptions } from '../../src/project/typescript.js'

const run = promisify(execFile)
const loaderUrl = new URL('../../src/project/typescript.ts', import.meta.url).href
const defaults = {
  model: 'bedrock/anthropic.claude-haiku-4-5-20251001-v1:0',
  effort: 'off',
  caching: false,
  builtinTools: [],
  builtinPlugins: [],
  memory: false,
  session: false,
  skills: false,
  contextManager: false,
  agentConfig: { backgroundTasks: false, printer: false },
}
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'strands-source-reload-'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function factorySource(name: string): string {
  return `import { createHarness } from '@strands-agents/harness'
import { value } from './value.js'

const authored = { ...${JSON.stringify(defaults)}, name: ${JSON.stringify(name)}, description: value }

export async function createAgent(overrides = {}) {
  return createHarness({ ...authored, ...overrides })
}

export const agent = await createAgent()
`
}

function project() {
  return { root, entrypoint: join(root, 'agent.ts'), language: 'typescript' as const }
}

async function loadAgents(overrides: Record<string, unknown>[]): Promise<{
  options: Record<string, unknown>
  agents: { name?: string; description?: string }[]
}> {
  const script = `
const { loadTypescriptProject } = await import(${JSON.stringify(loaderUrl)})
const loaded = await loadTypescriptProject(${JSON.stringify(project())})
const agents = []
for (const overrides of ${JSON.stringify(overrides)}) {
  const agent = await loaded.createAgent(overrides)
  agents.push({name: agent.name, description: agent.description})
}
console.log(JSON.stringify({options: loaded.options, agents}))
`
  const { stdout } = await run(
    process.execPath,
    ['--import', import.meta.resolve('tsx/esm'), '--input-type=module', '--eval', script],
    { cwd: root }
  )
  return JSON.parse(stdout) as {
    options: Record<string, unknown>
    agents: { name?: string; description?: string }[]
  }
}

describe('TypeScript source loading', () => {
  // Authored project options preserve HTTPS skill sources (#4574).
  it('preserves HTTPS skills while resolving authored project paths', () => {
    const url = 'https://example.com/SKILL.md'
    expect(projectOptions({ skills: url }, root).skills).toBe(url)
    expect(projectOptions({ skills: [url, './local-skills'] }, root).skills).toEqual([url, join(root, 'local-skills')])
  })

  it('captures an authored constructor helper without changing source', async () => {
    const source = `import { createHarness } from '@strands-agents/harness'
const build = async (overrides = {}) => createHarness({ ...${JSON.stringify(defaults)}, name: 'Authored', ...overrides })
export const agent = await build()
`
    await writeFile(join(root, 'agent.ts'), source)

    const loaded = await loadAgents([{}, { name: 'Changed' }])

    expect(loaded.agents[0]!.name).toBe('Authored')
    expect(loaded.options).toEqual({})
    expect(loaded.agents[1]!.name).toBe('Changed')
    expect(await readFile(join(root, 'agent.ts'), 'utf8')).toBe(source)
  })

  it('uses an authored factory for explicit reconstruction controls', async () => {
    await writeFile(join(root, 'value.ts'), "export const value = 'v1'\n")
    await writeFile(join(root, 'agent.ts'), factorySource('Original'))

    const loaded = await loadAgents([{}, { name: 'Override' }])

    expect(loaded.agents[0]!.name).toBe('Original')
    expect(loaded.agents[1]!.name).toBe('Override')
    expect(loaded.agents[1]!.description).toBe('v1')
  })

  it('reloads the complete project-local dependency graph', async () => {
    await writeFile(join(root, 'value.ts'), "export const value = 'v1'\n")
    await writeFile(join(root, 'agent.ts'), factorySource('Original'))
    const script = `
import { writeFile } from 'node:fs/promises'
const { loadTypescriptProject } = await import(${JSON.stringify(loaderUrl)})
const project = ${JSON.stringify(project())}
const firstLoad = await loadTypescriptProject(project)
const first = await firstLoad.createAgent({})
await writeFile(${JSON.stringify(join(root, 'value.ts'))}, "export const value = 'v2'\\n")
await writeFile(${JSON.stringify(join(root, 'agent.ts'))}, ${JSON.stringify(factorySource('Reloaded'))})
const secondLoad = await loadTypescriptProject(project)
const second = await secondLoad.createAgent({})
console.log(JSON.stringify({
  first: { name: first.name, description: first.description },
  second: { name: second.name, description: second.description },
}))
`
    const { stdout } = await run(
      process.execPath,
      ['--import', import.meta.resolve('tsx/esm'), '--input-type=module', '--eval', script],
      { cwd: root }
    )

    expect(JSON.parse(stdout)).toEqual({
      first: { name: 'Original', description: 'v1' },
      second: { name: 'Reloaded', description: 'v2' },
    })
  })

  it.each(['skills', 'plugins'])('keeps %s paired with the active authored agent across rebuilds', async (field) => {
    const source = (name: string, fail = false): string => `
import { createHarness } from '@strands-agents/harness'
import { AgentSkills, Skill } from '@strands-agents/sdk/vended-plugins/skills'
const skills = new AgentSkills({ skills: [new Skill({name: '${name}', description: '${name}', instructions: 'Review.'})] })
export const agent = await createHarness({ ...${JSON.stringify(defaults)}, ${field}: ${field === 'plugins' ? '[skills]' : 'skills'} })
${fail ? "throw new Error('Rejected rebuilt source')" : ''}
`
    await writeFile(project().entrypoint, source('first'))
    const script = `
import { writeFile } from 'node:fs/promises'
const { loadTypescriptProject } = await import(${JSON.stringify(loaderUrl)})
const { createInteractiveChat } = await import(${JSON.stringify(new URL('../../src/ui/chat/runtime.ts', import.meta.url).href)})
const { CliConfigStore } = await import(${JSON.stringify(new URL('../../src/config/store.ts', import.meta.url).href)})
const project = ${JSON.stringify(project())}
const loaded = await loadTypescriptProject(project)
const chat = await createInteractiveChat({
  cwd: project.root,
  project,
  agentOptions: loaded.options,
  buildAgent: loaded.createAgent,
  sessionRoot: project.root + '/catalog',
  config: CliConfigStore.memory({}, { mcpDiscovery: false, skillDiscovery: false, agentMessaging: false }),
})
const catalogs = []
try {
  await chat.submit('/skills')
  catalogs.push(chat.getSnapshot().panel.rows.map(row => row.label))
  await writeFile(project.entrypoint, ${JSON.stringify(source('second'))})
  await chat.backend.restartModel('bedrock/anthropic.claude-haiku-4-5-20251001-v1:0')
  await chat.submit('/skills')
  catalogs.push(chat.getSnapshot().panel.rows.map(row => row.label))
  await writeFile(project.entrypoint, ${JSON.stringify(source('failed', true))})
  let error
  try { await chat.backend.restartModel('bedrock/anthropic.claude-haiku-4-5-20251001-v1:0') }
  catch (failure) { error = failure.message }
  await chat.submit('/skills')
  catalogs.push(chat.getSnapshot().panel.rows.map(row => row.label))
  console.log(JSON.stringify({ catalogs, error }))
} finally { await chat.dispose() }
`
    const { stdout } = await run(
      process.execPath,
      ['--import', import.meta.resolve('tsx/esm'), '--input-type=module', '--eval', script],
      { cwd: root }
    )
    expect(JSON.parse(stdout)).toEqual({
      catalogs: [['first'], ['second'], ['second']],
      error: 'Rejected rebuilt source',
    })
  })

  it.each([
    { phase: 'evaluation', cleanupFails: false },
    { phase: 'initialization', cleanupFails: false },
    { phase: 'initialization', cleanupFails: true },
    { phase: 'replacement initialization', cleanupFails: false },
  ])(
    'flushes unpublished agents after $phase failure (cleanupFails=$cleanupFails)',
    async ({ phase, cleanupFails }) => {
      const source = `
import { createHarness } from '@strands-agents/harness'
import { Model, MemoryManager, IntervalTrigger } from '@strands-agents/sdk'
class LocalModel extends Model {
  getConfig() { return { modelId: 'fixture' } }
  updateConfig() {}
  async *stream() {
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    yield { type: 'modelContentBlockStartEvent' }
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'startup reply' } }
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
  }
}
const failure = new Error('Authored startup failed')
const observed = globalThis.__sourceCleanup = { failure, records: [] }
async function build() {
  const record = { saved: [], cancels: 0, flushes: 0 }
  const memory = new MemoryManager({ injection: false, searchToolConfig: false, stores: [{
    name: 'buffered', writable: true, extraction: { trigger: new IntervalTrigger({ turns: 100 }) },
    async search() { return [] },
    async addMessages(messages) { record.saved.push(...messages) },
  }] })
  const candidate = await createHarness({
    ...${JSON.stringify(defaults)}, model: new LocalModel(), memory, printer: false, backgroundTasks: false,
  })
  await candidate.invoke('startup request')
  const cancel = candidate.cancel.bind(candidate)
  const flush = memory.flush.bind(memory)
  candidate.cancel = () => {
    record.cancels++
    if (${cleanupFails}) throw new Error('Cancel failed')
    cancel()
  }
  memory.flush = async () => {
    record.flushes++
    await flush()
    if (${cleanupFails}) throw new Error('Flush failed')
  }
  observed.records.push(record)
  return candidate
}
export let agent = await build()
${phase === 'replacement initialization' ? 'agent = await build()' : ''}
${phase === 'evaluation' ? 'throw failure' : 'agent.initialize = async () => { throw failure }'}
`
      await writeFile(project().entrypoint, source)
      const script = `
const { loadTypescriptProject } = await import(${JSON.stringify(loaderUrl)})
const loaded = await loadTypescriptProject(${JSON.stringify(project())})
let failure
try { await loaded.createAgent(loaded.options) } catch (error) { failure = error }
const observed = globalThis.__sourceCleanup
console.log(JSON.stringify({
  originalError: failure === observed.failure,
  records: observed.records.map(record => ({
    cancels: record.cancels,
    flushes: record.flushes,
    messages: record.saved.map(message => ({ role: message.role, text: message.content[0].text })),
  })),
}))
`
      const { stdout } = await run(
        process.execPath,
        ['--import', import.meta.resolve('tsx/esm'), '--input-type=module', '--eval', script],
        { cwd: root }
      )
      expect(JSON.parse(stdout)).toEqual({
        originalError: true,
        records: Array.from({ length: phase === 'replacement initialization' ? 2 : 1 }, () => ({
          cancels: 1,
          flushes: 1,
          messages: [
            { role: 'user', text: 'startup request' },
            { role: 'assistant', text: 'startup reply' },
          ],
        })),
      })
    }
  )

  it('keeps entrypoints in the same project independently reloadable', async () => {
    for (const name of ['first', 'second']) {
      await writeFile(
        join(root, `${name}.ts`),
        `import { createHarness } from '@strands-agents/harness'
export const agent = await createHarness({ ...${JSON.stringify(defaults)}, name: '${name}' })
`
      )
    }
    const script = `
const { loadTypescriptProject } = await import(${JSON.stringify(loaderUrl)})
const names = []
for (const name of ['first', 'second', 'first']) {
  const loaded = await loadTypescriptProject({
    ...${JSON.stringify(project())},
    entrypoint: ${JSON.stringify(root)} + '/' + name + '.ts',
  })
  names.push((await loaded.createAgent({})).name)
}
console.log(JSON.stringify(names))
`
    const { stdout } = await run(
      process.execPath,
      ['--import', import.meta.resolve('tsx/esm'), '--input-type=module', '--eval', script],
      { cwd: root }
    )

    expect(JSON.parse(stdout)).toEqual(['first', 'second', 'first'])
  })

  it('supports an imported factory while construction remains in the entrypoint', async () => {
    await mkdir(join(root, 'definition'))
    await writeFile(join(root, 'value.ts'), "export const value = 're-exported'\n")
    await writeFile(
      join(root, 'definition/index.ts'),
      factorySource('Re-exported').replace("'./value.js'", "'../value.js'")
    )
    await writeFile(
      join(root, 'agent.ts'),
      "import { createAgent } from './definition/index.js'\nexport { createAgent }\nexport const agent = await createAgent()\n"
    )

    const loaded = await loadAgents([{}, { name: 'Rebuilt' }])

    expect(loaded.agents[0]!.name).toBe('Re-exported')
    expect(loaded.agents[1]!.name).toBe('Rebuilt')
  })

  it('uses the host harness without changing source', async () => {
    const packageRoot = join(root, 'node_modules/@strands-agents/harness')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(
      join(packageRoot, 'package.json'),
      '{"name":"@strands-agents/harness","type":"module","exports":"./index.js"}'
    )
    await writeFile(
      join(packageRoot, 'index.js'),
      "export async function createHarness() { return { marker: 'PROJECT_FACTORY', initialize: async () => {}, async *stream() {} } }\n"
    )
    const entrypoint = project().entrypoint
    await writeFile(
      entrypoint,
      `import { createHarness } from '@strands-agents/harness'
export const agent = await createHarness({ ...${JSON.stringify(defaults)}, name: 'Host harness' })
`
    )
    const authored = await readFile(entrypoint)

    const loaded = await loadAgents([{}])

    expect(loaded.agents[0]!.name).toBe('Host harness')
    expect(await readFile(entrypoint)).toEqual(authored)
  })
})

describe('TypeScript process runtime', () => {
  const backends: TypescriptBackend[] = []

  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.dispose()))
  })

  function source(gate?: string, session = false): string {
    return `
import { appendFileSync } from 'node:fs'
import { createHarness } from '@strands-agents/harness'
import { Model } from '@strands-agents/sdk'
import { value } from './value.js'
appendFileSync(${JSON.stringify(join(root, 'pids'))}, String(process.pid) + String.fromCharCode(10))
console.log('authored stdout is not the protocol')
class LocalModel extends Model {
  getConfig() { return { modelId: ${JSON.stringify(defaults.model.slice('bedrock/'.length))}, contextWindowLimit: 10000 } }
  updateConfig() {}
  async *stream(messages, options) {
    const text = messages.filter(message => message.role === 'user')
      .flatMap(message => message.content.filter(block => block.type === 'textBlock').map(block => block.text)).join('|')
    if (${JSON.stringify(gate ?? '')} && text.startsWith('blocked') && !text.includes('redirect')) {
      await fetch(${JSON.stringify(gate ?? '')}, { signal: options?.cancelSignal })
    }
    if (${session} && text.startsWith('primary history')) await agent.contextManager.stash.loadSnapshot({ fixture: { marker: 'from primary' } })
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    yield { type: 'modelContentBlockStartEvent' }
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'PID=' + process.pid + ';' + value + ';' + text } }
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
  }
}
export const agent = await createHarness({ ...${JSON.stringify(defaults)}, name: 'Process fixture', description: value, contextManager: ${JSON.stringify(session ? 'auto' : false)}, session: ${JSON.stringify(session ? { dir: join(root, 'sessions') } : false)} })
agent.model = new LocalModel()
`
  }

  async function open(overrides: Partial<Omit<TypescriptInit, 'config'>> = {}): Promise<TypescriptBackend> {
    const config = CliConfigStore.memory({}, { mcpDiscovery: false, skillDiscovery: false, agentMessaging: false })
    const { backend } = await TypescriptBackend.open(
      {
        project: importAgentProject(project().entrypoint),
        args: parseArgs([]),
        cwd: root,
        initialWorkspace: root,
        peerEndpointId: 'agent-1',
        mcpPaths: [],
        mcpStrictPaths: [],
        ...overrides,
      },
      config,
      new AgentMessaging(),
      AbortSignal.timeout(15000)
    )
    backends.push(backend)
    return backend
  }

  async function pids(): Promise<number[]> {
    return (await readFile(join(root, 'pids'), 'utf8')).trim().split('\n').map(Number)
  }

  async function stopped(pid: number): Promise<void> {
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2000 })
  }

  async function answer(backend: TypescriptBackend, prompt: string): Promise<string> {
    let text = ''
    for await (const event of backend.stream(prompt)) {
      if (event.type === 'textDelta') text += event.text
    }
    return text
  }

  it('replaces complete source generations and preserves binary messages without loading them in the parent', async () => {
    await writeFile(join(root, 'value.ts'), "export const value = 'v0'\n")
    const authored = source()
    await writeFile(project().entrypoint, authored)
    const bytes = new Uint8Array(1024 * 1024).fill(91)
    const message = new Message({ role: 'user', content: [new ImageBlock({ format: 'png', source: { bytes } })] })
    const backend = await open({ seed: { model: defaults.model, thinking: 'off', messages: [message.toJSON()] } })
    let previous = (await pids()).at(-1)!
    expect(previous).not.toBe(process.pid)
    for (let generation = 1; generation <= 5; generation++) {
      await writeFile(join(root, 'value.ts'), `export const value = 'v${generation}'\n`)
      await backend.restartModel(defaults.model)
      await stopped(previous)
      const observed = await pids()
      previous = observed.at(-1)!
      expect(new Set(observed).size).toBe(generation + 1)
      expect(backend.info().description).toBe(`v${generation}`)
      expect((await backend.captureFork()).messages).toEqual([message.toJSON()])
    }
    expect(await readFile(project().entrypoint, 'utf8')).toBe(authored)
    await backend.dispose()
    await stopped(previous)
  }, 30000)

  it('keeps the old process usable after a replacement evaluates and fails', async () => {
    await writeFile(join(root, 'value.ts'), "export const value = 'original'\n")
    const authored = source()
    await writeFile(project().entrypoint, authored)
    const backend = await open()
    const original = (await pids())[0]!
    expect(await answer(backend, 'first')).toContain(`PID=${original};original;first`)
    await writeFile(join(root, 'value.ts'), "export const value = 'rejected'\n")
    await writeFile(project().entrypoint, authored + "\nthrow new Error('replacement rejected')\n")
    await expect(backend.restartModel(defaults.model)).rejects.toThrow('replacement rejected')
    const failed = (await pids()).at(-1)!
    expect(failed).not.toBe(original)
    await stopped(failed)
    expect(() => process.kill(original, 0)).not.toThrow()
    expect(backend.info().description).toBe('original')
    expect(await answer(backend, 'second')).toContain(`PID=${original};original;first|second`)
  }, 15000)

  it.each(['idle', 'blocked'] as const)(
    'flushes buffered memory before %s child disposal completes',
    async (state) => {
      const flushed = join(root, 'flushed.json')
      const blocked = join(root, 'blocked')
      await writeFile(
        project().entrypoint,
        `
import { writeFileSync } from 'node:fs'
import { createHarness } from '@strands-agents/harness'
import { Model, MemoryManager, IntervalTrigger } from '@strands-agents/sdk'
writeFileSync(${JSON.stringify(join(root, 'pids'))}, String(process.pid))
class LocalModel extends Model {
  getConfig() { return { modelId: ${JSON.stringify(defaults.model.slice('bedrock/'.length))}, contextWindowLimit: 10000 } }
  updateConfig() {}
  async *stream(messages) {
    if (messages.some(message => message.content.some(block => block.text === 'blocked'))) {
      writeFileSync(${JSON.stringify(blocked)}, 'started')
      await new Promise(() => {})
    }
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    yield { type: 'modelContentBlockStartEvent' }
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'startup reply' } }
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
  }
}
const memory = new MemoryManager({ injection: false, searchToolConfig: false, stores: [{
  name: 'buffered', writable: true, extraction: { trigger: new IntervalTrigger({ turns: 100 }) },
  async search() { return [] },
  async addMessages(messages) {
    await new Promise(resolve => setTimeout(resolve, 1800))
    writeFileSync(${JSON.stringify(flushed)}, JSON.stringify(messages.map(message => ({
      role: message.role, text: message.content[0].text
    }))))
  }
}] })
export const agent = await createHarness({ ...${JSON.stringify(defaults)}, model: new LocalModel(), memory })
await agent.invoke('startup request')
`
      )
      const backend = await open()
      const pid = (await pids())[0]!
      let running: Promise<unknown> | undefined
      if (state === 'blocked') {
        running = answer(backend, 'blocked').catch((error: unknown) => error)
        await vi.waitFor(async () => expect(await readFile(blocked, 'utf8')).toBe('started'))
      }
      await backend.dispose()
      await running
      expect(JSON.parse(await readFile(flushed, 'utf8'))).toEqual([
        { role: 'user', text: 'startup request' },
        { role: 'assistant', text: 'startup reply' },
        ...(state === 'blocked' ? [{ role: 'user', text: 'blocked' }] : []),
      ])
      await stopped(pid)
    },
    15000
  )

  it('forks, resumes and reloads a real process roster with session provenance', async () => {
    await writeFile(join(root, 'value.ts'), "export const value = 'roster'\n")
    await writeFile(project().entrypoint, source(undefined, true))
    const saved = await open()
    await answer(saved, 'target only')
    const savedSession = saved.sessionId!
    await saved.dispose()
    const config = CliConfigStore.memory({}, { mcpDiscovery: false, skillDiscovery: false, agentMessaging: false })
    const options = { args: parseArgs([]), cwd: root, initialWorkspace: root, mcpPaths: [], mcpStrictPaths: [] }
    const setup = vi.fn()
    const first = await createTypescriptChat(project().entrypoint, config, options, AbortSignal.timeout(30000), setup)
    let reloaded: Awaited<ReturnType<typeof createTypescriptChat>> | undefined
    try {
      const primary = first.backend as TypescriptBackend
      await first.submit('primary history')
      expect(first.getSnapshot().completedTurns.at(-1)?.status).toBe('complete')
      const primarySeed = await primary.captureFork()
      expect(primarySeed.stash).toMatchObject({ fixture: { marker: 'from primary' } })
      await first.submit('/fork')
      const fork = first.backend as TypescriptBackend
      expect(fork).not.toBe(primary)
      expect(fork.sessionId).not.toBe(primary.sessionId)
      expect(await fork.captureFork()).toMatchObject({ messages: primarySeed.messages, stash: primarySeed.stash })
      expect(fork.modelSelection()).toEqual(primary.modelSelection())
      await first.submit('fork history')
      await first.submit('/sessions')
      const row = first.getSnapshot().panel?.rows.find((candidate) => candidate.label === savedSession)
      expect(row).toBeDefined()
      expect(await first.activatePanelRow(row!)).toBe(true)
      const resumed = first.backend as TypescriptBackend
      expect(resumed.sessionId).toBe(savedSession)
      const resumedMessages = JSON.stringify((await resumed.captureFork()).messages)
      expect(resumedMessages).toContain('target only')
      expect(resumedMessages).not.toContain('fork history')
      expect(resumed.modelSelection()).toEqual(fork.modelSelection())
      const captured = await first.captureConversations()
      expect(captured.entries).toHaveLength(3)
      const oldPids = (await pids()).slice(1)
      await writeFile(join(root, 'value.ts'), "export const value = 'reloaded'\n")
      reloaded = await createTypescriptChat(
        project().entrypoint,
        config,
        options,
        AbortSignal.timeout(30000),
        setup,
        captured
      )
      const restored = await reloaded.captureConversations()
      expect(restored.activeId).toBe(captured.activeId)
      expect(
        restored.entries.map(({ id, title, conversation }) => ({
          id,
          title,
          session: conversation.session,
          selection: conversation.sourceSelection,
        }))
      ).toEqual(
        captured.entries.map(({ id, title, conversation }) => ({
          id,
          title,
          session: conversation.session,
          selection: conversation.sourceSelection,
        }))
      )
      expect(reloaded.backend.info?.().description).toBe('reloaded')
      await first.dispose()
      await Promise.all(oldPids.map(stopped))
      await reloaded.submit('after reload')
      expect(reloaded.getSnapshot().completedTurns.at(-1)?.status).toBe('complete')
    } finally {
      await Promise.all([first.dispose(), reloaded?.dispose()])
    }
  }, 30000)

  it.each(['cancel', 'dispose'] as const)(
    'stops a pending replacement before its first model invocation on %s',
    async (ending) => {
      let reached!: () => void
      const requested = new Promise<void>((resolve) => {
        reached = resolve
      })
      const server = createServer(() => reached())
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected local server address')
      let backend: TypescriptBackend | undefined
      try {
        await writeFile(join(root, 'value.ts'), "export const value = 'replacement'\n")
        const authored = source()
        await writeFile(project().entrypoint, authored)
        backend = await open()
        const original = (await pids())[0]!
        await writeFile(
          project().entrypoint,
          authored.replace('export const agent', `await fetch('http://127.0.0.1:${address.port}');\nexport const agent`)
        )
        await backend.setEffort('high')
        const pending = answer(backend, 'must not invoke').catch((error: unknown) => error)
        await Promise.race([
          requested,
          pending.then((result) => {
            throw new Error(`Replacement did not reach gate: ${String(result)}`)
          }),
        ])
        const candidate = (await pids()).at(-1)!
        expect(candidate).not.toBe(original)
        if (ending === 'cancel') backend.cancel()
        else await backend.dispose()
        expect(await pending).toBeInstanceOf(Error)
        await stopped(candidate)
        if (ending === 'cancel') {
          expect(() => process.kill(original, 0)).not.toThrow()
          expect(JSON.stringify((await backend.captureFork()).messages)).not.toContain('must not invoke')
        } else await stopped(original)
      } finally {
        await backend?.dispose()
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      }
    },
    15000
  )

  it.each(['consumed', 'drained', 'disposed'] as const)(
    'settles real steering and pending stream work when %s',
    async (ending) => {
      let reached!: (response: ServerResponse) => void
      const requested = new Promise<ServerResponse>((resolve) => {
        reached = resolve
      })
      const server = createServer((_request, response) => reached(response))
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected local server address')
      let backend: TypescriptBackend | undefined
      try {
        await writeFile(join(root, 'value.ts'), "export const value = 'steering'\n")
        await writeFile(project().entrypoint, source(`http://127.0.0.1:${address.port}`))
        backend = await open()
        const pid = (await pids())[0]!
        const running = answer(backend, 'blocked').catch((error: unknown) => error)
        const response = await Promise.race([
          requested,
          running.then((result) => {
            throw new Error(`Model did not reach gate: ${String(result)}`)
          }),
        ])
        const consumed = vi.fn()
        expect(backend.queueSteering('redirect', consumed)).toBe(true)
        if (ending === 'consumed') {
          response.end('ready')
          await running
          expect(consumed).toHaveBeenCalledOnce()
          expect(await backend.drainSteering()).toEqual([])
        } else if (ending === 'drained') {
          expect(await backend.drainSteering()).toEqual(['redirect'])
          backend.cancel()
          response.end('ready')
          await running
          expect(consumed).not.toHaveBeenCalled()
          expect(await backend.drainSteering()).toEqual([])
          expect(await answer(backend, 'redirect')).toContain('redirect')
        } else {
          await backend.dispose()
          await running
          await stopped(pid)
          expect(consumed).not.toHaveBeenCalled()
        }
      } finally {
        await backend?.dispose()
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      }
    },
    15000
  )
})
