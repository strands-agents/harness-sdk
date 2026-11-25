import { sendTelemetryPing, telemetryEnabled } from '../cli/telemetry.js'
import { CliConfigStore } from '../config/store.js'
import { readCliVersion } from '../package-version.js'

export const DEV_TELEMETRY_ENDPOINT = 'https://telemetry.strandsagents.com/strands-dev/ping'

/** Funnel steps only: which stages of the dev workflow get used, never what they contained. */
export type DevTelemetryEvent =
  | 'dev_launch'
  | 'ask_shown'
  | 'ask_answered'
  | 'ask_cancelled'
  | 'optimize_run_started'
  | 'optimize_run_finished'
  | 'optimize_edits_applied'
  | 'evals_ui_opened'
  | 'experiment_created'
  | 'evaluation_started'

export type DevHarnessKind = 'base-cli' | 'typescript' | 'python'

export interface DevTelemetryPing {
  v: 1
  event: 'step/1'
  context: { cli_version: string; harness: DevHarnessKind }
  data: { step: DevTelemetryEvent }
}

interface DevTelemetryState {
  readonly enabled: boolean
  readonly harness: DevHarnessKind
}

let state: DevTelemetryState | undefined

/** Set once per dev launch; without it, or with telemetry off, every record call is a no-op. */
export const configureDevTelemetry = (next: DevTelemetryState | undefined): void => {
  state = next
}

export const devTelemetryPing = (step: DevTelemetryEvent, harness: DevHarnessKind): DevTelemetryPing => ({
  v: 1,
  event: 'step/1',
  context: { cli_version: readCliVersion(), harness },
  data: { step },
})

export const recordDevEvent = (event: DevTelemetryEvent): void => {
  if (!state?.enabled) return
  void sendTelemetryPing(devTelemetryPing(event, state.harness), {
    endpoint: process.env.STRANDS_DEV_TELEMETRY_ENDPOINT ?? DEV_TELEMETRY_ENDPOINT,
  })
}

export const savedTelemetryChoice = async (config: CliConfigStore, env = process.env): Promise<boolean> => {
  const { path, settings } = config.snapshot()
  if (path === 'in-memory') return telemetryEnabled(settings, env)
  return telemetryEnabled((await CliConfigStore.load(path, { persist: false })).snapshot().settings, env)
}
