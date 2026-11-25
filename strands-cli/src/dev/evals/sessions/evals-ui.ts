import { spawn } from 'node:child_process'
import { hostname } from 'node:os'
import { relative, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { URL } from 'node:url'

import { containsPath } from '../../../paths.js'
import { errorMessage } from '../../../terminal/text.js'
import { recordDevEvent } from '../../telemetry.js'
import type { EvalsBrowser, EvalsBrowserNotice, EvalsBrowserPlace, EvalsBrowserState } from '../model.js'
import { prepareEvalsOptimizerEnvironment, type EvalsEnvironmentOptions } from '../runs/environment.js'
import { evalsProcessEnvironment, evalsWorkspaceDirectory } from '../runs/evals-process.js'
import { announce, firstLine, type EvalsHost } from '../host.js'
import { Store } from '../jobs.js'
import {
  ensureEvalsExperimentsFolder,
  evalsExperimentHome,
  evalsExperimentsFolder,
  evalsLatestReport,
} from '../layout.js'
import { evalsRunFolder } from '../tuning/study.js'
import { evalsWorkspaceReady } from '../runs/layout-migration.js'

export interface EvalsUiProcess {
  readonly stderr: Readable | null
  kill(): boolean
  on(event: 'exit', listener: (code: number | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
}

export interface EvalsUiDependencies {
  readonly prepare?: (host: ReturnType<EvalsHost>, options: EvalsEnvironmentOptions) => Promise<string>
  readonly spawnServer?: (
    command: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv
  ) => EvalsUiProcess
  readonly openBrowser?: (url: string) => Promise<boolean>
  readonly environment?: NodeJS.ProcessEnv
  readonly machine?: () => string
}

const UI_DEPTH = 6
const EXPERIMENTS_ROUTE = '/experiments'
const REPORTS_ROUTE = '/reports'
const OPTIMIZATION_ROUTE = '/optimization'
const OPTIMIZATION_VIEW = 'result'
const START_TIMEOUT_MS = 60_000
const ERROR_LINES = 3
const URL_LINE = /^\s*(http:\/\/127\.0\.0\.1:(\d+)\/\?t=[A-Za-z0-9_-]+)\s*$/u
const SERVER_WRAPPER = [
  'import os, runpy, sys, threading',
  "sys.argv = ['strands-evals', *sys.argv[1:]]",
  'def serve():',
  '    code = 0',
  '    try:',
  "        runpy.run_module('strands_evals.cli', run_name='__main__', alter_sys=True)",
  '    except SystemExit as stop:',
  '        code = stop.code if isinstance(stop.code, int) else (0 if stop.code is None else 1)',
  '    except BaseException:',
  '        import traceback',
  '        traceback.print_exc()',
  '        code = 1',
  '    sys.stderr.flush()',
  '    os._exit(code)',
  'threading.Thread(target=serve, daemon=True).start()',
  'sys.stdin.read()',
  'os._exit(0)',
].join('\n')

const spawnServer: NonNullable<EvalsUiDependencies['spawnServer']> = (command, args, cwd, env) =>
  spawn(command, [...args], { cwd, env, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })

const BROWSER_COMMANDS: Readonly<Partial<Record<NodeJS.Platform, (url: string) => [string, string[]]>>> = {
  darwin: (url) => ['open', [url]],
  win32: (url) => ['rundll32', ['url.dll,FileProtocolHandler', url]],
  linux: (url) => ['xdg-open', [url]],
}

const openBrowser = (url: string): Promise<boolean> =>
  new Promise((resolve) => {
    const command = BROWSER_COMMANDS[process.platform]
    const graphical = process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
    if (!command || !graphical) return resolve(false)
    const [program, args] = command(url)
    const child = spawn(program, args, { stdio: 'ignore', detached: true, windowsHide: true })
    child.once('error', () => resolve(false))
    child.once('exit', (code) => resolve(code === 0))
    child.unref()
  })

const segments = (id: string): string => id.split('/').map(encodeURIComponent).join('/')

const isRemote = (environment: NodeJS.ProcessEnv): boolean =>
  Boolean(environment.SSH_CONNECTION || environment.SSH_CLIENT || environment.SSH_TTY)

export class EvalsUi extends Store<EvalsBrowserState> implements EvalsBrowser {
  private server: EvalsUiProcess | undefined
  private url: string | undefined
  private port: number | undefined
  private announced = false
  private readonly stopOnExit = (): void => this.stop()

  constructor(
    private readonly host: EvalsHost,
    private readonly dependencies: EvalsUiDependencies = {}
  ) {
    super({ status: 'off' })
  }

  start(): void {
    const { status } = this.snapshot()
    if (status === 'starting' || status === 'ready') return
    this.set({ status: 'starting', detail: 'preparing the evals environment' })
    void this.launch()
  }

  stop(): void {
    process.off('exit', this.stopOnExit)
    const server = this.server
    this.server = undefined
    server?.kill()
  }

  link(place: EvalsBrowserPlace, runFolder?: string): string | undefined {
    if (!this.url) return undefined
    const address = new URL(this.url)
    return `${address.origin}${this.route(place, runFolder)}?t=${address.searchParams.get('t') ?? ''}`
  }

  open = async (place: EvalsBrowserPlace): Promise<EvalsBrowserNotice | undefined> => {
    const state = this.snapshot()
    if (state.status === 'off' || state.status === 'unavailable') {
      this.start()
      return {
        lines: [
          ...(state.status === 'unavailable' ? [`The evals UI stopped: ${state.detail}`] : []),
          'strands dev is starting the evals UI. Try again in a moment.',
        ],
      }
    }
    const runFolder =
      place.view === 'optimization' ? await evalsRunFolder(place.record).catch(() => undefined) : undefined
    const url = this.link(place, runFolder)
    if (state.status === 'starting' || !url || this.port === undefined)
      return {
        lines: [`The evals UI is starting: ${state.detail ?? 'please wait'}. Try again in a moment.`],
      }
    const forward = this.forwardLines(this.port)
    if (forward) return { lines: [...forward, `Then open ${url}`] }
    recordDevEvent('evals_ui_opened')
    const opened = await (this.dependencies.openBrowser ?? openBrowser)(url).catch(() => false)
    return opened ? undefined : { lines: ['Open this link in a browser:', url] }
  }

  // On a remote machine the developer forwards the port before a link opens.
  private forwardLines(port: number): string[] | undefined {
    if (!isRemote(this.dependencies.environment ?? process.env)) return undefined
    return [
      'strands dev runs on another machine. Forward the port on your computer first:',
      `ssh -N -L ${port}:127.0.0.1:${port} ${(this.dependencies.machine ?? hostname)()}`,
    ]
  }

  private route(place: EvalsBrowserPlace, runFolder: string | undefined): string {
    if (place.view === 'runs') return EXPERIMENTS_ROUTE
    if (place.view === 'opt-runs') return OPTIMIZATION_ROUTE
    if (place.view === 'optimization') {
      const run = runFolder ? this.pageId(runFolder) : undefined
      return run ? `${OPTIMIZATION_ROUTE}/${segments(run)}/${OPTIMIZATION_VIEW}` : OPTIMIZATION_ROUTE
    }
    const item = place.case ? encodeURIComponent(place.case) : undefined
    if (place.view === 'experiment') {
      const file = this.pageId(place.experiment)
      if (!file) return EXPERIMENTS_ROUTE
      return `${EXPERIMENTS_ROUTE}/${segments(file)}${item ? `/cases/${item}` : ''}`
    }
    const workspace = evalsWorkspaceDirectory(this.host().workspace)
    const report = this.pageId(evalsLatestReport(evalsExperimentHome(workspace, place.experiment)))
    if (!report) return REPORTS_ROUTE
    return `${REPORTS_ROUTE}/${segments(report)}${item ? `/rows/${item}` : ''}`
  }

  private pageId(path: string): string | undefined {
    const root = evalsExperimentsFolder(evalsWorkspaceDirectory(this.host().workspace))
    return path !== root && containsPath(root, path) ? relative(root, path).split(sep).join('/') : undefined
  }

  private async launch(): Promise<void> {
    const host = this.host()
    try {
      const python = await (this.dependencies.prepare ?? prepareServerEnvironment)(host, {
        onProgress: (line) => this.set({ status: 'starting', detail: line }),
      })
      const environment = {
        ...evalsProcessEnvironment(python, this.dependencies.environment ?? process.env),
        PYTHONUNBUFFERED: '1',
      }
      await evalsWorkspaceReady(evalsWorkspaceDirectory(host.workspace))
      const root = await ensureEvalsExperimentsFolder(evalsWorkspaceDirectory(host.workspace))
      this.set({ status: 'starting', detail: 'starting the page server' })
      this.listen(
        (this.dependencies.spawnServer ?? spawnServer)(
          python,
          ['-c', SERVER_WRAPPER, 'ui', root, '--depth', String(UI_DEPTH), '--no-browser'],
          evalsWorkspaceDirectory(host.workspace),
          environment
        )
      )
    } catch (error) {
      this.fail(errorMessage(error))
    }
  }

  private listen(server: EvalsUiProcess): void {
    this.server = server
    process.once('exit', this.stopOnExit)
    const output: string[] = []
    let pending = ''
    const timer = setTimeout(() => {
      if (this.snapshot().status !== 'starting' || this.server !== server) return
      this.fail('the page server did not print its address in time')
      this.stop()
    }, START_TIMEOUT_MS)
    timer.unref()
    server.stderr?.setEncoding('utf8')
    server.stderr?.on('data', (chunk: string) => {
      const lines = `${pending}${chunk}`.split(/\r?\n/u)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const match = URL_LINE.exec(line)
        if (match && this.snapshot().status === 'starting') this.ready(match[1]!, Number(match[2]))
        else if (line.trim()) output.push(line.trim())
      }
      output.splice(0, Math.max(0, output.length - ERROR_LINES))
    })
    server.on('error', (error) => {
      clearTimeout(timer)
      if (this.server === server) this.fail(error.message)
    })
    server.on('exit', (code) => {
      clearTimeout(timer)
      if (this.server !== server) return
      this.server = undefined
      this.url = undefined
      this.port = undefined
      process.off('exit', this.stopOnExit)
      this.fail(output.at(-1) ?? `the page server exited with code ${code ?? 'unknown'}`)
    })
  }

  private ready(url: string, port: number): void {
    this.url = url
    this.port = port
    this.set({ status: 'ready' })
    if (this.announced) return
    this.announced = true
    announce(this.host(), 'success', ['Evals UI:', url, ...(this.forwardLines(port) ?? [])].join('\n'))
  }

  private fail(reason: string): void {
    const detail = firstLine(reason)
    this.set({ status: 'unavailable', detail })
    announce(this.host(), 'error', `evals UI unavailable · ${detail} · ask the chat to retry`)
  }
}

const prepareServerEnvironment = (
  { workspace }: ReturnType<EvalsHost>,
  options: EvalsEnvironmentOptions
): Promise<string> =>
  prepareEvalsOptimizerEnvironment(
    {
      workspaceDirectory: evalsWorkspaceDirectory(workspace),
      projectRoot: workspace.root,
      language: workspace.config.language,
    },
    options
  )
