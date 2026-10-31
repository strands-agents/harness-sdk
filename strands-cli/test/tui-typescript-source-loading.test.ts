import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { projectOptions } from '../src/tui/project/typescript.js'

const run = promisify(execFile)
const loaderUrl = new URL('../src/tui/project/typescript.ts', import.meta.url).href
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
const { createInteractiveChat } = await import(${JSON.stringify(new URL('../src/tui/runtime.ts', import.meta.url).href)})
const { CliConfigStore } = await import(${JSON.stringify(new URL('../src/tui/config.ts', import.meta.url).href)})
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
