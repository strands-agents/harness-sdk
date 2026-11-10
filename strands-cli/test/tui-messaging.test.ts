import type { FunctionTool, LocalAgent, ToolContext } from '@strands-agents/sdk'
import { describe, expect, it } from 'vitest'

import { AgentMessaging, peerMessagePrompt, type PeerMessage } from '../src/tui/messaging.js'

describe('AgentMessaging', () => {
  it('publishes live roster changes', () => {
    const messaging = new AgentMessaging()
    const rosters: string[][] = []
    const unsubscribe = messaging.subscribe(() => {
      rosters.push(messaging.list().map((agent) => `${agent.name}:${agent.status}`))
    })

    messaging.register(endpoint('task-1', 'subagent: Review tests'))
    messaging.rename('task-1', 'subagent: Review authentication')
    messaging.unregister('task-1')
    unsubscribe()

    expect(rosters).toEqual([[], ['subagent: Review tests:idle'], ['subagent: Review authentication:idle'], []])
  })

  it('lists live peers, queues attributed messages, and rejects oversized messages through the agent tool', async () => {
    const messaging = new AgentMessaging()
    const sender = {} as LocalAgent
    const received: PeerMessage[] = []
    messaging.register(endpoint('agent-1', 'Main'))
    messaging.register({
      id: 'agent-2',
      name: 'Reviewer',
      status: () => 'working',
      enqueue: (message) => {
        received.push(message)
        return true
      },
    })
    const agentMessage = bindMessageTool(messaging, 'agent-1', sender)

    expect(agentMessage.name).toBe('message_agent')
    await expect(agentMessage.invoke({ action: 'list' }, { agent: sender } as ToolContext)).resolves.toEqual({
      agents: [{ id: 'agent-2', name: 'Reviewer', status: 'working' }],
    })
    const result = await agentMessage.invoke({ action: 'send', to: 'agent-2', message: 'Please review the parser.' }, {
      agent: sender,
    } as ToolContext)

    expect(result).toEqual({
      status: 'queued',
      recipient: 'Reviewer',
    })
    expect(received).toEqual([
      {
        from: { id: 'agent-1', name: 'Main' },
        body: 'Please review the parser.',
      },
    ])
    await expect(
      agentMessage.invoke({ action: 'send', to: 'agent-2', message: 'x'.repeat(20_001) }, {
        agent: sender,
      } as ToolContext)
    ).rejects.toThrow('limited to 20,000 characters')
  })

  it('hides endpoints that cannot receive messages', async () => {
    const hub = new AgentMessaging()
    const main = {} as LocalAgent
    hub.register(endpoint('agent-1', 'Main'))
    hub.register({ ...endpoint('agent-2', 'Reviewer'), status: () => undefined })
    const messageAgent = bindMessageTool(hub, 'agent-1', main)

    await expect(messageAgent.invoke({ action: 'list' }, { agent: main } as ToolContext)).resolves.toEqual({
      agents: [],
    })
    await expect(
      messageAgent.invoke({ action: 'send', to: 'agent-2', message: 'Check this.' }, { agent: main } as ToolContext)
    ).rejects.toThrow('not available for peer messages')
  })

  it('presents peer messages without prescribing recipient behavior', () => {
    const message: PeerMessage = {
      from: { id: 'agent-1', name: 'Main' },
      body: 'Please review the parser.',
    }

    expect(peerMessagePrompt(message)).toBe('Message from Main (agent-1):\n\nPlease review the parser.')
  })
})

function endpoint(id: string, name: string) {
  return {
    id,
    name,
    status: () => 'idle' as const,
    enqueue: () => true,
  }
}

function bindMessageTool(messaging: AgentMessaging, endpointId: string, agent: LocalAgent) {
  const plugin = messaging.createPlugin(endpointId)
  plugin.initAgent(agent)
  return plugin.getTools()[0] as FunctionTool
}
