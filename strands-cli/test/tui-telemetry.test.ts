import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_AGENT_CONFIG, type HarnessAgentConfig } from '@strands-agents/harness'

import { enabledProfileTools } from '../src/tui/builtin-tools.js'
import { DEFAULT_CHAT_SETTINGS, parseSettings, parseSettingUpdate } from '../src/tui/settings.js'
import { buildTelemetryPing, sendTelemetryPing, telemetryEnabled, TELEMETRY_ENDPOINT } from '../src/tui/telemetry.js'

const profile: HarnessAgentConfig = { ...DEFAULT_HARNESS_AGENT_CONFIG, model: 'anthropic/claude-sonnet-4-5' }

afterEach(() => vi.restoreAllMocks())

describe('buildTelemetryPing', () => {
  it('reports only the version, provider, and built-in names', () => {
    expect(buildTelemetryPing(profile, '1.2.3')).toEqual({
      v: 1,
      cli_version: '1.2.3',
      provider: 'anthropic',
      builtin_tools: enabledProfileTools(DEFAULT_HARNESS_AGENT_CONFIG.builtinTools),
      builtin_plugins: [...DEFAULT_HARNESS_AGENT_CONFIG.builtinPlugins],
    })
  })

  it('treats a bare model id as Bedrock', () => {
    expect(buildTelemetryPing({ ...profile, model: 'global.anthropic.claude-opus-4-8' }, '1.0.0').provider).toBe(
      'bedrock'
    )
  })

  it.each([
    ['a custom provider module', { ...profile, modelModule: { module: './model.ts' } }],
    ['an unknown provider prefix', { ...profile, model: 'acme/internal-llm' }],
  ])('omits the provider for %s', (_case, config) => {
    const ping = buildTelemetryPing(config as HarnessAgentConfig, '1.0.0')
    expect(ping).not.toHaveProperty('provider')
    expect(JSON.stringify(ping)).not.toContain('acme')
  })

  it('reads the CLI version from package.json by default', () => {
    expect(buildTelemetryPing(profile).cli_version).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('telemetryEnabled', () => {
  it('is on by default and off via the setting', () => {
    expect(telemetryEnabled(DEFAULT_CHAT_SETTINGS, {})).toBe(true)
    expect(telemetryEnabled({ telemetry: false }, {})).toBe(false)
  })

  it.each(['0', 'false', 'no', 'OFF', ' off '])('is off when STRANDS_CLI_TELEMETRY=%j', (value) => {
    expect(telemetryEnabled({ telemetry: true }, { STRANDS_CLI_TELEMETRY: value })).toBe(false)
  })

  it('ignores other STRANDS_CLI_TELEMETRY values', () => {
    expect(telemetryEnabled({ telemetry: true }, { STRANDS_CLI_TELEMETRY: '1' })).toBe(true)
  })

  it.each(['1', 'true', 'yes'])('honors DO_NOT_TRACK=%s', (value) => {
    expect(telemetryEnabled({ telemetry: true }, { DO_NOT_TRACK: value })).toBe(false)
  })

  it('ignores an empty or falsy DO_NOT_TRACK', () => {
    expect(telemetryEnabled({ telemetry: true }, { DO_NOT_TRACK: '' })).toBe(true)
    expect(telemetryEnabled({ telemetry: true }, { DO_NOT_TRACK: '0' })).toBe(true)
  })

  it('round-trips through the settings store and the /settings toggle', () => {
    expect(parseSettings({ telemetry: false }, 'config.json').telemetry).toBe(false)
    expect(parseSettings(undefined, 'config.json').telemetry).toBe(true)
    expect(() => parseSettings({ telemetry: 'yes' }, 'config.json')).toThrow('settings.telemetry must be a boolean')
    expect(parseSettingUpdate('telemetry', DEFAULT_CHAT_SETTINGS)).toEqual({ telemetry: false })
  })
})

describe('sendTelemetryPing', () => {
  const ping = buildTelemetryPing(profile, '1.0.0')

  it('POSTs JSON with a short timeout and no keep-alive', async () => {
    const fetch = vi.fn().mockResolvedValue(new globalThis.Response(null, { status: 204 }))
    const log = vi.fn()
    await sendTelemetryPing(ping, { fetch, log })
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(TELEMETRY_ENDPOINT)
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      redirect: 'error',
    })
    expect(JSON.parse(init.body)).toEqual(ping)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(log).toHaveBeenCalledWith('telemetry ping accepted')
  })

  it.each([400, 500])('resolves on a %i and only logs', async (status) => {
    const fetch = vi.fn().mockResolvedValue(new globalThis.Response('nope', { status }))
    const log = vi.fn()
    await expect(sendTelemetryPing(ping, { fetch, log })).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(`telemetry ping rejected (${status})`)
  })

  it('resolves when the network fails', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const log = vi.fn()
    await expect(sendTelemetryPing(ping, { fetch, log })).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith('telemetry ping failed: fetch failed')
  })

  it('resolves when fetch throws synchronously', async () => {
    const fetch = vi.fn(() => {
      throw new Error('boom')
    }) as unknown as typeof globalThis.fetch
    await expect(sendTelemetryPing(ping, { fetch })).resolves.toBeUndefined()
  })

  it('honors STRANDS_CLI_TELEMETRY_ENDPOINT', async () => {
    vi.stubEnv('STRANDS_CLI_TELEMETRY_ENDPOINT', 'http://127.0.0.1:9/ping')
    const fetch = vi.fn().mockResolvedValue(new globalThis.Response(null, { status: 204 }))
    await sendTelemetryPing(ping, { fetch })
    expect(fetch.mock.calls[0]![0]).toBe('http://127.0.0.1:9/ping')
    vi.unstubAllEnvs()
  })
})
