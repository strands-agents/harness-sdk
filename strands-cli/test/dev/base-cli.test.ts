import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { CliConfigStore } from '../../src/config/store.js'
import * as choices from '../../src/dev/agent-choices.js'
import {
  baseCliFingerprint,
  baseCliState,
  saveToBaseCli,
  savedProjectChoices,
  type BaseCliState,
} from '../../src/dev/base-cli.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const COPY = '/home/test/.strands/strands-dev/agent/agent.ts'
const OTHER = '/agents/other/agent.ts'

const writeConfig = async (toml: string, path?: string): Promise<string> => {
  const target = path ?? join(await temporaryDirectory(), 'cli.toml')
  await writeFile(target, toml)
  return target
}

const profileToml = (instructions: string): string => `[profile]\nname = "Base"\ninstructions = "${instructions}"\n`

const copyMadeFrom = async (path: string) => {
  const snapshot = (await CliConfigStore.load(path, { persist: false })).snapshot()
  return { entrypoint: COPY, config: { origin: { kind: 'cli' as const, version: baseCliFingerprint(snapshot) } } }
}

describe('baseCliState', () => {
  it.each<[string, (path: string) => Promise<string | undefined>, BaseCliState]>([
    ['current', async () => undefined, { kind: 'current' }],
    ['changed', (path) => writeConfig(profileToml('Answer in full.'), path), { kind: 'changed' }],
    [
      'saved',
      (path) => writeConfig(`agentProject = "${COPY}"\n${profileToml('Answer briefly.')}`, path),
      { kind: 'saved' },
    ],
    [
      'other',
      (path) => writeConfig(`agentProject = "${OTHER}"\n${profileToml('Answer briefly.')}`, path),
      { kind: 'other', agent: OTHER },
    ],
  ])('shouldReportThe%sStateWhenTheBaseCliIsCompared', async (_name, change, expected) => {
    const path = await writeConfig(profileToml('Answer briefly.'))
    const workspace = await copyMadeFrom(path)
    await change(path)

    expect(await baseCliState(workspace, path)).toEqual(expected)
  })

  it('shouldReportAnUnknownStateWhenTheCopyHasNoFingerprint', async () => {
    const path = await writeConfig(profileToml('Answer briefly.'))

    expect(await baseCliState({ entrypoint: COPY, config: { origin: { kind: 'cli' } } }, path)).toEqual({
      kind: 'unknown',
    })
  })
})

describe('saveToBaseCli', () => {
  it('shouldPointPlainStrandsAtTheAgentAndKeepTheProfileWhenItSaves', async () => {
    const path = await writeConfig(profileToml('Answer briefly.'))

    expect(await saveToBaseCli({ entrypoint: COPY }, path)).toBe(path)

    const saved = (await CliConfigStore.load(path, { persist: false })).snapshot()
    expect(saved.agentProject).toBe(COPY)
    expect(saved.profile.instructions).toBe('Answer briefly.')
    expect(await readFile(path, 'utf8')).not.toContain('[settings]')
  })
})

describe('savedProjectChoices', () => {
  const project = { root: '/agents/base', entrypoint: '/agents/base/agent.ts', language: 'typescript' as const }

  it.each([
    ['no saved project', undefined],
    ['another saved project', OTHER],
  ])('shouldNotSaveChoicesWhenTheCliHas%s', (_name, agentProject) => {
    const config = CliConfigStore.memory()
    vi.spyOn(config, 'snapshot').mockReturnValue({ ...config.snapshot(), ...(agentProject ? { agentProject } : {}) })

    expect(savedProjectChoices(config, project)).toEqual({})
  })

  it('shouldSaveModelChoicesIntoTheAgentFileWhenItIsTheSavedProject', async () => {
    const config = CliConfigStore.memory()
    vi.spyOn(config, 'snapshot').mockReturnValue({ ...config.snapshot(), agentProject: project.entrypoint })
    const save = vi.spyOn(choices, 'saveAgentChoices').mockResolvedValue(true)

    await savedProjectChoices(config, project).saveAgentOptions!({ model: 'bedrock/next' })

    expect(save).toHaveBeenCalledExactlyOnceWith(
      { root: project.root, entrypoint: project.entrypoint, config: { language: 'typescript' } },
      { model: 'bedrock/next' }
    )
  })
})
