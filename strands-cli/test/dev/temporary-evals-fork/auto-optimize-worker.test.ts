import { existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import {
  autoOptimizeWorker,
  autoOptimizeWorkerArguments,
  strandsCommandOf,
} from '../../../src/dev/temporary-evals-fork/auto-optimize-worker.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const PROGRAM = fileURLToPath(new URL('../../fixtures/auto-optimize-worker.mjs', import.meta.url))

const workspaceIn = (root: string): DevWorkspace => ({
  directory: join(root, 'strands-dev'),
  root,
  entrypoint: join(root, 'agent.ts'),
  config: { version: 1, name: 'desk', language: 'typescript', entrypoint: 'agent.ts', origin: { kind: 'discovered' } },
})

const setup = async () => {
  const root = await temporaryDirectory()
  const workspace = workspaceIn(root)
  const log = join(root, 'strands-dev', 'tmp', '.state', 'auto-optimize', 'history.log')
  const worker = autoOptimizeWorker(() => [process.execPath, PROGRAM])
  return { root, workspace, log, worker }
}

describe('the process that auto-optimize works in', () => {
  it('shouldRunTheAgentOfTheWorkspaceOnOneRequestWithoutASessionOrMemory', () => {
    const workspace = workspaceIn('/w')

    // Its work must not be saved as a chat: the next experiment would be made from it.
    expect(autoOptimizeWorkerArguments(workspace)).toEqual([
      'dev',
      '--workspace',
      expect.stringMatching(/strands-dev$/u),
      '--print',
      '--session',
      'off',
      '--memory',
      'off',
    ])
  })

  it.each([
    [
      ['/repo/strands-cli/bin/strands.js', '/usr/bin/node', []],
      ['/usr/bin/node', '/repo/strands-cli/bin/strands.js'],
    ],
    [
      ['/repo/strands-cli/src/main.ts', '/usr/bin/node', ['--import', 'tsx']],
      ['/usr/bin/node', '--import', 'tsx', '/repo/strands-cli/src/main.ts'],
    ],
    // An installed strands is a link without an extension, and the runtime still needs it.
    [
      ['/opt/homebrew/bin/strands', '/usr/bin/node', []],
      ['/usr/bin/node', '/opt/homebrew/bin/strands'],
    ],
    [['/usr/local/bin/strands', '/usr/local/bin/strands', []], ['/usr/local/bin/strands']],
    [[undefined, '/usr/local/bin/strands', []], ['/usr/local/bin/strands']],
  ] as const)('shouldStartTheSameStrandsThatIsRunning %j', ([entry, runtime, flags], command) => {
    expect(strandsCommandOf(entry, runtime, flags)).toEqual(command)
  })

  it('shouldGiveTheRequestOnStandardInputAndWriteAllItPrintsToTheLog', async () => {
    const { root, workspace, log, worker } = await setup()

    const exit = await worker({ workspace, prompt: 'exit 0', log, signal: new AbortController().signal })

    const printed = await readFile(log, 'utf8')
    expect(exit).toEqual({ code: 0 })
    expect(printed).toContain('request: exit 0')
    expect(printed).toContain(`arguments: ${JSON.stringify(autoOptimizeWorkerArguments(workspace))}`)
    expect(printed).toContain(`cwd: ${await realpath(root)}`)
    // The strands dev that starts it has the project open, so the agent must not install or build it again.
    expect(printed).toContain('prepared: 1')
  })

  it('shouldGiveTheExitCodeOfAnAgentThatFailed', async () => {
    const { workspace, log, worker } = await setup()

    const exit = await worker({ workspace, prompt: 'exit 3', log, signal: new AbortController().signal })

    expect(exit).toEqual({ code: 3 })
  })

  it('shouldStopTheAgentWhenTheSignalAborts', async () => {
    const { root, workspace, log, worker } = await setup()
    const started = join(root, 'started')
    const stop = new AbortController()

    const exit = worker({ workspace, prompt: `wait ${started}`, log, signal: stop.signal })
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 10_000 })
    stop.abort()

    expect((await exit).code).not.toBe(0)
  })

  it('shouldNotLeaveItsListenersBehindWhenTheAgentEnds', async () => {
    const { workspace, log, worker } = await setup()
    const before = process.listenerCount('exit')

    await worker({ workspace, prompt: 'exit 0', log, signal: new AbortController().signal })

    expect(process.listenerCount('exit')).toBe(before)
  })
})
