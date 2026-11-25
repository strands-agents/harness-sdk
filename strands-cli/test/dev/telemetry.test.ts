import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { URL } from 'node:url'
import { stringify } from 'smol-toml'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  configureDevTelemetry,
  DEV_TELEMETRY_ENDPOINT,
  devTelemetryPing,
  recordDevEvent,
  savedTelemetryChoice,
  type DevHarnessKind,
  type DevTelemetryEvent,
} from '../../src/dev/telemetry.js'
import * as telemetry from '../../src/cli/telemetry.js'
import { CliConfigStore } from '../../src/config/store.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

interface SchemaNode {
  type?: string
  enum?: readonly unknown[]
  pattern?: string
  required?: readonly string[]
  properties?: Readonly<Record<string, SchemaNode>>
  additionalProperties?: boolean
}

const SCHEMA = JSON.parse(
  readFileSync(new URL('../fixtures/strands-dev-telemetry.schema.json', import.meta.url), 'utf8')
) as SchemaNode

const matchesType = (value: unknown, type: string | undefined): boolean => {
  if (type === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value)
  if (type === 'integer') return Number.isInteger(value)
  return type === undefined || typeof value === type
}

const violations = (value: unknown, node: SchemaNode, at = 'ping'): string[] => {
  if (!matchesType(value, node.type)) return [`${at}: type`]
  if (node.enum && !node.enum.includes(value)) return [`${at}: enum`]
  if (node.pattern && !new RegExp(node.pattern, 'u').test(String(value))) return [`${at}: pattern`]
  if (node.type !== 'object') return []
  const record = value as Record<string, unknown>
  const properties = node.properties ?? {}
  return [
    ...(node.required ?? []).filter((key) => !(key in record)).map((key) => `${at}.${key}: required`),
    ...Object.keys(record)
      .filter((key) => node.additionalProperties === false && !(key in properties))
      .map((key) => `${at}.${key}: additional`),
    ...Object.entries(properties).flatMap(([key, child]) =>
      key in record ? violations(record[key], child, `${at}.${key}`) : []
    ),
  ]
}

const STEPS: readonly DevTelemetryEvent[] = [
  'dev_launch',
  'ask_shown',
  'ask_answered',
  'ask_cancelled',
  'optimize_run_started',
  'optimize_run_finished',
  'optimize_edits_applied',
  'evals_ui_opened',
  'experiment_created',
  'evaluation_started',
]
const HARNESSES: readonly DevHarnessKind[] = ['base-cli', 'typescript', 'python']

afterEach(() => {
  configureDevTelemetry(undefined)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('dev telemetry', () => {
  it('shouldSendTheStepToTheStrandsDevRouteWhenConfiguredOn', () => {
    const send = vi.spyOn(telemetry, 'sendTelemetryPing').mockResolvedValue(undefined)
    configureDevTelemetry({ enabled: true, harness: 'base-cli' })

    recordDevEvent('optimize_run_started')

    expect(send).toHaveBeenCalledWith(
      {
        v: 1,
        event: 'step/1',
        context: { cli_version: expect.any(String), harness: 'base-cli' },
        data: { step: 'optimize_run_started' },
      },
      { endpoint: DEV_TELEMETRY_ENDPOINT }
    )
    expect(DEV_TELEMETRY_ENDPOINT).toBe('https://telemetry.strandsagents.com/strands-dev/ping')
  })

  it('shouldSendToTheEndpointThatTheEnvironmentNames', () => {
    const send = vi.spyOn(telemetry, 'sendTelemetryPing').mockResolvedValue(undefined)
    vi.stubEnv('STRANDS_DEV_TELEMETRY_ENDPOINT', 'http://127.0.0.1:9/strands-dev/ping')
    configureDevTelemetry({ enabled: true, harness: 'python' })

    recordDevEvent('dev_launch')

    expect(send).toHaveBeenCalledWith(expect.anything(), { endpoint: 'http://127.0.0.1:9/strands-dev/ping' })
  })

  it.each([
    ['off', { enabled: false, harness: 'typescript' as const }],
    ['unconfigured', undefined],
  ])('shouldSendNothingWhenTelemetryIs%s', (_name, state) => {
    const send = vi.spyOn(telemetry, 'sendTelemetryPing').mockResolvedValue(undefined)
    configureDevTelemetry(state)

    recordDevEvent('ask_shown')

    expect(send).not.toHaveBeenCalled()
  })

  it.each(STEPS.flatMap((step) => HARNESSES.map((harness) => [step, harness] as const)))(
    'shouldMatchTheSchemaOfTheStrandsDevTenantFor %s on %s',
    (step, harness) => {
      expect(violations(devTelemetryPing(step, harness), SCHEMA)).toEqual([])
    }
  )

  it('shouldRejectThePingShapeThatTheRootRouteGotBefore', () => {
    const before = { v: 1, kind: 'dev', event: 'dev_launch', cli_version: '0.4.0', harness: 'python' }

    expect(violations(before, SCHEMA)).toEqual(
      expect.arrayContaining(['ping.context: required', 'ping.data: required', 'ping.kind: additional'])
    )
  })
})

describe('savedTelemetryChoice', () => {
  const savedConfig = async (settings: Record<string, unknown>): Promise<CliConfigStore> => {
    const path = join(await temporaryDirectory(), 'cli.toml')
    await writeFile(path, stringify({ settings }))
    const config = await CliConfigStore.load(path, { persist: false })
    await config.setSettings({ telemetry: false })
    return config
  }

  it.each([
    ['on', { telemetry: true }, {}, true],
    ['off', { telemetry: false }, {}, false],
    ['on but DO_NOT_TRACK is set', { telemetry: true }, { DO_NOT_TRACK: '1' }, false],
    ['on but STRANDS_CLI_TELEMETRY is 0', { telemetry: true }, { STRANDS_CLI_TELEMETRY: '0' }, false],
  ])('shouldFollowTheSavedChoiceAndNotTheDevSessionWhenTheSavedChoiceIs %s', async (_name, settings, env, expected) => {
    const config = await savedConfig(settings)

    expect(config.snapshot().settings.telemetry).toBe(false)
    expect(await savedTelemetryChoice(config, env)).toBe(expected)
  })
})
