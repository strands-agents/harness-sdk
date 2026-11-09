import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseArgs } from '../../src/cli/arguments.js'
import { CliConfigStore } from '../../src/config/store.js'
import { bindWorkspace } from '../../src/dev/binding.js'
import { bindExistingAgent } from '../../src/dev/create.js'
import * as picker from '../../src/dev/picker.js'
import { prepareDevRun } from '../../src/dev/prepare.js'
import * as discovery from '../../src/dev/search.js'
import { readDevWorkspace } from '../../src/dev/workspace.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const project = async (): Promise<string> => {
  const root = await temporaryDirectory()
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(
    join(root, 'agent.ts'),
    "import { createHarness } from '@strands-agents/harness'\nexport const agent = await createHarness({ name: 'My agent' })\n"
  )
  return root
}

afterEach(() => vi.restoreAllMocks())

describe('workspace opening', () => {
  it('shouldBindAFoundTypeScriptAgentWhenItsProjectHasUnrelatedConfig', async () => {
    const root = await project()
    await mkdir(join(root, '.strands'))
    const original = JSON.stringify({ agent: 'agent.ts', model: 'custom-model' })
    const path = join(root, '.strands/config.json')
    await writeFile(path, original)

    const found = await discovery.discoverHarnesses([root])
    const workspace = await bindExistingAgent(join(root, 'strands-dev'), found.harnesses[0]!.entrypoint)

    expect(found.warnings).toEqual([])
    expect(workspace.entrypoint).toBe(join(root, 'agent.ts'))
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it.each(['explicit', 'launch-directory', 'child-directory'] as const)(
    'shouldSkipSelectionWhenAValidBindingExistsAt%s',
    async (location) => {
      const root = await project()
      const launch = await temporaryDirectory()
      const directory = location === 'child-directory' ? join(launch, 'strands-dev') : launch
      await mkdir(directory, { recursive: true })
      await bindWorkspace(directory, {
        version: 1,
        name: 'Configured agent',
        agent: { path: root, entrypoint: 'agent.ts', language: 'typescript' },
        origin: { kind: 'discovered' },
      })
      vi.spyOn(process, 'cwd').mockReturnValue(launch)
      vi.spyOn(CliConfigStore, 'load').mockResolvedValue(CliConfigStore.memory())
      vi.spyOn(process.stderr, 'write').mockReturnValue(true)
      const scan = vi.spyOn(discovery, 'discoverHarnesses')
      const select = vi.spyOn(picker, 'chooseHarness')
      const before = await readFile(join(directory, '.config'), 'utf8')

      const prepared = await prepareDevRun(
        parseArgs(location === 'explicit' ? ['dev', '--workspace', directory] : ['dev'])
      )

      expect(prepared?.args.agent).toBe(join(root, 'agent.ts'))
      expect(scan).not.toHaveBeenCalled()
      expect(select).not.toHaveBeenCalled()
      expect(await readFile(join(directory, '.config'), 'utf8')).toBe(before)
    }
  )

  it('shouldReportTheLegacyConfigPathWhenAGenuineWorkspaceVersionIsUnsupported', async () => {
    const root = await project()
    await mkdir(join(root, '.strands'))
    const path = join(root, '.strands/config.json')
    const original = JSON.stringify({
      version: 2,
      name: 'Old workspace',
      language: 'typescript',
      entrypoint: 'agent.ts',
      origin: { kind: 'cli' },
    })
    await writeFile(path, original)

    await expect(readDevWorkspace(root)).rejects.toThrow(path)
    expect(await readFile(path, 'utf8')).toBe(original)
  })
})
