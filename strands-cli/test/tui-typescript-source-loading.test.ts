import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { URL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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
  await symlink(resolve(import.meta.dirname, '../../node_modules'), join(root, 'node_modules'), 'junction')
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
    await rm(join(root, 'node_modules'), { recursive: true, force: true })
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
