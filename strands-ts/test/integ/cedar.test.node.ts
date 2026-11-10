import { describe, expect, it } from 'vitest'
import { Agent, tool } from '@strands-agents/sdk'
import { CedarAuthorization } from '$/sdk/vended-interventions/cedar/index.js'
import { z } from 'zod'
import { resolve } from 'node:path'
import { bedrock } from './__fixtures__/model-providers.js'

const FIXTURES = resolve(import.meta.dirname!, '../../src/vended-interventions/cedar/__tests__/fixtures')

const searchTool = tool({
  name: 'search',
  description: 'Search for information. Always use this tool when asked to search.',
  inputSchema: z.object({ query: z.string().describe('Search query') }),
  callback: (input) => `Results for: ${input.query}`,
})

const deleteTool = tool({
  name: 'delete_record',
  description: 'Delete a database record by ID. Always use this tool when asked to delete.',
  inputSchema: z.object({ record_id: z.string().describe('Record ID to delete') }),
  callback: (input) => `Deleted record ${input.record_id}`,
})

describe('CedarAuthorization integration', () => {
  describe.skipIf(bedrock.skip)('with Bedrock', () => {
    it('allows tool execution when policy permits', async () => {
      const cedar = new CedarAuthorization({
        policies: `${FIXTURES}/test.cedar`,
        entities: `${FIXTURES}/entities.json`,
        principalResolver: (state) => {
          if (!state.user_id) return undefined
          return { type: 'User', id: String(state.user_id) }
        },
      })

      const agent = new Agent({
        model: bedrock.createModel(),
        tools: [searchTool],
        interventions: [cedar],
        printer: false,
      })

      const result = await agent.invoke('Search for "cedar policy"', {
        invocationState: { user_id: 'alice' },
      })

      expect(result.stopReason).toBe('endTurn')
    })

    it('denies tool execution when policy forbids', async () => {
      const cedar = new CedarAuthorization({
        policies: `${FIXTURES}/permit-search-deny-delete.cedar`,
        entities: `${FIXTURES}/entities.json`,
        principalResolver: (state) => {
          if (!state.user_id) return undefined
          return { type: 'User', id: String(state.user_id) }
        },
      })

      const agent = new Agent({
        model: bedrock.createModel(),
        tools: [searchTool, deleteTool],
        interventions: [cedar],
        printer: false,
      })

      const result = await agent.invoke('Delete record 42', {
        invocationState: { user_id: 'alice' },
      })

      expect(result.stopReason).toBe('endTurn')
    })

    it('denies all tools when no principal identity (fail-closed)', async () => {
      const cedar = new CedarAuthorization({
        policies: `${FIXTURES}/permit-all.cedar`,
        entities: `${FIXTURES}/entities.json`,
        principalResolver: (state) => {
          if (!state.user_id) return undefined
          return { type: 'User', id: String(state.user_id) }
        },
      })

      const agent = new Agent({
        model: bedrock.createModel(),
        tools: [searchTool],
        interventions: [cedar],
        printer: false,
      })

      const result = await agent.invoke('Search for something', {
        invocationState: {},
      })

      expect(result.stopReason).toBe('endTurn')
    })
  })
})
