import { describe, expect, it } from 'vitest'
import { CedarAuthorization } from '../cedar.js'
import { Agent } from '../../../agent/agent.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../../__fixtures__/tool-helpers.js'
import { resolve } from 'node:path'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'

const FIXTURES = resolve(import.meta.dirname!, 'fixtures')

describe('CedarAuthorization', () => {
  describe('real Cedar evaluation', () => {
    const entities = [
      { uid: { type: 'Resource', id: 'agent' }, attrs: {}, parents: [] },
      { uid: { type: 'User', id: 'alice' }, attrs: { role: 'admin' }, parents: [] },
      { uid: { type: 'User', id: 'bob' }, attrs: { role: 'analyst' }, parents: [] },
      { uid: { type: 'User', id: 'eve' }, attrs: { role: 'viewer' }, parents: [] },
    ]

    it('allows permitted tool calls', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: { query: 'test' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'results'
      })

      const cedar = new CedarAuthorization({
        policies: `${FIXTURES}/test.cedar`,
        entities,
        principalResolver: (state) => {
          if (!state.user_id) return undefined
          return { type: 'User', id: String(state.user_id) }
        },
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      const result = await agent.invoke('Search', { invocationState: { user_id: 'alice' } })

      expect(result.stopReason).toBe('endTurn')
      expect(toolExecuted).toBe(true)
    })

    it('denies tools not in any permit policy (default-deny)', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'delete_record', toolUseId: 'tool-1', input: { id: '1' } })
        .addTurn({ type: 'textBlock', text: 'Ok' })

      let toolExecuted = false
      const tool = createMockTool('delete_record', () => {
        toolExecuted = true
        return 'deleted'
      })

      const cedar = new CedarAuthorization({
        policies: `${FIXTURES}/test.cedar`,
        entities,
        principalResolver: () => ({ type: 'User', id: 'alice' }),
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      await agent.invoke('Delete it', { invocationState: {} })

      expect(toolExecuted).toBe(false)
    })

    it('enforces role-based access (admin can delete, analyst cannot)', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'delete_record', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('delete_record', () => {
        toolExecuted = true
        return 'deleted'
      })

      // Admin can delete
      const cedarAdmin = new CedarAuthorization({
        policies: `${FIXTURES}/role-based.cedar`,
        entities,
        principalResolver: () => ({ type: 'User', id: 'alice' }),
      })

      const agentAdmin = new Agent({ model, tools: [tool], interventions: [cedarAdmin], printer: false })
      await agentAdmin.invoke('Delete', { invocationState: {} })
      expect(toolExecuted).toBe(true)

      // Analyst cannot delete
      toolExecuted = false
      const model2 = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'delete_record', toolUseId: 'tool-2', input: {} })
        .addTurn({ type: 'textBlock', text: 'Denied' })

      const cedarAnalyst = new CedarAuthorization({
        policies: `${FIXTURES}/role-based.cedar`,
        entities,
        principalResolver: () => ({ type: 'User', id: 'bob' }),
      })

      const agentAnalyst = new Agent({ model: model2, tools: [tool], interventions: [cedarAnalyst], printer: false })
      await agentAnalyst.invoke('Delete', { invocationState: {} })
      expect(toolExecuted).toBe(false)
    })

    it('enforces role-based access (analyst can search, viewer cannot)', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'found'
      })

      // Analyst can search
      const cedarAnalyst = new CedarAuthorization({
        policies: `${FIXTURES}/role-based.cedar`,
        entities,
        principalResolver: () => ({ type: 'User', id: 'bob' }),
      })

      const agent1 = new Agent({ model, tools: [tool], interventions: [cedarAnalyst], printer: false })
      await agent1.invoke('Search', { invocationState: {} })
      expect(toolExecuted).toBe(true)

      // Viewer cannot search
      toolExecuted = false
      const model2 = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-2', input: {} })
        .addTurn({ type: 'textBlock', text: 'Denied' })

      const cedarViewer = new CedarAuthorization({
        policies: `${FIXTURES}/role-based.cedar`,
        entities,
        principalResolver: () => ({ type: 'User', id: 'eve' }),
      })

      const agent2 = new Agent({ model: model2, tools: [tool], interventions: [cedarViewer], printer: false })
      await agent2.invoke('Search', { invocationState: {} })
      expect(toolExecuted).toBe(false)
    })

    it('enforces rate limits via call_count in session context', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'send_email', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'toolUseBlock', name: 'send_email', toolUseId: 'tool-2', input: {} })
        .addTurn({ type: 'toolUseBlock', name: 'send_email', toolUseId: 'tool-3', input: {} })
        .addTurn({ type: 'toolUseBlock', name: 'send_email', toolUseId: 'tool-4', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let callCount = 0
      const tool = createMockTool('send_email', () => {
        callCount++
        return 'sent'
      })

      const cedar = new CedarAuthorization({
        policies: `${FIXTURES}/rate-limited.cedar`,
        entities,
        principalResolver: () => ({ type: 'User', id: 'alice' }),
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      await agent.invoke('Send 4 emails', { invocationState: {} })

      // Policy allows call_count < 3, so calls 1 and 2 succeed, 3+ denied
      expect(callCount).toBe(2)
    })

    it('enforces environment restrictions via contextEnricher', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'results'
      })

      // Non-production: allowed
      const cedar = new CedarAuthorization({
        policies: `${FIXTURES}/env-restricted.cedar`,
        entities,
        principalResolver: () => ({ type: 'User', id: 'alice' }),
        contextEnricher: ({ invocationState }) => ({
          environment: (invocationState.environment as string) ?? 'unknown',
        }),
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      await agent.invoke('Search', { invocationState: { environment: 'development' } })
      expect(toolExecuted).toBe(true)

      // Production: denied
      toolExecuted = false
      const model2 = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-2', input: {} })
        .addTurn({ type: 'textBlock', text: 'Denied' })

      const agent2 = new Agent({ model: model2, tools: [tool], interventions: [cedar], printer: false })
      await agent2.invoke('Search', { invocationState: { environment: 'production' } })
      expect(toolExecuted).toBe(false)
    })

    it('denies when principal is missing (fail-closed)', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Ok' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'results'
      })

      const cedar = new CedarAuthorization({
        policies: `${FIXTURES}/test.cedar`,
        entities,
        principalResolver: (state) => {
          if (!state.user_id) return undefined
          return { type: 'User', id: String(state.user_id) }
        },
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      await agent.invoke('Search', { invocationState: {} })
      expect(toolExecuted).toBe(false)
    })

    it('throws on malformed policy at construction time', () => {
      expect(
        () =>
          new CedarAuthorization({
            policies: 'this is not valid cedar syntax at all!!!',
            entities,
            principalResolver: () => ({ type: 'User', id: 'alice' }),
          })
      ).toThrow('Invalid Cedar policy')
    })
  })

  describe('principal config', () => {
    it('supports static principal (no invocationState needed)', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'ok'
      })

      const cedar = new CedarAuthorization({
        policies: `${FIXTURES}/test.cedar`,
        entities: [{ uid: { type: 'Resource', id: 'agent' }, attrs: {}, parents: [] }],
        principal: { type: 'User', id: 'alice' },
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      await agent.invoke('Search', { invocationState: {} })
      expect(toolExecuted).toBe(true)
    })

    it('throws when both principal and principalResolver are provided', () => {
      expect(
        () =>
          new CedarAuthorization({
            policies: `${FIXTURES}/test.cedar`,
            principal: { type: 'User', id: 'alice' },
            principalResolver: () => ({ type: 'User', id: 'alice' }),
          })
      ).toThrow('Provide either `principal` or `principalResolver`, not both')
    })

    it('defaults to User::"anonymous" when neither principal nor principalResolver is provided', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'ok'
      })

      // Policy permits any principal to search
      const cedar = new CedarAuthorization({
        policies: 'permit(principal, action == Action::"search", resource);',
        entities: [{ uid: { type: 'Resource', id: 'agent' }, attrs: {}, parents: [] }],
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      await agent.invoke('Search', { invocationState: {} })
      expect(toolExecuted).toBe(true)
    })
  })

  describe('resource handling', () => {
    it('uses unconstrained resource by default', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'ok'
      })

      const cedar = new CedarAuthorization({
        policies: 'permit(principal, action == Action::"search", resource);',
        principalResolver: () => ({ type: 'User', id: 'alice' }),
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      await agent.invoke('Go', { invocationState: {} })
      expect(toolExecuted).toBe(true)
    })

    it('constrains on tool arguments via context.input', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'delete', toolUseId: 'tool-1', input: { record_id: '99' } })
        .addTurn({ type: 'textBlock', text: 'Denied' })

      let toolExecuted = false
      const tool = createMockTool('delete', () => {
        toolExecuted = true
        return 'deleted'
      })

      // Only allow deleting record 42 via context.input check
      const cedar = new CedarAuthorization({
        policies: 'permit(principal, action == Action::"delete", resource) when { context.input.record_id == "42" };',
        principalResolver: () => ({ type: 'User', id: 'alice' }),
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      await agent.invoke('Delete 99', { invocationState: {} })
      expect(toolExecuted).toBe(false)
    })
  })

  describe('context enricher', () => {
    it('adds custom fields usable in policies', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'ok'
      })

      // Policy checks custom context field
      const cedar = new CedarAuthorization({
        policies: 'permit(principal, action, resource) when { context.session.department == "engineering" };',
        entities: [{ uid: { type: 'Resource', id: 'agent' }, attrs: {}, parents: [] }],
        principalResolver: () => ({ type: 'User', id: 'alice' }),
        contextEnricher: () => ({ department: 'engineering' }),
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      await agent.invoke('Go', { invocationState: {} })
      expect(toolExecuted).toBe(true)
    })

    it('denies when enricher value does not match policy', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Denied' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'ok'
      })

      const cedar = new CedarAuthorization({
        policies: 'permit(principal, action, resource) when { context.session.department == "engineering" };',
        entities: [{ uid: { type: 'Resource', id: 'agent' }, attrs: {}, parents: [] }],
        principalResolver: () => ({ type: 'User', id: 'alice' }),
        contextEnricher: () => ({ department: 'marketing' }),
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      await agent.invoke('Go', { invocationState: {} })
      expect(toolExecuted).toBe(false)
    })
  })

  describe('onError behavior', () => {
    it('throws by default when handler errors', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('tool', () => 'ok')

      // principalResolver throws
      const cedar = new CedarAuthorization({
        policies: 'permit(principal, action, resource);',
        principalResolver: () => {
          throw new Error('resolver crash')
        },
        onError: 'throw',
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      await expect(agent.invoke('Go', { invocationState: {} })).rejects.toThrow('resolver crash')
    })

    it('denies when onError is "deny" and handler throws', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('tool', () => {
        toolExecuted = true
        return 'ok'
      })

      const cedar = new CedarAuthorization({
        policies: 'permit(principal, action, resource);',
        principalResolver: () => {
          throw new Error('resolver crash')
        },
        onError: 'deny',
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      const result = await agent.invoke('Go', { invocationState: {} })
      expect(result.stopReason).toBe('endTurn')
      expect(toolExecuted).toBe(false)
    })

    it('proceeds when onError is "proceed" and handler throws', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('tool', () => {
        toolExecuted = true
        return 'ok'
      })

      const cedar = new CedarAuthorization({
        policies: 'permit(principal, action, resource);',
        principalResolver: () => {
          throw new Error('resolver crash')
        },
        onError: 'proceed',
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      const result = await agent.invoke('Go', { invocationState: {} })
      expect(result.stopReason).toBe('endTurn')
      expect(toolExecuted).toBe(true)
    })
  })

  describe('file-based config', () => {
    it('reads .cedar file from disk', async () => {
      const fixturesDir = FIXTURES

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'ok'
      })

      const cedar = new CedarAuthorization({
        policies: `${fixturesDir}/test.cedar`,
        entities: [
          { uid: { type: 'Resource', id: 'agent' }, attrs: {}, parents: [] },
          { uid: { type: 'User', id: 'alice' }, attrs: { role: 'analyst' }, parents: [] },
        ],
        principalResolver: () => ({ type: 'User', id: 'alice' }),
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      await agent.invoke('Search', { invocationState: {} })
      expect(toolExecuted).toBe(true)
    })

    it('reads .json entity file from disk', async () => {
      const fixturesDir = FIXTURES

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'ok'
      })

      const cedar = new CedarAuthorization({
        policies: 'permit(principal, action == Action::"search", resource);',
        entities: `${fixturesDir}/entities.json`,
        principalResolver: () => ({ type: 'User', id: 'alice' }),
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      await agent.invoke('Search', { invocationState: {} })
      expect(toolExecuted).toBe(true)
    })

    it('throws when .cedar file does not exist', () => {
      expect(
        () =>
          new CedarAuthorization({
            policies: '/nonexistent/path.cedar',
            principalResolver: () => ({ type: 'User', id: 'alice' }),
          })
      ).toThrow('Cedar policy file not found: /nonexistent/path.cedar')
    })
  })

  describe('session management', () => {
    it('resetCallCounts clears counts and re-enables rate-limited tools', async () => {
      let callCount = 0

      // Rate limit: < 2 calls allowed
      const cedar = new CedarAuthorization({
        policies: 'permit(principal, action, resource) when { context.session.call_count < 2 };',
        principalResolver: () => ({ type: 'User', id: 'alice' }),
      })

      // First call succeeds (count = 1)
      const model1 = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'send_email', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })
      const tool1 = createMockTool('send_email', () => {
        callCount++
        return 'sent'
      })
      const agent1 = new Agent({ model: model1, tools: [tool1], interventions: [cedar], printer: false })
      await agent1.invoke('Send', { invocationState: {} })
      expect(callCount).toBe(1)

      // Second call succeeds (count = 2, but < 2 check passes for count at time of eval which is 2... denied)
      const model2 = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'send_email', toolUseId: 'tool-2', input: {} })
        .addTurn({ type: 'textBlock', text: 'Denied' })
      const tool2 = createMockTool('send_email', () => {
        callCount++
        return 'sent'
      })
      const agent2 = new Agent({ model: model2, tools: [tool2], interventions: [cedar], printer: false })
      await agent2.invoke('Send', { invocationState: {} })
      expect(callCount).toBe(1) // still 1 — second was denied

      // Reset and try again — should succeed
      cedar.resetCallCounts(agent2)

      const model3 = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'send_email', toolUseId: 'tool-3', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })
      const tool3 = createMockTool('send_email', () => {
        callCount++
        return 'sent'
      })
      const agent3 = new Agent({ model: model3, tools: [tool3], interventions: [cedar], printer: false })
      await agent3.invoke('Send again', { invocationState: {} })
      expect(callCount).toBe(2) // succeeded after reset
    })
  })

  describe('reload', () => {
    it('reloads policies from file', () => {
      const cedar = new CedarAuthorization({
        policies: `${FIXTURES}/test.cedar`,
        principalResolver: () => ({ type: 'User', id: 'alice' }),
      })

      // reload() should not throw — file still exists and is valid
      expect(() => cedar.reload()).not.toThrow()
    })

    it('throws on reload if policy file was deleted', () => {
      const tmpFile = `${FIXTURES}/_tmp_reload_test.cedar`
      writeFileSync(tmpFile, 'permit(principal, action, resource);')
      try {
        const cedar = new CedarAuthorization({
          policies: tmpFile,
          principalResolver: () => ({ type: 'User', id: 'alice' }),
        })

        unlinkSync(tmpFile)
        expect(() => cedar.reload()).toThrow('Cedar policy file not found')
      } finally {
        if (existsSync(tmpFile)) unlinkSync(tmpFile)
      }
    })

    it('validates policies on reload', () => {
      const tmpFile = `${FIXTURES}/_tmp_reload_invalid.cedar`
      writeFileSync(tmpFile, 'permit(principal, action, resource);')
      try {
        const cedar = new CedarAuthorization({
          policies: tmpFile,
          principalResolver: () => ({ type: 'User', id: 'alice' }),
        })

        writeFileSync(tmpFile, 'this is broken!!!')
        expect(() => cedar.reload()).toThrow('Invalid Cedar policy')
      } finally {
        if (existsSync(tmpFile)) unlinkSync(tmpFile)
      }
    })
  })

  describe('schema validation', () => {
    it('passes validation when policies match schema', () => {
      expect(
        () =>
          new CedarAuthorization({
            policies: 'permit(principal is User, action == Action::"search", resource is Resource);',
            schema: `${FIXTURES}/test.cedarschema`,
            principalResolver: () => ({ type: 'User', id: 'alice' }),
          })
      ).not.toThrow()
    })

    it('throws when policy references unknown action', () => {
      expect(
        () =>
          new CedarAuthorization({
            policies: 'permit(principal, action == Action::"nonexistent_tool", resource);',
            schema: `${FIXTURES}/test.cedarschema`,
            principalResolver: () => ({ type: 'User', id: 'alice' }),
          })
      ).toThrow('Cedar policy validation failed')
    })

    it('throws when policy references unknown attribute', () => {
      expect(
        () =>
          new CedarAuthorization({
            policies: 'permit(principal, action == Action::"search", resource) when { principal.nonexistent == "x" };',
            schema: `${FIXTURES}/test.cedarschema`,
            principalResolver: () => ({ type: 'User', id: 'alice' }),
          })
      ).toThrow('Cedar policy validation failed')
    })

    it('accepts inline schema string', () => {
      const schema = `
        entity User = { role: String };
        entity Resource;
        action "search" appliesTo { principal: [User], resource: [Resource] };
      `
      expect(
        () =>
          new CedarAuthorization({
            policies: 'permit(principal is User, action == Action::"search", resource is Resource);',
            schema,
            principalResolver: () => ({ type: 'User', id: 'alice' }),
          })
      ).not.toThrow()
    })

    it('skips schema validation when schema is not provided', () => {
      // This policy references an unknown entity type — without schema, it passes parse check
      expect(
        () =>
          new CedarAuthorization({
            policies: 'permit(principal, action == Action::"anything", resource);',
            principalResolver: () => ({ type: 'User', id: 'alice' }),
          })
      ).not.toThrow()
    })
  })

  describe('tools config (schema generator integration)', () => {
    const tools = [
      {
        name: 'search',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
      { name: 'delete', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    ]

    it('auto-generates schema and validates policies when tools are provided', () => {
      const cedar = new CedarAuthorization({
        policies: 'permit(principal, action == Action::"search", resource);',
        tools,
      })
      expect(cedar.name).toBe('cedar-authorization')
    })

    it('catches unknown action names via auto-generated schema', () => {
      expect(
        () =>
          new CedarAuthorization({
            policies: 'permit(principal, action == Action::"nonexistent", resource);',
            tools,
          })
      ).toThrow('Cedar policy validation failed')
    })

    it('allows policies referencing context.session (handler-injected, not in schema)', () => {
      const cedar = new CedarAuthorization({
        policies: 'permit(principal, action == Action::"search", resource) when { context.session.role == "admin" };',
        tools,
      })
      expect(cedar.name).toBe('cedar-authorization')
    })

    it('allows tool calls when tools config is provided', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: { query: 'test' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'results'
      })

      const cedar = new CedarAuthorization({
        policies: 'permit(principal, action == Action::"search", resource);',
        tools,
        principal: { type: 'User', id: 'alice' },
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      await agent.invoke('Search', { invocationState: {} })
      expect(toolExecuted).toBe(true)
    })

    it('validates nested tool input schemas without breaking', async () => {
      const nestedTools = [
        ...tools,
        {
          name: 'create_user',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              address: { type: 'object', properties: { street: { type: 'string' }, city: { type: 'string' } } },
            },
          },
        },
      ]

      const cedar = new CedarAuthorization({
        policies: 'permit(principal, action == Action::"create_user", resource);',
        tools: nestedTools,
        principal: { type: 'User', id: 'alice' },
      })

      const model = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'create_user',
          toolUseId: 'tool-1',
          input: { name: 'Bob', address: { street: '123', city: 'NYC' } },
        })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('create_user', () => {
        toolExecuted = true
        return 'created'
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      await agent.invoke('Create user', { invocationState: {} })
      expect(toolExecuted).toBe(true)
    })

    it('surfaces schema generator errors for naming collisions in nested inputs', async () => {
      const collidingTools = [
        {
          name: 'create_user',
          inputSchema: {
            type: 'object',
            properties: {
              address: {
                type: 'object',
                properties: {
                  street: { type: 'string' },
                  geo: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } } },
                },
              },
              address_geo: {
                type: 'object',
                properties: { lat: { type: 'string' }, lng: { type: 'string' } },
              },
            },
          },
        },
      ]

      expect(
        () =>
          new CedarAuthorization({
            policies: 'permit(principal, action, resource);',
            tools: collidingTools,
          })
      ).toThrow('Schema generation failed')
    })
  })

  describe('namespace option', () => {
    it('uses namespaced action and resource types when namespace is set', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: { query: 'test' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'results'
      })

      const cedar = new CedarAuthorization({
        namespace: 'Agent',
        policies: 'permit(principal in Agent::Role::"admin", action == Agent::Action::"search", resource);',
        entities: [
          { uid: { type: 'Agent::Role', id: 'admin' }, attrs: {}, parents: [] },
          { uid: { type: 'Agent::User', id: 'alice' }, attrs: {}, parents: [{ type: 'Agent::Role', id: 'admin' }] },
          { uid: { type: 'Agent::Resource', id: 'default' }, attrs: {}, parents: [] },
        ],
        principalResolver: (state) => {
          if (!state.user_id) return undefined
          return { type: 'Agent::User', id: String(state.user_id) }
        },
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      await agent.invoke('Search', { invocationState: { user_id: 'alice' } })

      expect(toolExecuted).toBe(true)
    })

    it('denies when principal is not in the role (namespaced)', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: { query: 'test' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'results'
      })

      const cedar = new CedarAuthorization({
        namespace: 'Agent',
        policies: 'permit(principal in Agent::Role::"admin", action == Agent::Action::"search", resource);',
        entities: [
          { uid: { type: 'Agent::Role', id: 'admin' }, attrs: {}, parents: [] },
          { uid: { type: 'Agent::User', id: 'bob' }, attrs: {}, parents: [] },
          { uid: { type: 'Agent::Resource', id: 'default' }, attrs: {}, parents: [] },
        ],
        principalResolver: (state) => {
          if (!state.user_id) return undefined
          return { type: 'Agent::User', id: String(state.user_id) }
        },
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      await agent.invoke('Search', { invocationState: { user_id: 'bob' } })

      expect(toolExecuted).toBe(false)
    })

    it('works with namespace and tools (schema generation path)', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: { query: 'test' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'results'
      })

      const tools = [
        {
          name: 'search',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      ]

      const cedar = new CedarAuthorization({
        namespace: 'MyApp',
        policies: 'permit(principal, action == MyApp::Action::"search", resource);',
        tools,
        entities: [{ uid: { type: 'MyApp::Resource', id: 'default' }, attrs: {}, parents: [] }],
      })

      const agent = new Agent({ model, tools: [tool], interventions: [cedar], printer: false })
      await agent.invoke('Search', { invocationState: {} })

      expect(toolExecuted).toBe(true)
    })
  })
})
