import { defaultSandbox } from './default.js'
import { NotASandboxLocalEnvironment } from './not-a-sandbox-local-environment.js'

// Unit tests call this directly so they can mock the MCP loader's dependencies.
/** @internal */
export function registerNodeSandboxDefault(): void {
  defaultSandbox.set(new NotASandboxLocalEnvironment())
}
