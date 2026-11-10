/**
 * Shared telemetry utilities.
 */

const DEFAULT_SERVICE_NAME = 'strands-agents'

/**
 * Get the service name, respecting the OTEL_SERVICE_NAME environment variable.
 *
 * @returns The service name from OTEL_SERVICE_NAME or the default 'strands-agents'
 */
export function getServiceName(): string {
  return globalThis.process?.env?.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME
}
