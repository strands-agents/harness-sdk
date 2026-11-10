// Unit tests do not import index.node.ts, so register the sandbox default here.
// Registering the MCP loader here would prevent tests from mocking its dependencies.
import { registerNodeSandboxDefault } from '../sandbox/register-node-defaults.js'

registerNodeSandboxDefault()
