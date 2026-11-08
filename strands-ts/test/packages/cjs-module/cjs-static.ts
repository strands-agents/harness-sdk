/**
 * Verification script for a CommonJS TypeScript project run through tsx. A static `import`
 * here is compiled to `require()`, so every dependency the SDK loads at startup must resolve
 * under the CommonJS export conditions (https://github.com/strands-agents/harness-sdk/issues/5594).
 */
import { Agent, McpClient } from '@strands-agents/sdk'

if (typeof Agent !== 'function' || typeof McpClient !== 'function') {
  throw new Error('Static import from a CommonJS TypeScript project failed')
}
console.log('✓ Static import from a CommonJS TypeScript project successful')
