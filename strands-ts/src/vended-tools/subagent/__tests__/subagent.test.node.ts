import { describe, expect, it } from 'vitest'
import { subagent } from '../index.js'
import { Agent } from '../../../agent/agent.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../../__fixtures__/tool-helpers.js'
import { CedarAuthorization } from '../../../vended-interventions/cedar/cedar.js'

describe('subagent tool with CedarAuthorization', () => {
  // The default builder shares the parent's handler with the child, which keeps its own counts (#6278)
  it('gives the child its own call counts', async () => {
    const cedar = new CedarAuthorization({
      policies: 'permit(principal, action, resource) when { context.session.call_count < 3 };',
    })
    const senders: Agent[] = []
    const sendEmail = createMockTool('send_email', (context) => {
      senders.push(context.agent as Agent)
      return 'sent'
    })
    // The child inherits the parent's model, so turns are consumed in order across both agents.
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'send_email', toolUseId: 'p1', input: {} })
      .addTurn({ type: 'toolUseBlock', name: 'subagent', toolUseId: 'p2', input: { task: 'Send 3 emails' } })
      .addTurn({ type: 'toolUseBlock', name: 'send_email', toolUseId: 'c1', input: {} })
      .addTurn({ type: 'toolUseBlock', name: 'send_email', toolUseId: 'c2', input: {} })
      .addTurn({ type: 'toolUseBlock', name: 'send_email', toolUseId: 'c3', input: {} })
      .addTurn({ type: 'textBlock', text: 'Child done' })
      .addTurn({ type: 'toolUseBlock', name: 'send_email', toolUseId: 'p3', input: {} })
      .addTurn({ type: 'textBlock', text: 'Parent done' })
    const parent = new Agent({ model, tools: [sendEmail, subagent], interventions: [cedar], printer: false })

    await parent.invoke('Send an email, delegate 3 more, then send another')

    // Each agent may send twice: the child's third call is denied and the parent's second is allowed.
    expect(senders.map((sender) => sender === parent)).toStrictEqual([true, false, false, true])
    const child = senders[1]!
    expect(senders[2]).toBe(child)
    expect(child.appState.get('cedar-authorization')).toStrictEqual({ send_email: 2 })
    expect(parent.appState.get('cedar-authorization')).toStrictEqual({ send_email: 2, subagent: 1 })
  })
})
