import { sendTelemetryPing } from '../cli/telemetry.js'
import { readCliVersion } from '../package-version.js'

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

interface DevTelemetryState {
  readonly enabled: boolean
  readonly harness: DevHarnessKind
}

let state: DevTelemetryState | undefined

/** Set once per dev launch; without it, or with telemetry off, every record call is a no-op. */
export const configureDevTelemetry = (next: DevTelemetryState | undefined): void => {
  state = next
}

export const recordDevEvent = (event: DevTelemetryEvent): void => {
  if (!state?.enabled) return
  void sendTelemetryPing({ v: 1, kind: 'dev', event, cli_version: readCliVersion(), harness: state.harness })
}
