import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HarnessAgentOptions } from '@strands-agents/harness'
import { MemoryManager, SessionManager } from '@strands-agents/sdk'
import { InMemoryStorage } from '@strands-agents/sdk/storage'
import { TestMemoryStore } from '@strands-agents/sdk/vended-memory-stores/test-memory-store'
import { CliConfigStore } from '../../src/config/store.js'
import { devStateNotice, isolateDevState, projectPreparedByParent } from '../../src/dev/runtime.js'
import { PythonBackend } from '../../src/project/python.js'
import { pythonEnvironment, pythonExecutable } from '../fixtures/python-runtime.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const sessionManager = (): SessionManager => new SessionManager({ sessionId: 'own' })
const memoryStore = (): TestMemoryStore =>
  new TestMemoryStore({ name: 'own', path: '/agent/memory.json', extraction: false })
const memoryManager = (): MemoryManager => new MemoryManager({ stores: [memoryStore()] })

describe('isolateDevState', () => {
  it('shouldUseWorkspaceStorageWhenSourceUsesOtherPaths', () => {
    const options = {
      name: 'local',
      model: 'model',
      instructions: 'keep',
      session: { dir: '/old/sessions' },
      memory: { dir: '/old/memory' },
    }

    const isolated = isolateDevState(options, '/workspace')

    expect(isolated).toEqual({
      options: {
        ...options,
        session: { dir: join('/workspace', '.strands/state/sessions') },
        memory: { dir: join('/workspace', '.strands/state/memory') },
      },
      turnedOff: [],
    })
    expect(options.session.dir).toBe('/old/sessions')
  })

  it.each([false, null])('shouldKeepStateDisabledWhenTheSourceSetsIt %s', (value) => {
    expect(isolateDevState({ session: value, memory: value }, '/workspace')).toEqual({
      options: { session: false, memory: false },
      turnedOff: [],
    })
  })

  it.each<[string, HarnessAgentOptions, string]>([
    ['sessionManager', { sessionManager: sessionManager() }, 'session'],
    ['a SessionManager as session', { session: sessionManager() }, 'session'],
    ['memoryManager', { memoryManager: memoryManager() }, 'memory'],
    ['a MemoryManager as memory', { memory: memoryManager() }, 'memory'],
    ['memory stores', { memory: { stores: [memoryStore()] } }, 'memory'],
  ])('shouldTurnOffTheCustomStateWhenTheSourceSets %s', (_case, options, manager) => {
    const isolated = isolateDevState(options, '/workspace')

    expect(isolated.turnedOff).toEqual([manager])
    expect(isolated.options[manager as 'session' | 'memory']).toBe(false)
    expect(isolated.options.sessionManager).toBeUndefined()
    expect(isolated.options.memoryManager).toBeUndefined()
  })

  it('shouldClearTheCustomStorageWhileTheSessionMovesToTheWorkspace', () => {
    const isolated = isolateDevState({ storage: new InMemoryStorage() }, '/workspace')

    expect(isolated.turnedOff).toEqual(['storage'])
    expect(isolated.options).toHaveProperty('storage', undefined)
    expect(isolated.options.session).toEqual({ dir: join('/workspace', '.strands/state/sessions') })
  })

  it('shouldKeepTheClearedManagersAsKeysSoThatTheyOverrideTheAuthoredOptions', () => {
    const isolated = isolateDevState({ sessionManager: sessionManager(), memoryManager: memoryManager() }, '/workspace')

    expect(isolated.options).toHaveProperty('sessionManager', undefined)
    expect(isolated.options).toHaveProperty('memoryManager', undefined)
    expect(isolated.turnedOff).toEqual(['session', 'memory'])
  })
})

describe('devStateNotice', () => {
  it.each<[readonly ('session' | 'memory' | 'storage')[], string | undefined]>([
    [[], undefined],
    [
      ['storage'],
      'Dev deactivated the custom storage of this agent in this chat. Thus the chat cannot write into the stores of the agent.',
    ],
    [
      ['session', 'memory', 'storage'],
      'Dev deactivated the custom session manager, memory, and storage of this agent in this chat. Thus the chat cannot write into the stores of the agent. Dev does not save this chat.',
    ],
  ])('shouldDescribeWhatDevTurnedOffWhenTheListIs %j', (turnedOff, notice) => {
    expect(devStateNotice(turnedOff)).toBe(notice)
  })
})

describe('a strands dev that another strands dev started', () => {
  it.each<[NodeJS.ProcessEnv, boolean]>([
    [{ STRANDS_DEV_PROJECT_PREPARED: '1' }, true],
    [{ STRANDS_DEV_PROJECT_PREPARED: '0' }, false],
    [{ STRANDS_DEV_PROJECT_PREPARED: '' }, false],
    [{}, false],
  ])('shouldTakeTheProjectAsPreparedOnlyWhenItsParentSaysSo %j', (environment, prepared) => {
    expect(projectPreparedByParent(environment)).toBe(prepared)
  })
})

const active: PythonBackend[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((backend) => backend.dispose()))
  vi.unstubAllEnvs()
})

const fixture = async (state: boolean): Promise<{ root: string; source: string }> => {
  const root = await temporaryDirectory()
  await symlink(pythonEnvironment, join(root, '.venv'), 'junction')
  await mkdir(join(root, 'private'))
  await writeFile(join(root, 'private', 'keep.txt'), 'original state')
  await copyFile(new URL('../fixtures/source-reload-model.py', import.meta.url), join(root, 'source_reload_model.py'))
  const source = `from strands_harness import create_harness
from source_reload_model import SourceReloadModel
agent = create_harness(name="Workspace Python", model=SourceReloadModel(), builtin_tools=[], builtin_plugins=[], skills=False, memory=False, session=${state ? '{"dir": "private"}' : 'False'}, context_manager=False, background_tasks=False)
`
  await writeFile(join(root, 'agent.py'), source)
  return { root, source }
}

describe.skipIf(!existsSync(pythonExecutable))('Python dev isolation', () => {
  it.each([true, false])(
    'shouldKeepStateInTheWorkspaceWhenSessionsAre%s',
    async (state) => {
      const { root, source } = await fixture(state)
      vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true')
      vi.stubEnv('PYTHONDONTWRITEBYTECODE', '1')

      const backend = await PythonBackend.open(
        { root, entrypoint: join(root, 'agent.py'), language: 'python' },
        CliConfigStore.memory(),
        { cwd: root, devWorkspace: root },
        AbortSignal.timeout(20_000)
      )
      active.push(backend)

      expect(backend.name).toBe('Workspace Python')
      expect(backend.info().tools ?? []).toEqual([])
      if (state) expect(backend.sessionDirectory).toContain(join(root, '.strands', 'state', 'sessions'))
      else expect(backend.sessionIdentity).toBeUndefined()
      expect(await readFile(join(root, 'agent.py'), 'utf8')).toBe(source)
      expect(await readFile(join(root, 'private', 'keep.txt'), 'utf8')).toBe('original state')
    },
    25_000
  )
})

const run = promisify(execFile)
const loader = new URL('../../src/project/typescript.ts', import.meta.url).href

/** The workspace config that makes the loader use the harness library in `harness/`. */
const declareHarness = async (root: string, version: string): Promise<void> => {
  await mkdir(join(root, '.strands'), { recursive: true })
  await writeFile(
    join(root, '.strands/config.json'),
    JSON.stringify({
      version: 1,
      name: 'fixture',
      language: 'typescript',
      entrypoint: 'agent.ts',
      origin: { kind: 'cli' },
      harness: { path: 'harness', version },
    })
  )
}

const createFixture = async (): Promise<string> => {
  const root = await temporaryDirectory()
  await mkdir(join(root, 'harness/src'), { recursive: true })
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(
    join(root, 'harness/package.json'),
    '{"name":"@strands-agents/harness","version":"0.3.4","type":"module"}'
  )
  await writeFile(join(root, 'harness/src/internal.ts'), 'export const label = "local-copy"\n')
  await writeFile(
    join(root, 'harness/src/index.ts'),
    `import { Agent } from '@strands-agents/sdk'
import { label } from '@strands-agents/harness/internal'
export const createHarness = async (options = {}) => new Agent({ ...options, name: label, printer: false })
`
  )
  await writeFile(
    join(root, 'agent.ts'),
    `import { createHarness } from '@strands-agents/harness'
export const agent = await createHarness({ model: 'unused' })
`
  )
  await declareHarness(root, '0.3.4')
  return root
}

const loadName = async (root: string): Promise<string> => {
  const project = { root, entrypoint: join(root, 'agent.ts'), language: 'typescript' }
  const script = `const { loadTypescriptProject } = await import(${JSON.stringify(loader)}); const project = await loadTypescriptProject(${JSON.stringify(project)}, undefined, { devWorkspace: true }); const agent = await project.createAgent(project.options); console.log(agent.name); await agent.shutdown();`
  const result = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    timeout: 30_000,
  })
  return result.stdout.trim()
}

describe('workspace harness loading', () => {
  it('shouldExecuteTheLocalFactoryWhenTheWorkspaceDeclaresItsLibrary', async () => {
    const root = await createFixture()

    expect(await loadName(root)).toBe('local-copy')

    await writeFile(join(root, 'harness/src/internal.ts'), 'export const label = "edited-copy"\n')
    expect(await loadName(root)).toBe('edited-copy')
  })

  it('shouldFailInsteadOfUsingTheInstalledFactoryWhenLocalSourceIsMissing', async () => {
    const root = await createFixture()
    await writeFile(
      join(root, 'harness/src/index.ts'),
      "export const createHarness = () => { throw new Error('local source failure') }\n"
    )

    await expect(loadName(root)).rejects.toThrow('local source failure')
  })

  it('shouldRejectAVersionMismatchWhenWorkspaceMetadataDiffers', async () => {
    const root = await createFixture()
    const manifest = JSON.parse(await readFile(join(root, 'harness/package.json'), 'utf8'))
    await writeFile(join(root, 'harness/package.json'), JSON.stringify({ ...manifest, version: '0.2.0' }))

    await expect(loadName(root)).rejects.toThrow('version does not match')
  })
})

const hostRequire = createRequire(import.meta.url)
const harnessRoot = dirname(dirname(dirname(hostRequire.resolve('@strands-agents/harness'))))
const sdkRoot = dirname(dirname(dirname(hostRequire.resolve('@strands-agents/sdk'))))

const createWorkspace = async (extension: 'mjs' | 'cjs'): Promise<string> => {
  const root = await temporaryDirectory()
  await mkdir(join(root, 'harness/src'), { recursive: true })
  await mkdir(join(root, 'models'), { recursive: true })
  await cp(sdkRoot, join(root, 'node_modules/@strands-agents/sdk'), { recursive: true })
  await cp(join(harnessRoot, 'dist'), join(root, 'harness/dist'), { recursive: true })
  const manifest = JSON.parse(await readFile(join(harnessRoot, 'package.json'), 'utf8'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(
    join(root, 'harness/package.json'),
    JSON.stringify({ ...manifest, exports: { '.': './src/index.ts', './internal': './src/internal.ts' } })
  )
  await writeFile(join(root, 'harness/src/index.ts'), "export * from '../dist/src/index.js'\n")
  await writeFile(join(root, 'harness/src/internal.ts'), "export * from '../dist/src/internal.js'\n")
  const construction = `class CustomModel extends Model {
  getConfig() { return { modelId: 'custom-local-model', contextWindowLimit: 10000 } }
  updateConfig() {}
  async *stream() {
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    yield { type: 'modelContentBlockStartEvent' }
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'CUSTOM_MODEL_OK' } }
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
    yield { type: 'modelMetadataEvent', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, metrics: { latencyMs: 1 } }
  }
}
`
  await writeFile(
    join(root, `models/model.${extension}`),
    extension === 'mjs'
      ? `import { Model } from '@strands-agents/sdk'\n${construction}export const model = new CustomModel()\n`
      : `const { Model } = require('@strands-agents/sdk')\n${construction}exports.model = new CustomModel()\n`
  )
  await writeFile(
    join(root, 'agent.ts'),
    `import { fileURLToPath } from 'node:url'
import { createHarness, defineHarnessAgentConfig, harnessAgentOptionsFromConfig } from '@strands-agents/harness'
const options = await harnessAgentOptionsFromConfig(defineHarnessAgentConfig({ modelModule: { kind: 'model', module: './models/model.${extension}', export: 'model' }, memory: false, session: false, skills: false, builtinTools: [], builtinPlugins: [], contextManager: false, agentConfig: { printer: false, backgroundTasks: false } }), fileURLToPath(new URL('.', import.meta.url)))
export const agent = await createHarness(options)
`
  )
  await declareHarness(root, manifest.version)
  return root
}

const runWorkspace = async (
  root: string
): Promise<{ modelIsCanonical: boolean; modelId: string; response: string }> => {
  const project = { root, entrypoint: join(root, 'agent.ts'), language: 'typescript' }
  const script = `import { Model } from '@strands-agents/sdk'
const { loadTypescriptProject } = await import(${JSON.stringify(loader)})
const loaded = await loadTypescriptProject(${JSON.stringify(project)})
const modelIsCanonical = loaded.options.model instanceof Model
const agent = await loaded.createAgent(loaded.options)
let response = ''
try {
  for await (const event of agent.stream('hello')) {
    if (event.type === 'modelStreamUpdateEvent' && event.event.type === 'modelContentBlockDeltaEvent' && event.event.delta.type === 'textDelta') response += event.event.delta.text
  }
  console.log(JSON.stringify({ modelIsCanonical, modelId: agent.model.getConfig().modelId, response }))
} finally { await agent.shutdown() }
`
  const result = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: { ...process.env, AWS_EC2_METADATA_DISABLED: 'true' },
    timeout: 30000,
  })
  return JSON.parse(result.stdout.trim())
}

describe('dev model identity', () => {
  it.each(['mjs', 'cjs'] as const)(
    'shouldUseTheHostModelClassWhenTheLocalHarnessLoadsA%sModel',
    async (extension) => {
      const root = await createWorkspace(extension)

      const result = await runWorkspace(root)

      expect(result).toEqual({ modelIsCanonical: true, modelId: 'custom-local-model', response: 'CUSTOM_MODEL_OK' })
    },
    30000
  )
})
