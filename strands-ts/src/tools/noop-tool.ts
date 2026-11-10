/**
 * Shared tool helpers and constants.
 */

import type { ToolSpec } from './types.js'

/**
 * A no-op tool spec that instructs the model to ignore it completely.
 *
 * Some model providers (e.g. Bedrock) require a tool configuration when messages
 * contain tool use/result blocks. This noop tool can be injected to satisfy that
 * requirement without affecting model behavior.
 */
export const NOOP_TOOL_SPEC: ToolSpec = {
  name: 'noop',
  description: 'This is a fake tool that MUST be completely ignored.',
  inputSchema: { type: 'object', properties: {} },
}
