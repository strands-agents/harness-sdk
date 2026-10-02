import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock'
import type { Agent } from '@strands-agents/sdk'
import { describe, expect, it, vi } from 'vitest'

import { listBedrockModels, type BedrockCatalogClient } from '../src/tui/provider/bedrock-catalog.js'
import { FileSessionRuntime } from '../src/tui/session/sessions.js'
import { FileSkillsRuntime } from '../src/tui/skills.js'

describe('runtime metadata terminal safety', () => {
  it('sanitizes session and skill metadata while preserving newlines and tabs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-runtime-metadata-'))
    const skillDirectory = join(directory, 'terminal-skill')
    await mkdir(skillDirectory)
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      [
        '---',
        'name: terminal-skill',
        'description: Terminal safety fixture',
        '---',
        'line\tone',
        'line\u001b[2Jtwo\u0007',
      ].join('\n')
    )
    const agent = { appState: { get: () => undefined } } as unknown as Agent
    const sessions = new FileSessionRuntime(
      {
        sessionId: 'active\u0007',
        sessionDirectory: '/tmp/sessions\u001b[2J',
      },
      '/tmp/sessions\u001b[2J'
    )
    const skills = new FileSkillsRuntime([skillDirectory], () => agent)

    try {
      expect(sessions.current).toBe('active')
      expect(sessions.directory).toBe('/tmp/sessions')
      await expect(skills.list()).resolves.toMatchObject([
        {
          name: 'terminal-skill',
          description: 'Terminal safety fixture',
          instructions: 'line\tone\nlinetwo',
        },
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('sanitizes Bedrock catalog display metadata', async () => {
    const destroy = vi.fn()
    const client = {
      send: async (command: ListInferenceProfilesCommand | ListFoundationModelsCommand) =>
        command instanceof ListInferenceProfilesCommand
          ? { inferenceProfileSummaries: [] }
          : {
              modelSummaries: [
                {
                  modelId: 'model\u0007-id',
                  modelName: 'Model\u001b[31m Name',
                  providerName: 'Provider\u009b31m',
                  modelLifecycle: { status: 'ACTIVE' },
                  outputModalities: ['TEXT'],
                  responseStreamingSupported: true,
                  inferenceTypesSupported: ['ON_DEMAND'],
                },
              ],
            },
      destroy,
    } as BedrockCatalogClient

    await expect(listBedrockModels(client)).resolves.toEqual({
      models: [
        {
          id: 'model-id',
          name: 'Model Name',
          description: '',
        },
      ],
      knownModelIds: ['model-id'],
      complete: true,
    })
    expect(destroy).toHaveBeenCalledOnce()
  })
})
