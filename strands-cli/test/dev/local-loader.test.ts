import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { URL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { initializeDevWorkspace } from '../../src/dev/workspace.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const run = promisify(execFile)
const loader = new URL('../../src/project/typescript.ts', import.meta.url).href

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
  await initializeDevWorkspace(root, {
    version: 1,
    name: 'fixture',
    language: 'typescript',
    entrypoint: 'agent.ts',
    origin: { kind: 'cli' },
    harness: { path: 'harness', version: '0.3.4' },
  })
  return root
}

const loadName = async (root: string): Promise<string> => {
  const project = { root, entrypoint: join(root, 'agent.ts'), language: 'typescript' }
  const script = `const { loadTypescriptProject } = await import(${JSON.stringify(loader)}); const project = await loadTypescriptProject(${JSON.stringify(project)}); const agent = await project.createAgent(project.options); console.log(agent.name); await agent.shutdown();`
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
