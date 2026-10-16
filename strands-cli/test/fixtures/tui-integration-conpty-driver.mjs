#!/usr/bin/env node

import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { setTimeout } from 'node:timers'
import nodePty from 'node-pty'

const ANSI_ESCAPE = new RegExp(String.raw`\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))`, 'gu')
// ChatApp enables bracketed paste after attaching its keyboard input handler.
const CHAT_READY = '\u001b[?2004h'
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command) {
    throw new Error('missing TUI child command')
  }

  const scenario = process.env.STRANDS_CLI_TEST_SCENARIO ?? 'exit'
  const shellMode = { 'shell-command': 'command', 'shell-interrupt': 'interrupt' }[scenario]
  const frogMode = scenario === 'frog'
  const chatMode = scenario === 'chat'
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
  let returnCode
  let resolveExit
  const exited = new Promise((resolve) => {
    resolveExit = resolve
  })
  const terminal = nodePty.spawn(command, args, {
    name: 'xterm-256color',
    cols: 100,
    rows,
    cwd: process.cwd(),
    env: { ...process.env, CI: 'false', TERM: 'xterm-256color' },
    useConpty: true,
  })
  const dataSubscription = terminal.onData((data) => {
    transcript += data
  })
  const exitSubscription = terminal.onExit(({ exitCode }) => {
    returnCode = exitCode
    resolveExit()
  })

  const waitFor = async (markers, timeout = 8_000, styled = true, start = 0) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const output = styled ? transcript.slice(start) : transcript.slice(start).replace(ANSI_ESCAPE, '')
      if (markers.every((marker) => output.includes(marker))) {
        return
      }
      if (returnCode !== undefined) {
        break
      }
      await sleep(25)
    }
    const output = styled ? transcript.slice(start) : transcript.slice(start).replace(ANSI_ESCAPE, '')
    const missing = markers.filter((marker) => !output.includes(marker))
    throw new Error(`missing markers ${JSON.stringify(missing)}; returncode=${returnCode}; output=${transcript}`)
  }
  const settle = async (timeout = 150) => {
    let deadline = Date.now() + timeout
    let length = transcript.length
    while (Date.now() < deadline) {
      await sleep(25)
      if (transcript.length !== length) {
        length = transcript.length
        deadline = Date.now() + timeout
      }
    }
  }
  const waitForExit = async (timeout = 8_000) => {
    await Promise.race([
      exited,
      sleep(timeout).then(() => {
        if (returnCode === undefined) {
          throw new Error(`process did not exit; output=${transcript}`)
        }
      }),
    ])
  }

  let resizeOutput = ''
  let burstOutput = ''
  let noopOutput = ''
  try {
    if (setupImportMode) {
      await waitFor(['Quickstart', 'Import'], 20_000, false)
    } else {
      await waitFor(['Enter to send', CHAT_READY], liveMode ? 90_000 : lifecycleMode ? 20_000 : 8_000)
    }

    if (resize) {
      const start = transcript.length
      for (const [columns, height] of [
        [80, 24],
        [40, 16],
        [22, 10],
        [160, 50],
        [160, 25],
        [100, 30],
      ]) {
        const offset = transcript.length
        terminal.resize(columns, height)
        await waitFor(['\u001b[1;1H'], 2_000, true, offset)
      }
      resizeOutput = transcript.slice(start)

      const burstStart = transcript.length
      for (const [columns, height] of [
        [70, 25],
        [50, 18],
        [120, 40],
      ]) {
        terminal.resize(columns, height)
      }
      await waitFor(['\u001b[1;1H'], 2_000, true, burstStart)
      await settle()
      burstOutput = transcript.slice(burstStart)

      const noopStart = transcript.length
      terminal.resize(120, 40)
      await settle(200)
      noopOutput = transcript.slice(noopStart)
    }

    const exportLanguage = process.env.STRANDS_CLI_TEST_EXPORT_LANGUAGE ?? 'typescript'
    const submit = async (prompt, markers, approve = false) => {
      const start = transcript.length
      terminal.write(prompt)
      await waitFor([`${prompt}▌`], 2_000, false, start)
      terminal.write('\r')
      if (approve) {
        await waitFor(['Enter choose'], 8_000, false, start)
        terminal.write('\r')
      }
      await waitFor(
        [...markers, ...(exportLanguage === 'typescript' ? ['__PLATFORM_IDLE__'] : [])],
        15_000,
        false,
        start
      )
      await settle()
    }

    if (setupImportMode) {
      terminal.write('\u001b[B')
      await sleep(200)
      terminal.write('\u001b[C')
      await sleep(200)
      terminal.write('\r')
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
      terminal.write('\u001b[Z')
      await sleep(200)
      const launchStart = transcript.length
      terminal.write('\r')
      await waitFor(['Enter to send', CHAT_READY], 30_000, true, launchStart)
    }

    if (liveMode) {
      let generation = 1
      let turns = 0
      const liveSubmit = async (prompt, idleGeneration, idleTurns) => {
        const start = transcript.length
        terminal.write(prompt)
        await waitFor([prompt.slice(0, 40)], 5_000, false, start)
        terminal.write('\r')
        await waitFor([`__LIVE_IDLE_${idleGeneration}_${idleTurns}__`], 150_000, true, start)
        await settle()
      }
      if (process.env.STRANDS_CLI_TEST_SETUP_PROMPT) {
        generation = 2
        turns = 1
        await liveSubmit(process.env.STRANDS_CLI_TEST_SETUP_PROMPT, generation, turns)
      }
      await liveSubmit(process.env.STRANDS_CLI_TEST_USE_PROMPT, generation, turns + 1)
      terminal.write(`/config ${exportLanguage}`)
      await sleep(200)
      const configStart = transcript.length
      terminal.write('\r')
      await waitFor(['TypeScript'], 8_000, false, configStart)
      await settle()
      let closeStart = transcript.length
      terminal.write('\u001b')
      await waitFor(['Enter to send'], 8_000, false, closeStart)
      const commandStart = transcript.length
      terminal.write(`/export ${exportLanguage} "${process.env.STRANDS_CLI_TEST_EXPORT_PATH}"`)
      await waitFor([`/export ${exportLanguage}`], 8_000, false, commandStart)
      const exportStart = transcript.length
      terminal.write('\r')
      await waitFor(['Export complete'], 30_000, false, exportStart)
      closeStart = transcript.length
      terminal.write('\u001b')
      await waitFor(['Enter to send'], 8_000, false, closeStart)
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
      await sleep(200)
      terminal.write('\r')
      await waitFor(['Export complete'], 15_000, false)
      terminal.write('\u001b')
      await sleep(200)
    } else if (exportFailureMode) {
      const command = `/export typescript "${process.env.STRANDS_CLI_TEST_EXPORT_PATH}"`
      terminal.write(command)
      await waitFor(['/export typescript'], 2_000, false)
      await sleep(200)
      terminal.write('\r')
      await waitFor(['file already exists'], 15_000, false)
      terminal.write('\u001b')
      await sleep(200)
    } else if (chatMode) {
      terminal.write('hello from integration')
      await waitFor(['hello from integration'], 2_000, false)
      terminal.write('\r')
      await waitFor(['Fixture reply', '__CHAT_IDLE__'], 8_000, false)
    } else if (followUpMode) {
      for (const [prompt, reply] of [
        ['first turn', 'Fixture turn 1'],
        ['second turn', 'Fixture turn 2'],
      ]) {
        terminal.write(prompt)
        await waitFor([prompt], 2_000, false)
        terminal.write('\r')
        await waitFor([reply, '__CHAT_IDLE__'], 8_000, false)
      }
    } else if (approvalMode) {
      terminal.write('request approval')
      await waitFor(['request approval'], 2_000, false)
      await sleep(200)
      terminal.write('\r')
      await waitFor(['Allow once'], 8_000, false)
      terminal.write('\r')
      await waitFor(['Approval accepted', '__CHAT_IDLE__'], 8_000, false)
    } else if (setupExportMode) {
      terminal.write('/setup')
      await waitFor(['/setup'], 2_000, false)
      await sleep(200)
      terminal.write('\r')
      await waitFor(['__SETUP_REQUESTED__'], 8_000, false)
      const command = `/export typescript ${process.env.STRANDS_CLI_TEST_EXPORT_PATH}`
      terminal.write(command)
      await waitFor(['/export typescript'], 2_000, false)
      await sleep(200)
      terminal.write('\r')
      await waitFor(['Export complete'], 8_000, false)
      terminal.write('\u001b')
      await sleep(200)
    } else if (panelsMode) {
      for (const [command, markers, tabMarker] of [
        ['/help', ['Send a message', 'Search help', 'Controls'], undefined],
        ['/agents', ['Agents', 'Current', 'idle', '1/1', 'Enter switch'], undefined],
        ['/mcp', ['fixture-mcp', 'failed', 'Server is not accepting connections', '→ details', 'R retry'], undefined],
        ['/model', ['Fixture Model Alpha', 'Fixture Model Beta'], '› Fixture Model Alpha'],
        ['/effort', ['Reasoning effort', 'Medium'], undefined],
        [
          '/tasks',
          [
            'Behavior',
            'Wait for completion',
            'Search tasks',
            'Fixture background task',
            'completed',
            'Enter open/toggle',
          ],
          undefined,
        ],
        ['/settings', ['Appearance', 'Auto-Discovery'], '› Theme'],
        ['/permissions', ['Permissions', 'Search tools', 'Ask', 'Bypass', 'Custom', 'Custom to edit'], undefined],
        [
          '/voice',
          ['Off', 'On', 'Spoken replies', 'Speaker', 'Nova', 'OpenAI', 'Nova 2.5 Sonic', 'tiffany', 'Space mute'],
          '› Provider',
        ],
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
            terminal.resize(columns, height)
            await waitFor(['Agents', '1/1'], 8_000, false, resizeStart)
            await settle()
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
          await sleep(200)
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
          terminal.write('\t')
          await sleep(200)
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
        terminal.write('\u001b')
        await sleep(200)
      }
    } else if (frogMode) {
      terminal.write('/frog peek')
      await waitFor(['/frog peek'], 2_000, false)
      terminal.write('\r')
      await waitFor(['▗▄▄▖'], 2_000, false)
    } else if (shellMode === 'command') {
      const input = "!Write-Output '__SHELL_LINE_1__','__SHELL_LINE_2__','__SHELL_LINE_3__','__SHELL_LINE_4__'"
      terminal.write(input)
      await waitFor(["!Write-Output '__SHELL_LINE_1__"], 2_000, false)
      await sleep(200)
      terminal.write('\r')
      await waitFor(['__SHELL_LINE_1__', '__SHELL_LINE_4__', '__SHELL_IDLE__'], 8_000, false)
    } else if (shellMode === 'interrupt') {
      terminal.write('!sleep 30')
      await waitFor(['!sleep 30'], 2_000, false)
      await sleep(200)
      terminal.write('\r')
      await waitFor(['Shell sleep 30'], 8_000, false)
      await sleep(200)
      terminal.write('\u0003')
      await waitFor(['Cancelled', '__SHELL_IDLE__'], 4_000, false)
    }

    const draft = startupTyping ? 'startup draft' : 'junk'
    terminal.write(draft)
    await waitFor([draft], 2_000, false)
    for (const keypress of [...draft].map(() => '\u007f').concat('/exit')) {
      terminal.write(keypress)
      await sleep(50)
    }
    await waitFor(['/exit'], 2_000, false)
    await sleep(200)
    terminal.write('\r')
    await waitForExit()
    await settle(50)

    process.stdout.write(
      JSON.stringify({
        returnCode,
        termiosRestored: null,
        transcript: Buffer.from(transcript).toString('base64'),
        resizeTranscript: Buffer.from(resizeOutput).toString('base64'),
        resizeBurstTranscript: Buffer.from(burstOutput).toString('base64'),
        resizeNoopTranscript: Buffer.from(noopOutput).toString('base64'),
        exportSaved: existsSync(process.env.STRANDS_CLI_TEST_EXPORT_PATH),
      })
    )
  } catch (error) {
    if (returnCode === undefined) {
      terminal.kill()
      await Promise.race([exited, sleep(1_000)])
    }
    throw error
  } finally {
    dataSubscription.dispose()
    exitSubscription.dispose()
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
