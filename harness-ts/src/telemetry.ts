/**
 * OTEL tracing for a harness agent.
 *
 * The SDK already instruments the agent — the model loop, tool calls, and subagent delegation all
 * emit spans; a plain `Agent` just has nowhere to send them. The harness's only job is to wire up an
 * exporter, and only when asked: it reads the standard `OTEL_TRACES_EXPORTER` selector
 * (`otlp`/`console`/`none`) and does nothing unless it is set. Unset means off — the harness does not honor
 * OTEL's spec default of `otlp`, so it never silently stands up an exporter (which would target
 * `localhost:4318` and stall the process on exit). Endpoint, headers, and protocol are configured
 * through the usual `OTEL_EXPORTER_OTLP_*` variables, which the exporter reads itself.
 *
 * Tracing is process-global (the provider lives on the OpenTelemetry global API, not on an `Agent`),
 * so setup runs at most once per process: building several agents — or a `subagent`, which builds
 * another agent per call — cannot stack duplicate exporters onto the same trace.
 */

import { warnOnce } from './logging.js'

export const TRACES_EXPORTER_ENV_VAR = 'OTEL_TRACES_EXPORTER'

// The exporters the SDK's setupTracer exposes a flag for. "none" and any other selector value are
// handled in resolveExporters.
const SUPPORTED_EXPORTERS = ['otlp', 'console'] as const
type SupportedExporter = (typeof SUPPORTED_EXPORTERS)[number]

let configured = false

/**
 * The exporters to wire, from the standard `OTEL_TRACES_EXPORTER` selector.
 *
 * An unset selector, or an explicit `none`, means tracing is off.
 */
function resolveExporters(): SupportedExporter[] {
  const selector = process.env[TRACES_EXPORTER_ENV_VAR] ?? ''
  const requested = selector
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
  if (requested.length === 0 || requested.includes('none')) {
    return []
  }
  for (const name of requested) {
    if (!(SUPPORTED_EXPORTERS as readonly string[]).includes(name)) {
      warnOnce(
        `${TRACES_EXPORTER_ENV_VAR} names '${name}', which the harness does not support; skipping it. ` +
          'Supported values: otlp, console, none.'
      )
    }
  }
  return SUPPORTED_EXPORTERS.filter((name) => requested.includes(name))
}

/** Wire the SDK's span exporter(s) once per process, per the standard OTEL env convention. */
export async function setupTelemetry(): Promise<void> {
  if (configured) {
    return
  }
  const exporters = resolveExporters()
  if (exporters.length === 0) {
    return
  }
  // Imported on demand so a run with no exporter configured never loads the OTel trace SDK.
  const { setupTracer } = await import('@strands-agents/sdk/telemetry')
  setupTracer({ exporters: { otlp: exporters.includes('otlp'), console: exporters.includes('console') } })
  configured = true
}

/** Forget that setup ran so it can run again. For tests only. */
export function resetTelemetry(): void {
  configured = false
}
