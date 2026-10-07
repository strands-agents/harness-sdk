#!/usr/bin/env node

import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { setTimeout } from 'node:timers'
import nodePty from 'node-pty'

const ANSI_ESCAPE = new RegExp(String.raw`\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))`, 'gu')
const CHAT_READY = '\u001b[?1002l\u001b[?1003h'
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
    await waitFor(['Enter to send', CHAT_READY])

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

    if (chatMode) {
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
      for (const [command, markers] of [
        ['/help', ['Send a message']],
        ['/model', ['Fixture Model Alpha', 'Fixture Model Beta']],
        ['/effort', ['Reasoning effort', 'Medium']],
        ['/settings', ['Appearance', 'Auto-Discovery']],
      ]) {
        const start = transcript.length
        terminal.write(command)
        await waitFor([command], 2_000, false, start)
        terminal.write('\r')
        await waitFor(markers, 8_000, false, start)
        terminal.write('\u001b')
        await sleep(200)
      }
    } else if (frogMode) {
      terminal.write('/frog peek')
      await waitFor(['/frog peek'], 2_000, false)
      terminal.write('\r')
      await waitFor(['▗▄▄▖'], 2_000, false)
    } else if (shellMode === 'command') {
      const input = "!printf '__SHELL_LINE_1__\\n__SHELL_LINE_2__\\n__SHELL_LINE_3__\\n__SHELL_LINE_4__\\n'"
      terminal.write(input)
      await waitFor(['◆ shell !printf'], 2_000, false)
      await sleep(200)
      terminal.write('\r')
      await waitFor(['__SHELL_LINE_1__', '__SHELL_LINE_4__', '__SHELL_IDLE__'], 8_000, false)
    } else if (shellMode === 'interrupt') {
      terminal.write('!sleep 30')
      await waitFor(['◆ shell !sleep'], 2_000, false)
      await sleep(200)
      terminal.write('\r')
      await waitFor(['shell sleep 30'], 8_000, false)
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
