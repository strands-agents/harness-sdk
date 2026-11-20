import { writeFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import type { ChatPermissionPanel } from '../../src/agent/types.js'
import { PERMISSION_LABEL_WIDTH, permissionLines } from '../../src/ui/presentation.js'

const panel = {
  kind: 'permission',
  request: {
    id: 'demo',
    toolName: 'Edit',
    action: 'Edit agent/agent.ts',
    diff: {
      path: 'agent/agent.ts',
      lines: [
        { kind: 'header', text: '@@ -12,7 +12,9 @@ export const agent = createHarness({' },
        { kind: 'context', text: "  model: 'claude-sonnet-5-5'," },
        { kind: 'remove', text: "  instructions: 'You are a helpful assistant.'," },
        { kind: 'add', text: "  instructions: 'You are a terse assistant. Answer first, then explain.'," },
        { kind: 'add', text: '  effort: 2,' },
        { kind: 'context', text: '  tools: [read, write],' },
      ],
    },
  },
  body: '{"file_path":"agent/agent.ts"}',
} as unknown as ChatPermissionPanel

describe('scratch', () => {
  it('prints the diff preview', () => {
    const out = permissionLines(panel, 90)
      .map((line) => `${line.label.padEnd(PERMISSION_LABEL_WIDTH)}${line.text}  [${line.color ?? ''}]`)
      .join('\n')
    writeFileSync('/tmp/diffshot/out.txt', out)
  })
})
