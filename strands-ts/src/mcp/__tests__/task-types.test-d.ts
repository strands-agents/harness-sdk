import { describe, expectTypeOf, it } from 'vitest'

import { McpClient } from '../client.js'
import type { JSONValue } from '../../types/json.js'
import type { ElicitationCallback } from '../../types/elicitation.js'

import type { CallToolResult } from '@modelcontextprotocol/client'
import type { McpCallToolWithTaskResult, McpDirectCallToolResult } from '../task-types.js'

describe('MCP task public types', () => {
  it('keeps the legacy URL elicitation ID available while allowing modern requests to omit it', () => {
    const params = undefined as unknown as Parameters<ElicitationCallback>[1]
    if (params.mode === 'url') {
      expectTypeOf(params.elicitationId).toEqualTypeOf<string | undefined>()
    }
  })

  it('preserves the high-level JSON result contract and exposes typed low-level outcomes', () => {
    expectTypeOf<McpClient['callTool']>().returns.resolves.toEqualTypeOf<JSONValue>()
    expectTypeOf<McpClient['callToolWithTask']>().returns.resolves.toEqualTypeOf<McpCallToolWithTaskResult>()
  })

  it('keeps direct tool result extension fields available after narrowing', () => {
    expectTypeOf<McpDirectCallToolResult>().toMatchTypeOf<CallToolResult>()

    const result = undefined as unknown as McpCallToolWithTaskResult
    if (result.resultType !== 'task') {
      expectTypeOf(result['example.com/priority']).toEqualTypeOf<unknown>()
    }
  })
})
