import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL, fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { spawnPosix } from './fixtures/posix-terminal.mjs'
import { TerminalScreen } from './fixtures/terminal-screen.mjs'

const run = promisify(execFile)
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const poll = { timeout: 8_000, interval: 25 }
const mouseFlags = '#{mouse_any_flag} #{mouse_button_flag} #{mouse_standard_flag} #{mouse_sgr_flag}'

interface TmuxClient {
  exited: Promise<unknown>
  text: () => Promise<string>
  write: (text: string) => void
}

interface TmuxSession {
  tmux: (...args: string[]) => Promise<string>
  capture: () => Promise<string>
  pane: (format: string) => Promise<string>
  editorResult: () => Promise<string>
  attach: (readyText?: string) => Promise<TmuxClient>
  exit: (client: TmuxClient) => Promise<void>
}

async function withTmux(scenario: 'exit' | 'editor', test: (session: TmuxSession) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'strands-tmux-'))
  const socket = `strands-test-${randomUUID()}`
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: 'false',
    TERM: 'xterm-256color',
    STRANDS_CLI_TEST_DIST: 'true',
    STRANDS_CLI_TEST_EDITOR_RESULT: join(root, 'editor-result'),
  }
  delete env.TMUX
  delete env.TMUX_PANE
  const tmux = async (...args: string[]) =>
    (await run('tmux', ['-L', socket, ...args], { env, timeout: 5_000 })).stdout.trimEnd()
  const clients: Array<{ exited: Promise<unknown>; screen: TerminalScreen; flush: () => Promise<void> }> = []

  function createSession() {
    const capture = () => tmux('capture-pane', '-p', '-t', 'cli:0.0')
    const pane = (format: string) => tmux('display-message', '-p', '-t', 'cli:0.0', format)
    const attach = async (readyText = 'Enter to send') => {
      const terminal = spawnPosix('tmux', ['-L', socket, 'attach-session', '-t', 'cli'], 30, env)
      const exited = new Promise((resolve) => terminal.onExit(resolve))
      const screen = new TerminalScreen(100, 30)
      let writes = Promise.resolve()
      terminal.onData((data: string) => {
        writes = writes.then(() => screen.write(data))
      })
      const flush = () => writes
      clients.push({ exited, screen, flush })
      const text = async () => {
        await flush()
        return screen.text
      }
      await expect.poll(() => tmux('list-clients', '-t', 'cli'), poll).not.toBe('')
      await expect.poll(text, poll).toContain(readyText)
      return { exited, text, write: terminal.write }
    }
    const exit = async (client: TmuxClient) => {
      client.write('\u0015')
      await expect.poll(client.text, poll).toContain('Enter to send')
      client.write('/exit')
      await expect.poll(client.text, poll).toContain('/exit▌')
      client.write('\r')
      await expect.poll(() => pane('#{pane_dead}'), poll).toBe('1')
      expect(await readFile(join(root, 'exit-code'), 'utf8')).toBe('0')
      expect(await readFile(join(root, 'after'), 'utf8')).toBe(await readFile(join(root, 'before'), 'utf8'))
    }
    const editorResult = () => readFile(join(root, 'editor-result'), 'utf8')
    return { tmux, capture, pane, editorResult, attach, exit }
  }

  try {
    const config = join(root, 'tmux.conf')
    await writeFile(
      config,
      'set -g status off\nset -g mouse on\nset -g default-terminal tmux-256color\nset -g remain-on-exit on\n'
    )
    const fixture = fileURLToPath(new URL('./fixtures/tui-integration-process.mjs', import.meta.url))
    const command = [
      `stty -g > ${quote(join(root, 'before'))} || exit 1`,
      `${quote(process.execPath)} ${quote(fixture)}`,
      'cli_status=$?',
      `stty -g > ${quote(join(root, 'after'))} || exit 1`,
      `printf '%s' "$cli_status" > ${quote(join(root, 'exit-code'))}`,
      'exit "$cli_status"',
    ].join('\n')
    await tmux(
      '-f',
      config,
      'new-session',
      '-d',
      '-s',
      'cli',
      '-x',
      '100',
      '-y',
      '30',
      '-e',
      `STRANDS_CLI_TEST_SCENARIO=${scenario}`,
      '/bin/sh',
      '-c',
      command
    )
    await test(createSession())
  } catch (error) {
    console.error(await tmux('capture-pane', '-p', '-t', 'cli:0.0').catch(() => 'tmux pane unavailable'))
    throw error
  } finally {
    await tmux('kill-server').catch(() => {})
    await Promise.allSettled(clients.map(({ exited }) => exited))
    for (const { screen, flush } of clients) {
      await flush()
      screen.dispose()
    }
    await rm(root, { recursive: true, force: true })
  }
}

describe.runIf(process.env.STRANDS_CLI_TEST_TMUX === 'true' && process.platform !== 'win32')('tmux integration', () => {
  it('preserves an editable draft across resizes and detach/reattach', async () => {
    await withTmux('exit', async ({ tmux, capture, pane, attach, exit }) => {
      const first = await attach()
      first.write('tmux draft')
      await expect.poll(first.text, poll).toContain('tmux draft▌')
      const pid = await pane('#{pane_pid}')
      for (const [columns, rows] of [
        [40, 16],
        [22, 10],
        [160, 50],
        [100, 30],
      ]) {
        await tmux('resize-window', '-t', 'cli:0', '-x', String(columns), '-y', String(rows))
        expect(await pane('#{pane_width}x#{pane_height}')).toBe(`${columns}x${rows}`)
        await expect.poll(async () => (await capture()).split('\n').slice(-6).join('\n'), poll).toContain('tmux draft▌')
      }
      await tmux('detach-client', '-s', 'cli')
      expect(await first.exited).toMatchObject({ exitCode: 0 })
      expect(await tmux('list-clients', '-t', 'cli')).toBe('')
      expect(await capture()).toContain('tmux draft▌')
      const second = await attach('tmux draft▌')
      expect(await pane('#{pane_pid}')).toBe(pid)
      second.write(' after reattach')
      await expect.poll(second.text, poll).toContain('tmux draft after reattach▌')
      await exit(second)
    })
  })

  it('releases mouse input to the editor and restores the CLI and terminal settings', async () => {
    await withTmux('editor', async ({ pane, editorResult, attach, exit }) => {
      const client = await attach()
      await expect.poll(() => pane(mouseFlags), poll).toBe('1 0 0 1')
      client.write('/config')
      await expect.poll(client.text, poll).toContain('/config▌')
      client.write('\r')
      await expect.poll(client.text, poll).toContain('E open')
      client.write('e')
      await expect.poll(client.text, poll).toContain('EDITOR_READY')
      // tmux owns the outer terminal's mouse mode; the pane must release its own.
      expect(await pane(mouseFlags)).toBe('0 0 0 0')
      client.write('editor input\r')
      await expect.poll(client.text, poll).toContain('E open')
      expect(await editorResult()).toBe('editor input')
      expect(await pane(mouseFlags)).toBe('1 0 0 1')
      client.write('\u001b')
      await expect.poll(client.text, poll).toContain('Enter to send')
      await exit(client)
    })
  })
})
