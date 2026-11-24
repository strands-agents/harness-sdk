import { afterEach, describe, expect, it, vi } from 'vitest'

import { configureDevTelemetry, recordDevEvent } from '../../src/dev/telemetry.js'
import * as telemetry from '../../src/cli/telemetry.js'

afterEach(() => configureDevTelemetry(undefined))

describe('dev telemetry', () => {
  it('shouldSendAnEnumOnlyPingWhenConfiguredOn', () => {
    const send = vi.spyOn(telemetry, 'sendTelemetryPing').mockResolvedValue(undefined)
    configureDevTelemetry({ enabled: true, harness: 'base-cli' })

    recordDevEvent('optimize_run_started')

    expect(send).toHaveBeenCalledWith({
      v: 1,
      kind: 'dev',
      event: 'optimize_run_started',
      cli_version: expect.any(String),
      harness: 'base-cli',
    })
    send.mockRestore()
  })

  it.each([
    ['off', { enabled: false, harness: 'typescript' as const }],
    ['unconfigured', undefined],
  ])('shouldSendNothingWhenTelemetryIs%s', (_name, state) => {
    const send = vi.spyOn(telemetry, 'sendTelemetryPing').mockResolvedValue(undefined)
    configureDevTelemetry(state)

    recordDevEvent('ask_shown')

    expect(send).not.toHaveBeenCalled()
    send.mockRestore()
  })
})
