import { mcpServerLoader } from './mcp/config.js'
import { resolveServerConfigs } from './mcp/config.node.js'
import { registerNodeSandboxDefault } from './sandbox/register-node-defaults.js'

// Shared by the Node entry point and integration tests to keep their defaults in sync.
/** @internal */
export function registerNodeDefaults(): void {
  registerNodeSandboxDefault()
  mcpServerLoader.set(resolveServerConfigs)
}
