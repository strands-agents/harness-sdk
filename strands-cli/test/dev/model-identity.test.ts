import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import { initializeDevWorkspace } from '../../src/dev/workspace.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const run = promisify(execFile)
const hostRequire = createRequire(import.meta.url)
const loader = new URL('../../src/project/typescript.ts', import.meta.url).href
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
  await initializeDevWorkspace(root, {
    version: 1,
    name: 'Custom model',
    language: 'typescript',
    entrypoint: 'agent.ts',
    origin: { kind: 'cli' },
    harness: { path: 'harness', version: manifest.version },
  })
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
