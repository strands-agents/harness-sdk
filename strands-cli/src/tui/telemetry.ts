import type { HarnessAgentConfig } from '@strands-agents/harness'

import { enabledProfileTools } from './builtin-tools.js'
import { readCliVersion } from './package-version.js'
import type { ChatSettings } from './settings.js'

/** Overridable with STRANDS_CLI_TELEMETRY_ENDPOINT for local testing. */
export const TELEMETRY_ENDPOINT = 'https://telemetry.strandsagents.com/ping'

/** Only these providers are reported; a custom provider (`modelModule`) or anything else is omitted. */
const REPORTED_PROVIDERS = new Set(['bedrock', 'bedrock-mantle', 'anthropic', 'openai', 'google', 'ollama', 'litellm'])

const OFF = new Set(['0', 'false', 'no', 'off'])

/** Enum-shaped on purpose: the collector drops anything else. */
export interface TelemetryPing {
  v: 1
  cli_version: string
  provider?: string
  builtin_tools: string[]
  builtin_plugins: string[]
}

export function telemetryEnabled(settings: Pick<ChatSettings, 'telemetry'>, env = process.env): boolean {
  const flag = env.STRANDS_CLI_TELEMETRY?.trim().toLowerCase()
  const doNotTrack = env.DO_NOT_TRACK?.trim().toLowerCase()
  return settings.telemetry && !(flag !== undefined && OFF.has(flag)) && !(doNotTrack && !OFF.has(doNotTrack))
}

export function buildTelemetryPing(profile: HarnessAgentConfig, cliVersion = readCliVersion()): TelemetryPing {
  const provider = profile.modelModule ? undefined : providerOf(profile.model)
  return {
    v: 1,
    cli_version: cliVersion,
    ...(provider && REPORTED_PROVIDERS.has(provider) ? { provider } : {}),
    builtin_tools: enabledProfileTools(profile.builtinTools),
    builtin_plugins: [...profile.builtinPlugins],
  }
}

/** Never rejects: network errors and non-2xx responses surface only through the optional `log` callback. */
export async function sendTelemetryPing(
  ping: TelemetryPing,
  options: { endpoint?: string; fetch?: typeof globalThis.fetch; log?: (message: string) => void } = {}
): Promise<void> {
  const endpoint = options.endpoint ?? process.env.STRANDS_CLI_TELEMETRY_ENDPOINT ?? TELEMETRY_ENDPOINT
  try {
    const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
      method: 'POST',
      // No reason to keep an idle socket to the collector open for the rest of the session.
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify(ping),
      signal: AbortSignal.timeout(3_000),
      redirect: 'error',
    })
    await response.body?.cancel()
    options.log?.(`telemetry ping ${response.ok ? 'accepted' : `rejected (${response.status})`}`)
  } catch (error) {
    options.log?.(`telemetry ping failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function providerOf(model: string): string {
  const separator = model.indexOf('/')
  return separator === -1 ? 'bedrock' : model.slice(0, separator)
}
