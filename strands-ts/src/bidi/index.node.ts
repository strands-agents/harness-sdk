// Node entry point for `@strands-agents/sdk/bidi` (selected by the "node" export condition).
// Registers the same Node defaults as the root entry (host sandbox, MCP config loader) so a Node app
// that imports only this subpath still gets them. This is a load-bearing side effect -- do NOT mark
// this module side-effect-free or bundlers will tree-shake the registrations.
import { registerNodeDefaults } from '../register-node-defaults.js'

registerNodeDefaults()

export * from './index.js'
