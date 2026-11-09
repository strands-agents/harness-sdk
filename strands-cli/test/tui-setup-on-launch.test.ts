import { afterEach, expect, it, vi } from 'vitest'

import { main } from '../src/cli/run.js'
import { SETUP_VERSION, CliConfigStore } from '../src/tui/config.js'
import { parseSettings } from '../src/tui/settings.js'

const runInkChat = vi.hoisted(() => vi.fn(async () => 0))
vi.mock('../src/tui/terminal/ink.js', () => ({}))
vi.mock('../src/tui/run.js', () => ({ runInkChat }))

afterEach(() => {
  vi.restoreAllMocks()
  runInkChat.mockClear()
  process.exitCode = undefined
})

it.each([
  { name: 'configured default', settings: {}, onboardingVersion: SETUP_VERSION, args: [], expected: false },
  {
    name: 'saved setup preference',
    settings: { setupOnLaunch: true },
    onboardingVersion: SETUP_VERSION,
    args: [],
    expected: false,
  },
  {
    name: 'first launch',
    settings: {},
    onboardingVersion: 0,
    args: [],
    expected: true,
  },
  {
    name: 'explicit setup',
    settings: {},
    onboardingVersion: SETUP_VERSION,
    args: ['--setup'],
    expected: true,
  },
  {
    name: 'explicit agent',
    settings: {},
    onboardingVersion: 0,
    args: ['--agent', './agent.ts'],
    expected: false,
  },
  {
    name: 'explicit setup and agent',
    settings: {},
    onboardingVersion: 0,
    args: ['--setup', '--agent', './agent.ts'],
    expected: true,
  },
  {
    name: 'saved agent',
    settings: {},
    onboardingVersion: 0,
    agentProject: './agent.ts',
    args: [],
    expected: false,
  },
  {
    name: 'explicit setup and saved agent',
    settings: {},
    onboardingVersion: 0,
    agentProject: './agent.ts',
    args: ['--setup'],
    expected: true,
  },
])('selects startup setup for $name', async (testCase) => {
  const { settings, onboardingVersion, args, expected } = testCase
  const config = CliConfigStore.memory({}, parseSettings(settings, 'test/config.json'), { onboardingVersion })
  if ('agentProject' in testCase) {
    vi.spyOn(config, 'snapshot').mockReturnValue({ ...config.snapshot(), agentProject: testCase.agentProject })
  }
  vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config)
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
