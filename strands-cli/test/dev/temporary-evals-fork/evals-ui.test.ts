import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import type { DevWorkspace } from '../../../src/dev/workspace.js'
import {
  TemporaryEvalsUi,
  type TemporaryUiDependencies,
  type TemporaryUiProcess,
} from '../../../src/dev/temporary-evals-fork/evals-ui.js'
import type { TemporarySessionHost } from '../../../src/dev/temporary-evals-fork/host.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const URL = 'http://127.0.0.1:43210/?t=Secret_Token-1'
const ORIGIN = 'http://127.0.0.1:43210'
const TOKEN = '?t=Secret_Token-1'
const page = (path: string): string => `${ORIGIN}${path}${TOKEN}`

class FakeServer extends EventEmitter implements TemporaryUiProcess {
  readonly stdin = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4321
  killed = false

  kill(): boolean {
    this.killed = true
    this.emit('exit', null)
    return true
  }

  print(...lines: readonly string[]): void {
    this.stderr.write(lines.map((line) => `${line}\n`).join(''))
  }
}

interface Harness {
  readonly ui: TemporaryEvalsUi
  readonly workspace: DevWorkspace
  readonly servers: FakeServer[]
  readonly spawned: { command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }[]
  readonly notices: { status: string; text: string }[]
}

const harness = async (dependencies: Partial<TemporaryUiDependencies> = {}): Promise<Harness> => {
  const root = await temporaryDirectory()
  const workspace: DevWorkspace = {
    directory: join(root, 'strands-dev'),
    root,
    entrypoint: join(root, 'agent.py'),
    config: { version: 1, name: 'desk', language: 'python', entrypoint: 'agent.py', origin: { kind: 'discovered' } },
  }
  const servers: FakeServer[] = []
  const spawned: Harness['spawned'] = []
  const notices: Harness['notices'] = []
  const host: TemporarySessionHost = {
    workspace,
    agent: () => ({}),
    context: {
      signal: new AbortController().signal,
      report: (status, text) => {
        notices.push({ status, text })
        return { dismiss: () => undefined } as never
      },
      fail: () => undefined,
      submit: () => undefined,
      openPanel: () => true,
    },
  }
  const ui = new TemporaryEvalsUi(() => host, {
    prepare: async () => '/envs/evals/bin/python',
    spawnServer: (command, args, cwd, env) => {
      spawned.push({ command, args, cwd, env })
      const server = new FakeServer()
      servers.push(server)
      return server
    },
    openBrowser: async () => true,
    environment: {},
    ...dependencies,
  })
  return { ui, workspace, servers, spawned, notices }
}

const started = async ({ ui, servers }: Harness): Promise<FakeServer> => {
  ui.start()
  await vi.waitFor(() => expect(servers).toHaveLength(1))
  const server = servers[0]!
  server.print(
    'strands-evals ui: serving /somewhere',
    `  ${URL}`,
    '  the token in that link is what authorizes the page'
  )
  await vi.waitFor(() => expect(ui.snapshot().status).toBe('ready'))
  return server
}

describe('TEMPORARY evals UI server', () => {
  it('shouldServeTheExperimentsFolderOnLoopbackWithItsOwnTokenWhenItStarts', async () => {
    const setup = await harness()

    await started(setup)

    const { command, args, cwd, env } = setup.spawned[0]!
    const folder = join(setup.workspace.directory!, 'experiments')
    expect(command).toBe('/envs/evals/bin/python')
    expect(args.slice(2)).toEqual(['ui', folder, '--depth', '6', '--no-browser'])
    expect(args).not.toContain('--host')
    expect(args).not.toContain('--token')
    expect(cwd).toBe(setup.workspace.directory)
    expect(env.PYTHONUNBUFFERED).toBe('1')
    expect(existsSync(folder)).toBe(true)
    expect(setup.notices).toEqual([{ status: 'success', text: `Evals UI: ${page('/runs')}` }])
  })

  it('shouldPrintTheLinkWithThePortForwardWhenItIsReadyOnAnotherMachine', async () => {
    const setup = await harness({ environment: { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' }, machine: () => 'devbox' })

    await started(setup)

    expect(setup.notices).toEqual([
      {
        status: 'success',
        text: [
          `Evals UI: ${page('/runs')}`,
          'strands dev runs on another machine. Forward the port on your computer first:',
          'ssh -N -L 43210:127.0.0.1:43210 devbox',
        ].join('\n'),
      },
    ])
  })

  it.each([
    [{ view: 'runs' as const }, '/runs'],
    [{ view: 'opt-runs' as const }, '/optimization'],
  ])('shouldLinkToTheListPageWhenThePlaceIs %o', async (place, path) => {
    const setup = await harness()
    await started(setup)

    expect(setup.ui.link(place)).toBe(page(path))
  })

  it.each([
    ['experiment' as const, '/runs/refunds/refunds.json/experiment/cases/late%20fee%20%26%20refund'],
    ['report' as const, '/runs/refunds/refunds.json/report'],
  ])('shouldLinkTheExperimentFileByItsPathUnderTheFolderWhenTheViewIs %s', async (view, path) => {
    const setup = await harness()
    await started(setup)
    const experiment = join(setup.workspace.directory!, 'experiments', 'refunds', 'refunds.json')

    const link = setup.ui.link({ view, experiment, case: 'late fee & refund' })

    expect(link).toBe(page(path))
  })

  it.each([
    [
      'ARunFolder',
      true,
      '/optimization/refunds/optimizations/20261117-101500/optimizer/20261117-101500-abc123/overview',
    ],
    ['NoRunFolderYet', false, '/optimization'],
  ])('shouldLinkTheOptimizerRunByItsFolderWhenTheRecordHas%s', async (_case, made, path) => {
    const openBrowser = vi.fn(async () => true)
    const setup = await harness({ openBrowser })
    await started(setup)
    const record = join(
      setup.workspace.directory!,
      'experiments',
      'refunds',
      'optimizations',
      '20261117-101500',
      'optimizer'
    )
    await mkdir(made ? join(record, '20261117-101500-abc123') : record, { recursive: true })

    await setup.ui.open({ view: 'optimization', record })

    expect(openBrowser).toHaveBeenCalledWith(page(path))
  })

  it('shouldLinkWithoutARunWhenTheExperimentIsOutsideTheFolder', async () => {
    const setup = await harness()
    await started(setup)

    expect(setup.ui.link({ view: 'experiment', experiment: '/elsewhere/refunds.json', case: 'one' })).toBe(
      page('/runs')
    )
  })

  it('shouldOpenTheBrowserAndShowNothingWhenTheBrowserOpens', async () => {
    const openBrowser = vi.fn(async () => true)
    const setup = await harness({ openBrowser })
    await started(setup)

    const notice = await setup.ui.open({ view: 'runs' })

    expect(notice).toBeUndefined()
    expect(openBrowser).toHaveBeenCalledWith(page('/runs'))
  })

  it('shouldShowTheLinkWhenNoBrowserOpens', async () => {
    const setup = await harness({ openBrowser: async () => false })
    await started(setup)

    const notice = await setup.ui.open({ view: 'runs' })

    expect(notice?.lines).toEqual(['Open this link in a browser:', page('/runs')])
  })

  it('shouldGiveThePortForwardAndTheLinkWithoutOpeningABrowserWhenStrandsDevRunsOverSsh', async () => {
    const openBrowser = vi.fn(async () => true)
    const setup = await harness({
      openBrowser,
      environment: { SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22' },
      machine: () => 'dev-desk',
    })
    await started(setup)

    const notice = await setup.ui.open({ view: 'opt-runs' })

    expect(openBrowser).not.toHaveBeenCalled()
    expect(notice?.lines).toEqual([
      expect.stringContaining('another machine'),
      'ssh -N -L 43210:127.0.0.1:43210 dev-desk',
      `Then open ${page('/optimization')}`,
    ])
  })

  it('shouldSayItIsStartingWhenOpenedBeforeTheServerIsReady', async () => {
    const setup = await harness()
    setup.ui.start()
    await vi.waitFor(() => expect(setup.servers).toHaveLength(1))

    const notice = await setup.ui.open({ view: 'runs' })

    expect(notice?.lines[0]).toContain('The evals UI is starting')
  })

  it('shouldStaySoftAndExplainWhenTheEnvironmentCannotBePrepared', async () => {
    const setup = await harness({
      prepare: async () => {
        throw new Error('Could not install strands-agents-evals:\nERROR: no network')
      },
    })

    setup.ui.start()

    await vi.waitFor(() => expect(setup.ui.snapshot().status).toBe('unavailable'))
    expect(setup.ui.snapshot().detail).toBe('Could not install strands-agents-evals:')
    expect(setup.notices).toEqual([{ status: 'error', text: expect.stringContaining('evals UI unavailable') }])
  })

  it('shouldStartAgainWhenOpenedAfterTheServerStopped', async () => {
    const setup = await harness()
    const server = await started(setup)
    server.print('Traceback: address in use')
    server.emit('exit', 1)
    await vi.waitFor(() => expect(setup.ui.snapshot().status).toBe('unavailable'))

    const notice = await setup.ui.open({ view: 'runs' })

    expect(notice?.lines).toEqual([
      'The evals UI stopped: Traceback: address in use',
      'strands dev is starting the evals UI. Try again in a moment.',
    ])
    await vi.waitFor(() => expect(setup.servers).toHaveLength(2))
  })

  it('shouldStopTheServerWhenStopped', async () => {
    const setup = await harness()
    const server = await started(setup)

    setup.ui.stop()

    expect(server.killed).toBe(true)
  })
})
