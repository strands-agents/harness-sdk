// Node entry point (selected by the "node" export condition in package.json).
// Registers Node-specific defaults, then re-exports the full public API.
// This is a load-bearing side effect -- do NOT mark this module side-effect-free
// or bundlers will tree-shake the registrations.
import { registerNodeDefaults } from './register-node-defaults.js'

registerNodeDefaults()

export * from './index.js'
