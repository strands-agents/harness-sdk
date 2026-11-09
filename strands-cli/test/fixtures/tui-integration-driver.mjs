#!/usr/bin/env node

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'
import { fileURLToPath } from 'node:url'
import { spawnPosix } from './posix-terminal.mjs'
import { TerminalScreen } from './terminal-screen.mjs'

const ANSI_ESCAPE = new RegExp(String.raw`\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))`, 'gu')
const SCREEN_QUIET_MS = 75
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const writeStdout = (value) =>
  new Promise((resolve, reject) => {
    process.stdout.write(value, (error) => (error ? reject(error) : resolve()))
  })

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command) {
    throw new Error('missing TUI child command')
  }
  const windows = process.platform === 'win32'

  const scenario = process.env.STRANDS_CLI_TEST_SCENARIO ?? 'exit'
  const exportLanguage = process.env.STRANDS_CLI_TEST_EXPORT_LANGUAGE ?? 'typescript'
  const shellMode = { 'shell-command': 'command', 'shell-interrupt': 'interrupt' }[scenario]
  const followUpMode = scenario === 'follow-up'
  const approvalMode = scenario === 'approval'
  const setupExportMode = scenario === 'setup-export'
  const exportFailureMode = scenario === 'export-failure'
  const setupImportMode = scenario === 'lifecycle-setup-import'
  const lifecycleMode =
    scenario === 'lifecycle-profile' || scenario === 'lifecycle-project' || scenario === 'lifecycle-setup-import'
  const liveMode = scenario === 'live-self-building'
  const panelsMode = scenario === 'panels'
  const startupTyping = scenario === 'startup-typing'
  const intro = scenario === 'startup' || startupTyping
  const resize = scenario === 'resize'
  const rows = startupTyping ? 40 : intro ? 20 : 30
  let transcript = ''
  const screens = []
  const screen = new TerminalScreen(100, rows)
  let screenWrites = Promise.resolve()
  let screenWriteError
  let lastOutputAt = Date.now()
  let returnCode
  let inputModeRestored = null
  let resolveExit
  const exited = new Promise((resolve) => {
    resolveExit = resolve
  })
  const statePath = windows ? join(tmpdir(), `strands-tui-input-${randomUUID()}.json`) : undefined
  const terminal = windows
    ? (await import('node-pty')).default.spawn(
        process.env.PYTHON ?? 'python',
        [fileURLToPath(new URL('./tui-integration-terminal.py', import.meta.url)), statePath, command, ...args],
        {
          name: 'xterm-256color',
          cols: 100,
          rows,
          cwd: process.cwd(),
          env: { ...process.env, CI: 'false', TERM: 'xterm-256color' },
          useConpty: true,
        }
      )
    : spawnPosix(command, args, rows)
  const dataSubscription = terminal.onData((data) => {
    transcript += data
    lastOutputAt = Date.now()
    screenWrites = screenWrites
      .then(() => screen.write(data))
      .catch((error) => {
        screenWriteError ??= error
      })
  })
  const exitSubscription = terminal.onExit(({ exitCode, inputModeRestored: restored }) => {
    // ConPTY can close its output socket before node-pty receives the native exit status.
    returnCode = exitCode ?? 0
    inputModeRestored = restored ?? null
    resolveExit()
  })

  const drainScreen = async (deadline) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('terminal screen parser timed out')
    let timer
    try {
      await Promise.race([
        screenWrites,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('terminal screen parser timed out')), remaining)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    if (screenWriteError) throw screenWriteError
  }
  const waitFor = async (markers, timeout = 8_000, styled = true, start = 0, stable = false, absent = []) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await drainScreen(deadline)
      const output = styled ? transcript.slice(start) : transcript.slice(start).replace(ANSI_ESCAPE, '')
      const screenMarkers = styled ? [] : markers.filter((marker) => !marker.startsWith('__'))
      const usesScreen = !styled && (screenMarkers.length > 0 || stable)
      const hasFreshScreen = !usesScreen || start === 0 || transcript.length > start
      const isStable = !stable || Date.now() - lastOutputAt >= SCREEN_QUIET_MS
      if (
        hasFreshScreen &&
        isStable &&
        markers.every((marker) => (styled || marker.startsWith('__') ? output : screen.text).includes(marker)) &&
        absent.every((marker) => !screen.text.includes(marker))
      ) {
        screens.push(screen.text)
        return
      }
      if (returnCode !== undefined) {
        break
      }
      await sleep(25)
    }
    const output = styled ? transcript.slice(start) : transcript.slice(start).replace(ANSI_ESCAPE, '')
    const missing = markers.filter(
      (marker) => !(styled || marker.startsWith('__') ? output : screen.text).includes(marker)
    )
    throw new Error(
      `missing markers ${JSON.stringify(missing)}; unexpected markers ${JSON.stringify(absent.filter((marker) => screen.text.includes(marker)))}; returncode=${returnCode}; screen=${screen.text}; output=${transcript}`
    )
  }
  const waitForStableScreen = (markers, timeout = 8_000, start = 0, absent = []) =>
    waitFor(markers, timeout, false, start, true, absent)
  const clickText = async (text) => {
    await waitForStableScreen([text])
    const { column, row } = screen.locate(text)
    terminal.write(`\u001b[<0;${column};${row}M\u001b[<3;${column};${row}m`)
  }
  const waitForStyle = async (text, style) => {
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      await drainScreen(deadline)
      if (
        Date.now() - lastOutputAt >= SCREEN_QUIET_MS &&
        JSON.stringify(screen.locate(text)?.style) === JSON.stringify(style)
      ) {
        screens.push(screen.text)
        return
      }
      await sleep(25)
    }
    throw new Error(`focus did not move to ${text}; screen=${screen.text}`)
  }
  const resizeTerminal = (columns, height) => {
    screen.resize(columns, height)
    terminal.resize(columns, height)
  }
  const waitForExit = async (timeout = 8_000) => {
    let timer
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`process did not exit; output=${transcript}`)), timeout)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  const resizeScreens = []
  try {
    if (setupImportMode) {
      await waitFor(['Quickstart', 'Import'], 20_000, false)
    } else {
      const readyTimeout = liveMode ? 90_000 : lifecycleMode ? 210_000 : 8_000
      await waitForStableScreen(['Enter to send'], readyTimeout, 0, ['Loading…'])
    }

    if (resize) {
      for (const [columns, height] of [
        [80, 24],
        [40, 16],
        [22, 10],
        [160, 50],
        [160, 25],
        [100, 30],
      ]) {
        const offset = transcript.length
        resizeTerminal(columns, height)
        await waitForStableScreen([], 2_000, offset)
        resizeScreens.push({ columns, rows: height, text: screen.text })
      }

      const burstStart = transcript.length
      for (const [columns, height] of [
        [70, 25],
        [50, 18],
        [120, 40],
      ]) {
        resizeTerminal(columns, height)
      }
      await waitForStableScreen([], 2_000, burstStart)
      resizeScreens.push({ columns: 120, rows: 40, text: screen.text })
    }

    const typeInComposer = async (text, timeout = 10_000) => {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        const start = transcript.length
        terminal.write(`\u0015${text}`)
        const attemptDeadline = Math.min(deadline, Date.now() + 2_000)
        while (Date.now() < attemptDeadline) {
          await drainScreen(attemptDeadline)
          if (screen.locate(`${text}▌`)?.row >= rows - 5) return start
          await sleep(25)
        }
      }
      throw new Error(`composer did not accept ${text}; screen=${screen.text}; output=${transcript}`)
    }
    const submit = async (prompt, markers, approve = false) => {
      const start = await typeInComposer(prompt)
      terminal.write('\r')
      if (approve) {
        await waitFor(['Enter choose'], 8_000, false, start)
        terminal.write('\r')
      }
      await waitForStableScreen([...markers, 'Worked for', 'Enter to send'], 15_000, start)
    }

    if (setupImportMode) {
      await clickText('Import')
      await waitFor(['Import an agent'], 5_000, false)
      const editStart = transcript.length
      terminal.write('\r')
      await waitFor(['Enter save', '▌'], 5_000, false, editStart)
      const path = process.env.STRANDS_CLI_TEST_IMPORT_PATH
      terminal.write(path)
      await waitFor([path.split(/[\\/]/u).at(-1)], 2_000, false, editStart)
      const commitStart = transcript.length
      terminal.write('\r')
      await waitFor(['Click or Enter to choose'], 2_000, false, commitStart)
      const launchStart = transcript.length
      await clickText('Launch')
      await waitForStableScreen(['Enter to send', 'Ask your agent to change its instructions'], 210_000, launchStart, [
        'Loading…',
      ])
    }

    if (scenario === 'builtin-tools') {
      await submit('exercise built-in tools', ['BUILTIN_TOOLS_OK'])
    } else if (scenario === 'queue') {
      await typeInComposer('hold queue')
      terminal.write('\r')
      await waitForStableScreen(['Queue gate waiting'])
      for (const prompt of ['delete by mouse', 'delete by keyboard', 'clear with enter', 'keep this']) {
        await typeInComposer(prompt)
        const start = transcript.length
        terminal.write('\r')
        await waitForStableScreen([`· ${prompt}  `], 8_000, start)
      }
      await clickText('Delete')
      await waitForStableScreen(['keep this'], 8_000, 0, ['delete by mouse'])
      terminal.write('\u001b[1;3A')
      await waitForStableScreen(['keep this · editing'])
      terminal.write('\u001b[1;3A')
      await waitForStableScreen(['clear with enter · editing'])
      const clearStart = transcript.length
      terminal.write('\u0015')
      await waitForStableScreen(['Ctrl+D delete'], 8_000, clearStart)
      terminal.write('\r')
      await waitForStableScreen(['keep this'], 8_000, 0, ['clear with enter'])
      terminal.write('\u001b[1;3A')
      await waitForStableScreen(['keep this · editing'])
      terminal.write('\u001b[1;3A')
      await waitForStableScreen(['delete by keyboard · editing'])
      terminal.write('\u0004')
      await waitForStableScreen(['keep this'], 8_000, 0, ['delete by keyboard'])
      for (const prompt of ['steer this', 'delete button']) {
        await typeInComposer(prompt)
        const start = transcript.length
        terminal.write('\r')
        await waitForStableScreen([`· ${prompt}  `], 8_000, start)
      }
      await typeInComposer('Keep my draft')
      terminal.write('\t')
      await waitForStableScreen(['›↓', 'Queue · Tab/Shift+Tab'])
      terminal.write('\r')
      await waitForStableScreen(['Queued 2/3 · keep this'])
      terminal.write('\u001b[Z')
      await waitForStableScreen(['›↑'])
      terminal.write('\r')
      await waitForStableScreen(['Queued 1/3 · keep this'])
      terminal.write('\t')
      await waitForStableScreen(['›↓'])
      terminal.write('\t')
      await waitForStableScreen(['›Edit'])
      terminal.write('\r')
      await waitForStableScreen(['keep this · editing'])
      terminal.write('\u0015')
      await waitForStableScreen(['▌Enter to queue'])
      terminal.write('edited keep')
      await waitForStableScreen(['edited keep'])
      terminal.write('\r')
      await waitForStableScreen(['Queued 1/3 · edited keep', 'Keep my draft'])
      terminal.write('\u001b[Z')
      await waitForStableScreen(['›Delete'])
      terminal.write('\r')
      await waitForStableScreen(['Keep my draft'], 8_000, 0, ['delete button'])
      terminal.write('\u001b[Z')
      await waitForStableScreen(['›Delete'])
      terminal.write('\u001b[Z')
      await waitForStableScreen(['›Steer'])
      terminal.write('\r')
      await waitForStableScreen(['Executed: steer this', 'Executed: edited keep', 'Keep my draft'])
      if (screen.text.indexOf('Executed: steer this') > screen.text.indexOf('Executed: edited keep')) {
        throw new Error('Steering did not run ahead of the other queued message')
      }
      if (transcript.includes('Executed: delete') || transcript.includes('Executed: clear')) {
        throw new Error('A deleted queued message was executed')
      }
      terminal.write('\u0015')
      await waitForStableScreen(['Enter to send'])
    } else if (scenario === 'editor') {
      await typeInComposer('/config')
      terminal.write('\r')
      await waitForStableScreen(['E open'])
      terminal.write('e')
      await waitFor(['EDITOR_READY'], 8_000, false)
      if (screen.terminal.modes.mouseTrackingMode !== 'none') throw new Error('CLI mouse reporting leaked into editor')
      terminal.write('editor ')
      await waitFor(['editor'], 8_000, false)
      terminal.write('input\r')
      await waitFor(['EDITOR_INPUT_OK'], 8_000, true)
      await waitForStableScreen(['E open'])
      if (screen.terminal.buffer.active.type !== 'alternate') throw new Error('CLI alternate screen was not restored')
      if (screen.terminal.modes.mouseTrackingMode !== 'any') throw new Error('CLI mouse reporting was not restored')
      const start = transcript.length
      terminal.write('\u001b')
      await waitForStableScreen(['Enter to send'], 8_000, start)
    } else if (scenario === 'voice') {
      await typeInComposer('/voice')
      terminal.write('\r')
      await waitForStableScreen(['Speaker', 'Nova'])
      await clickText('On')
      await waitForStableScreen(['Voice muted', 'Speaker', 'Nova', 'Space mute'])
      const start = transcript.length
      terminal.write('\u001b')
      await waitForStableScreen(['Voice muted', 'Enter to send'], 8_000, start, ['Speaker'])
    } else if (liveMode) {
      let generation = 1
      let turns = 0
      const liveSubmit = async (prompt, idleGeneration, idleTurns) => {
        const start = transcript.length
        terminal.write(prompt)
        await waitFor([prompt.slice(0, 40)], 5_000, false, start)
        terminal.write('\r')
        await waitFor([`__LIVE_IDLE_${idleGeneration}_${idleTurns}__`], 150_000, true, start)
        await waitForStableScreen(['Enter to send'])
      }
      if (process.env.STRANDS_CLI_TEST_SETUP_PROMPT) {
        generation = 2
        turns = 1
        await liveSubmit(process.env.STRANDS_CLI_TEST_SETUP_PROMPT, generation, turns)
      }
      await liveSubmit(process.env.STRANDS_CLI_TEST_USE_PROMPT, generation, turns + 1)
      terminal.write(`/config ${exportLanguage}`)
      await waitFor([`/config ${exportLanguage}▌`], 8_000, false)
      const configStart = transcript.length
      terminal.write('\r')
      await waitFor(['TypeScript'], 8_000, false, configStart)
      let closeStart = transcript.length
      terminal.write('\u001b')
      await waitForStableScreen(['Enter to send'], 8_000, closeStart)
      const commandStart = transcript.length
      terminal.write(`/export ${exportLanguage} "${process.env.STRANDS_CLI_TEST_EXPORT_PATH}"`)
      await waitFor([`/export ${exportLanguage}`], 8_000, false, commandStart)
      const exportStart = transcript.length
      terminal.write('\r')
      await waitForStableScreen(['Export complete'], 30_000, exportStart)
      closeStart = transcript.length
      terminal.write('\u001b')
      await waitForStableScreen(['Enter to send'], 8_000, closeStart)
    } else if (lifecycleMode) {
      await submit(
        scenario === 'lifecycle-profile' ? 'report capabilities before export' : 'report capabilities after import',
        ['LOCAL_SKILL=true', 'REMOTE_SKILL=true']
      )
      if (scenario !== 'lifecycle-profile') {
        await submit('invoke the MCP probe after import', ['platform-mcp-ok'], scenario === 'lifecycle-setup-import')
      }
      const command = `/export ${exportLanguage} "${process.env.STRANDS_CLI_TEST_EXPORT_PATH}"`
      terminal.write(command)
      await waitFor([`/export ${exportLanguage}`], 2_000, false)
      const exportStart = transcript.length
      terminal.write('\r')
      await waitForStableScreen(['Export complete'], 15_000, exportStart)
      const closeStart = transcript.length
      terminal.write('\u001b')
      await waitForStableScreen(['Enter to send'], 8_000, closeStart)
    } else if (exportFailureMode) {
      const command = `/export typescript "${process.env.STRANDS_CLI_TEST_EXPORT_PATH}"`
      terminal.write(command)
      await waitFor(['/export typescript'], 2_000, false)
      const failureStart = transcript.length
      terminal.write('\r')
      await waitForStableScreen(['file already exists'], 15_000, failureStart)
      const closeStart = transcript.length
      terminal.write('\u001b')
      await waitForStableScreen(['Enter to send'], 8_000, closeStart)
    } else if (followUpMode) {
      for (const [prompt, reply] of [
        ['first turn', 'Fixture turn 1'],
        ['second turn', 'Fixture turn 2'],
      ]) {
        const start = transcript.length
        terminal.write(prompt)
        await waitFor([prompt], 2_000, false)
        terminal.write('\r')
        await waitFor([reply, '__CHAT_IDLE__'], 8_000, false, start)
      }
    } else if (approvalMode) {
      terminal.write('request approval')
      await waitFor(['request approval'], 2_000, false)
      terminal.write('\r')
      await waitFor(['Allow once'], 8_000, false)
      terminal.write('\r')
      await waitFor(['Approval accepted', '__CHAT_IDLE__'], 8_000, false)
    } else if (setupExportMode) {
      await typeInComposer('/setup')
      terminal.write('\r')
      await waitFor(['__SETUP_REQUESTED__'], 8_000, false)
      const command = `/export typescript ${process.env.STRANDS_CLI_TEST_EXPORT_PATH}`
      terminal.write(command)
      await waitFor(['/export typescript'], 2_000, false)
      const exportStart = transcript.length
      terminal.write('\r')
      await waitForStableScreen(['Export complete'], 8_000, exportStart)
      const closeStart = transcript.length
      terminal.write('\u001b')
      await waitForStableScreen(['Enter to send'], 8_000, closeStart)
    } else if (panelsMode) {
      for (const [command, markers, tabMarker] of [
        ['/help', ['Send a message', 'Search help', '› Controls'], undefined],
        ['/agents', ['Agents', 'Current', 'idle', '1/1', 'Enter switch'], undefined],
        ['/mcp', ['fixture-mcp', 'failed', 'Server is not accepting connections', '→ details', 'R retry'], undefined],
        ['/model', ['Fixture Model Alpha', 'Fixture Model Beta'], '› Fixture Model Alpha'],
        ['/effort', ['Reasoning effort', 'Medium'], undefined],
        ['/tasks', ['Search tasks', 'Fixture background task', 'completed', 'Enter open'], undefined],
        ['/settings', ['Appearance', 'Auto-Discovery'], '› Theme'],
        ['/permissions', ['Permissions', 'Search tools', 'Ask', 'Bypass', 'Custom', 'Custom to edit'], undefined],
        ['/voice', ['Off', 'On', 'Speaker', 'Nova', 'OpenAI', 'Nova 2.5 Sonic', 'tiffany', 'Space mute'], '› Provider'],
        ['/export', ['Export Lifecycle Fixture', 'Python', 'TypeScript'], undefined],
        [
          '/sessions ',
          ['Directories', 'Sessions', 'Search sessions', '# messages', 'Fixture Session'],
          '› Fixture Session',
        ],
      ]) {
        const start = transcript.length
        terminal.write(command)
        // The restored model footer can contain "/model"; wait for the composer cursor.
        await waitFor([`${command}▌`], 2_000, false, start)
        terminal.write('\r')
        await waitFor(markers, 8_000, false, start)
        if (command === '/agents') {
          for (const [columns, height] of [
            [40, 16],
            [22, 10],
            [100, 30],
          ]) {
            const resizeStart = transcript.length
            resizeTerminal(columns, height)
            await waitForStableScreen(['Agents', '1/1', columns < 30 ? 'Arrows' : 'Enter switch'], 8_000, resizeStart)
          }
          const chatStart = transcript.length
          terminal.write('\r')
          await waitFor(['Enter to send'], 8_000, false, chatStart)
          const agentsStart = transcript.length
          terminal.write('/agents')
          await waitFor(['/agents▌'], 2_000, false, agentsStart)
          terminal.write('\r')
          await waitFor(markers, 8_000, false, agentsStart)
        }
        if (command === '/help') {
          const tabStart = transcript.length
          terminal.write('\t')
          await waitFor(['› Send a message'], 8_000, false, tabStart)
          const detailStart = transcript.length
          terminal.write('\r')
          await waitFor(['Send your message', 'scroll'], 8_000, false, detailStart)
          const helpStart = transcript.length
          terminal.write('\u001b')
          await waitFor(['Search help', '› Send a message'], 8_000, false, helpStart)
        }
        if (command === '/mcp') {
          const detailStart = transcript.length
          terminal.write('\u001b[C')
          await waitFor(
            ['MCP: fixture-mcp', 'Problem', 'Next step', 'Check that the server is running'],
            8_000,
            false,
            detailStart
          )
          const errorStart = transcript.length
          terminal.write('\u001b[F')
          await waitFor(
            ['/tmp/fixture-mcp.json', 'Full error', 'connect ECONNREFUSED 127.0.0.1:43123'],
            8_000,
            false,
            errorStart
          )
          const listStart = transcript.length
          terminal.write('\u001b')
          await waitFor(['MCP servers (1)', 'R retry'], 8_000, false, listStart)
          const retryStart = transcript.length
          terminal.write('R')
          await waitFor(['fixture-mcp', 'connected', '1 tools'], 8_000, false, retryStart)
        }
        if (command === '/sessions ') {
          terminal.write('\u001b[B')
          await waitFor(['1 / 2'], 8_000, false, start)
        }
        if (command === '/export') {
          const exportStart = transcript.length
          const selectedStyle = screen.locate('Python').style
          terminal.write('\t')
          await waitForStyle('TypeScript', selectedStyle)
          terminal.write('\r')
          await waitFor(['Name exported folder'], 8_000, false, exportStart)
          terminal.write('\r')
          await waitFor(['Save TypeScript copy'], 8_000, false, exportStart)
          const nameStart = transcript.length
          terminal.write('\u001b')
          await waitFor(['Name exported folder'], 8_000, false, nameStart)
          const exportReturnStart = transcript.length
          terminal.write('\u001b')
          await waitFor(['Export Lifecycle Fixture'], 8_000, false, exportReturnStart)
        }
        if (tabMarker) {
          const tabStart = transcript.length
          terminal.write('\t')
          await waitFor([tabMarker], 8_000, false, tabStart)
        }
        const closeStart = transcript.length
        terminal.write('\u001b')
        await waitForStableScreen(['Enter to send'], 8_000, closeStart)
      }
    } else if (shellMode === 'command') {
      const input = windows
        ? "!1..4 | ForEach-Object { '__SHELL_LINE_' + $_ + '__' }"
        : "!printf '__SHELL_LINE_%s__\\n' 1 2 3 4"
      terminal.write(input)
      await waitFor([`${input}▌`], 2_000, false)
      terminal.write('\r')
      await waitFor(['__SHELL_LINE_1__', '__SHELL_LINE_4__', '__SHELL_IDLE__'], windows ? 15_000 : 8_000, false)
    } else if (shellMode === 'interrupt') {
      terminal.write('!sleep 30')
      await waitFor(['!sleep 30'], 2_000, false)
      terminal.write('\r')
      await waitFor(['Shell sleep 30'], 8_000, false)
      terminal.write('\u0003')
      await waitFor(['Cancelled', '__SHELL_IDLE__'], 4_000, false)
    }

    if (scenario.startsWith('exit-')) {
      terminal.write('\u0018')
    } else {
      const draft = startupTyping ? 'startup draft' : 'junk'
      const draftStart = transcript.length
      terminal.write(draft)
      await waitFor([draft], 2_000, false, draftStart)
      terminal.write('\u007f'.repeat(draft.length) + '/exit')
      await waitFor(['/exit▌'], 2_000, false)
      terminal.write('\r')
    }
    await waitForExit()
    await drainScreen(Date.now() + 1_000)
    if (statePath) {
      // The output socket can close before the native wrapper finishes checking input.
      const deadline = Date.now() + 8_000
      while (!existsSync(statePath)) {
        if (Date.now() >= deadline) {
          throw new Error(`missing native input report; returnCode=${returnCode}; output=${transcript}`)
        }
        await sleep(25)
      }
      const result = JSON.parse(readFileSync(statePath, 'utf8'))
      if (result.error) throw new Error(`native input check failed: ${result.error}; output=${transcript}`)
      returnCode = result.exitCode
      inputModeRestored = result.inputModeRestored
    }

    await writeStdout(
      JSON.stringify({
        returnCode,
        inputModeRestored,
        terminalModes: screen.terminal.modes,
        transcript: Buffer.from(transcript).toString('base64'),
        screens,
        resizeScreens,
        exportSaved: existsSync(process.env.STRANDS_CLI_TEST_EXPORT_PATH),
      })
    )
  } catch (error) {
    if (returnCode === undefined || (statePath && !existsSync(statePath))) {
      terminal.kill()
      await Promise.race([exited, sleep(1_000)])
    }
    throw error
  } finally {
    dataSubscription.dispose()
    exitSubscription.dispose()
    await Promise.race([screenWrites, sleep(1_000)])
    screen.dispose()
    if (statePath) {
      rmSync(statePath, { force: true })
      rmSync(`${statePath}.tmp`, { force: true })
    }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () => process.exit(1))
  }
)
