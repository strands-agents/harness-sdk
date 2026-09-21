import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { main } from '../src/cli/run.js'
import { ChatController } from '../src/tui/chat/controller.js'
import { SETUP_VERSION, CliConfigStore } from '../src/tui/config.js'

const runInkChat = vi.hoisted(() => vi.fn(async () => 0))
vi.mock('../src/tui/run.js', () => ({ runInkChat }))

afterEach(() => {
  vi.restoreAllMocks()
  runInkChat.mockClear()
  process.exitCode = undefined
})

it.each([
  { name: 'configured default', settings: {}, onboardingVersion: SETUP_VERSION, args: [], expected: true },
  {
    name: 'configured opt-out',
    settings: { setupOnLaunch: false },
    onboardingVersion: SETUP_VERSION,
    args: [],
    expected: false,
  },
  {
    name: 'first launch with opt-out',
    settings: { setupOnLaunch: false },
    onboardingVersion: 0,
    args: [],
    expected: true,
  },
  {
    name: 'explicit setup with opt-out',
    settings: { setupOnLaunch: false },
    onboardingVersion: SETUP_VERSION,
    args: ['--setup'],
    expected: true,
  },
  {
    name: 'explicit agent',
    settings: {},
    onboardingVersion: SETUP_VERSION,
    args: ['--agent', './agent.ts'],
    expected: false,
  },
  {
    name: 'explicit setup and agent',
    settings: {},
    onboardingVersion: SETUP_VERSION,
    args: ['--setup', '--agent', './agent.ts'],
    expected: true,
  },
])('selects startup setup for $name', async ({ settings, onboardingVersion, args, expected }) => {
  vi.spyOn(CliConfigStore, 'load').mockResolvedValue(CliConfigStore.memory({}, {}, settings, { onboardingVersion }))
  const stdinIsTTY = process.stdin.isTTY
  const stdoutIsTTY = process.stdout.isTTY
  process.stdin.isTTY = true
  process.stdout.isTTY = true
  try {
    await main(args)
    expect(runInkChat).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ setup: expected }))
    expect(process.exitCode).toBe(0)
  } finally {
    process.stdin.isTTY = stdinIsTTY
    process.stdout.isTTY = stdoutIsTTY
  }
})

it('defaults existing configurations to on and persists the settings toggle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strands-setup-on-launch-'))
  try {
    const path = join(root, 'config.json')
    await writeFile(path, JSON.stringify({ onboarding: { version: SETUP_VERSION }, settings: { animations: false } }))
    let config = await CliConfigStore.load(path)
    const controller = new ChatController(
      {
        id: 'setup-settings-test',
        name: 'strands',
        protocol: 'strands',
        async *stream() {
          yield* []
          return { stopReason: 'endTurn' as const }
        },
        cancel() {},
      },
      { settings: config.snapshot().settings, setSettings: (settings) => config.setSettings(settings) }
    )
    try {
      await controller.submit('/settings')
      await controller.activatePanelRow({ label: 'General', description: '', value: 'settings:General' })
      const row = controller.getSnapshot().panel!.rows.find((candidate) => candidate.value === 'setupOnLaunch')!
      expect(row).toMatchObject({ label: 'Launch into Setup by default', control: { kind: 'toggle', checked: true } })
      expect(await controller.activatePanelRow(row)).toBe(true)
      config = await CliConfigStore.load(path)
      expect(config.snapshot().settings).toMatchObject({ setupOnLaunch: false, animations: false })
    } finally {
      await controller.dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
