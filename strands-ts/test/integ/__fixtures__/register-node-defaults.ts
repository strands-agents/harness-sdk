import { registerNodeDefaults } from '$/sdk/register-node-defaults.js'

// Integration tests do not import index.node.ts, so register the same Node defaults here.
registerNodeDefaults()
