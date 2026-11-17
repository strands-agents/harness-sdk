import { afterEach, expect, it, vi } from 'vitest'

import { main } from '../../src/cli/run.js'
import { SETUP_VERSION, CliConfigStore } from '../../src/config/store.js'

const runInkChat = vi.hoisted(() => vi.fn(async () => 0))
vi.mock('../../src/terminal/ink.js', () => ({}))
vi.mock('../../src/ui/run.js', () => ({ runInkChat }))

afterEach(() => {
  vi.restoreAllMocks()
  runInkChat.mockClear()
  process.exitCode = undefined
})

it.each([
  { name: 'configured default', onboardingVersion: SETUP_VERSION, args: [], expected: false },
  {
    name: 'first launch',
    onboardingVersion: 0,
    args: [],
    expected: true,
  },
  {
    name: 'configured Bedrock first launch',
    onboardingVersion: 0,
    args: [],
    environment: { AWS_BEARER_TOKEN_BEDROCK: 'placeholder', AWS_REGION: 'us-west-2' },
    expected: false,
  },
  {
    name: 'Bedrock token without a region',
    onboardingVersion: 0,
    args: [],
    environment: { AWS_BEARER_TOKEN_BEDROCK: 'placeholder' },
    expected: true,
  },
  {
    name: 'configured Mantle bearer token',
    onboardingVersion: 0,
    args: ['--model', 'bedrock-mantle/openai.gpt-5'],
    environment: { AWS_BEARER_TOKEN_BEDROCK: 'placeholder', AWS_REGION: 'us-west-2' },
    expected: false,
  },
  {
    name: 'configured Mantle first launch',
    onboardingVersion: 0,
    args: ['--model', 'bedrock-mantle/openai.gpt-5'],
    environment: {
      AWS_ACCESS_KEY_ID: 'placeholder',
      AWS_SECRET_ACCESS_KEY: 'placeholder',
      AWS_REGION: 'us-west-2',
    },
    expected: false,
  },
  {
    name: 'configured model override',
    onboardingVersion: 0,
    args: ['--model', 'openai/test'],
    environment: { OPENAI_API_KEY: 'placeholder' },
    expected: false,
  },
  {
    name: 'configured portable model override',
    onboardingVersion: 0,
    args: ['--set', 'model=openai/test'],
    environment: { OPENAI_API_KEY: 'placeholder' },
    expected: false,
  },
  {
    name: 'unrelated provider credentials',
    onboardingVersion: 0,
    args: ['--model', 'anthropic/test'],
    environment: { OPENAI_API_KEY: 'placeholder' },
    expected: true,
  },
  {
    name: 'local model',
    onboardingVersion: 0,
    args: ['--model', 'ollama/test'],
    expected: false,
  },
  {
    name: 'explicit setup',
    onboardingVersion: SETUP_VERSION,
    args: ['--setup'],
    expected: true,
  },
  {
    name: 'explicit agent',
    onboardingVersion: 0,
    args: ['--agent', './agent.ts'],
    expected: false,
  },
  {
    name: 'explicit setup and agent',
    onboardingVersion: 0,
    args: ['--setup', '--agent', './agent.ts'],
    expected: true,
  },
  {
    name: 'saved agent',
    onboardingVersion: 0,
    agentProject: './agent.ts',
    args: [],
    expected: false,
  },
  {
    name: 'explicit setup and saved agent',
    onboardingVersion: 0,
    agentProject: './agent.ts',
    args: ['--setup'],
    expected: true,
  },
])('selects startup setup for $name', async (testCase) => {
  const { onboardingVersion, args, expected } = testCase
  const config = CliConfigStore.memory({}, {}, { onboardingVersion })
  vi.spyOn(config, 'providerEnvironment').mockReturnValue(
    Object.fromEntries(
      Object.entries(testCase.environment ?? {}).map(([key, value]) => [key, { value, source: 'process' }])
    )
  )
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
