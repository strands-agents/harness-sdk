import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FunctionTool, LocalAgent, ToolContext } from '@strands-agents/sdk'
import { describe, expect, it, vi } from 'vitest'

import { temporaryDirectory } from '../fixtures/tempdir.js'
import { parseArgs } from '../../src/cli/arguments.js'
import type { ChatEvent, ChatPermissionRequest, ChatTask } from '../../src/agent/types.js'
import { CliConfigStore } from '../../src/config/store.js'
import { AgentMessaging, type PeerMessage, type PeerMessageRouter } from '../../src/agent/messaging.js'
import { importAgentProject } from '../../src/project/import.js'
import { TypescriptBackend } from '../../src/project/typescript-backend.js'

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

  it.each(['local', 'remote'])(
    'lists peers and validates attributed messages through the %s agent tool',
    async (route) => {
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
      const remote: PeerMessageRouter | undefined =
        route === 'remote'
          ? {
              list: async (id) => messaging.list(id),
              send: async (id, to, body) => messaging.send(id, to, body),
            }
          : undefined
      const agentMessage = bindMessageTool(remote ? new AgentMessaging() : messaging, 'agent-1', sender, remote)

      expect(agentMessage.name).toBe('message_agent')
      await expect(agentMessage.invoke({ action: 'list' }, { agent: sender } as ToolContext)).resolves.toEqual({
        agents: [{ id: 'agent-2', name: 'Reviewer', status: 'working' }],
      })
      const result = await agentMessage.invoke(
        { action: 'send', to: 'agent-2', message: 'Please review the parser.' },
        {
          agent: sender,
        } as ToolContext
      )

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

      await expect(agentMessage.invoke({ action: 'list' }, { agent: {} } as ToolContext)).rejects.toThrow(
        'not registered for peer messaging'
      )
      messaging.unregister('agent-1')
      await expect(agentMessage.invoke({ action: 'list' }, { agent: sender } as ToolContext)).rejects.toThrow(
        'not registered for peer messaging'
      )
      await expect(
        agentMessage.invoke({ action: 'send', to: 'agent-2', message: 'Check this.' }, { agent: sender } as ToolContext)
      ).rejects.toThrow('not registered for peer messaging')
    }
  )

  it.each([true, false])('waits for remote recipient acceptance (%s) before reporting delivery', async (accepted) => {
    const registry = new AgentMessaging()
    const sender = {} as LocalAgent
    let accept!: (accepted: boolean) => void
    const delivery = new Promise<boolean>((resolve) => {
      accept = resolve
    })
    const enqueue = vi.fn(() => delivery)
    registry.register(endpoint('agent-1', 'Main'))
    registry.register({ ...endpoint('agent-2', 'Reviewer'), enqueue })
    const messageAgent = bindMessageTool(new AgentMessaging(), 'agent-1', sender, {
      list: async (id) => registry.list(id),
      send: async (id, to, body) => registry.send(id, to, body),
    })
    let settled = false
    const sending = messageAgent.invoke({ action: 'send', to: 'agent-2', message: 'Check this.' }, {
      agent: sender,
    } as ToolContext)
    void sending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    expect(enqueue).toHaveBeenCalledWith({ from: { id: 'agent-1', name: 'Main' }, body: 'Check this.' })
    if (!accepted) registry.unregister('agent-2')
    accept(accepted)
    if (accepted) {
      await expect(sending).resolves.toEqual({ status: 'queued', recipient: 'Reviewer' })
    } else {
      await expect(sending).rejects.toThrow('could not accept the peer message')
    }
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

  it('delivers validated peer messages to local tasks without a local sender endpoint', () => {
    const worker = new AgentMessaging()
    const enqueue = vi.fn(() => true)
    const message = { from: { id: 'agent-1', name: 'Main' }, body: 'Review the parser.' }
    worker.register({ ...endpoint('task-1', 'Reviewer'), enqueue })

    expect(worker.deliver('task-1', message)).toBe(true)
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(message)
    worker.unregister('task-1')
    expect(() => worker.deliver('task-1', message)).toThrow('Unknown peer agent')
    worker.register({ ...endpoint('task-1', 'Reviewer'), status: () => undefined, enqueue })
    expect(() => worker.deliver('task-1', message)).toThrow('not available for peer messages')
    expect(enqueue).toHaveBeenCalledOnce()
  })

  it('shares canonical permissions and delivers peer messages across real source processes and background tasks', async () => {
    const root = await temporaryDirectory('strands-process-peers-')
    const release = join(root, 'release')
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await writeFile(
      join(root, 'model.ts'),
      String.raw`
import { Model, tool } from '@strands-agents/sdk'
import { existsSync } from 'node:fs'
export class ScriptedModel extends Model {
  getConfig() { return { modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0' } }
  updateConfig() {}
  async *stream(messages, options) {
    const last = messages.at(-1)
    const text = last.content.filter(block => block.type === 'textBlock').map(block => block.text).join('')
    let request
    if (!last.content.some(block => block.type === 'toolResultBlock')) {
      try { request = JSON.parse(text.split('\n')[0]) } catch {}
    }
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    if (request?.tool) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: request.tool, toolUseId: 'call-' + messages.length } }
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(request.input ?? {}) } }
    } else {
      yield { type: 'modelContentBlockStartEvent' }
      if (text.includes('hold-background')) {
        yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'x'.repeat(1024 * 1024) } }
        while (!existsSync(${JSON.stringify(release)})) {
          if (options?.cancelSignal?.aborted) throw new Error('cancelled')
          yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'x'.repeat(128) } }
          await new Promise(resolve => setTimeout(resolve, 1))
        }
      } else {
        yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'done ' + text } }
      }
    }
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: request?.tool ? 'toolUse' : 'endTurn' }
  }
}
export const tools = ['alpha', 'beta', 'gamma'].map(name => tool({
  name, description: name, inputSchema: { type: 'object', properties: {} }, callback: () => name + ' executed'
}))
`
    )
    await writeFile(
      join(root, 'agent.ts'),
      `
import { createHarness } from '@strands-agents/harness'
import { ScriptedModel, tools } from './model.js'
export const agent = await createHarness({
  model: new ScriptedModel(), tools, builtinTools: ['subagent'], builtinPlugins: [],
  memory: false, session: false, skills: false, contextManager: false,
  backgroundTasks: { waitForCompletion: false }, printer: false
})
`
    )
    const configPath = join(root, 'cli.toml')
    const config = await CliConfigStore.load(configPath)
    await config.setSettings({ mcpDiscovery: false, skillDiscovery: false, agentMessaging: true })
    const registry = new AgentMessaging()
    const backends: TypescriptBackend[] = []
    const runs: Promise<ChatEvent[]>[] = []
    let stopActivity: (() => void) | undefined
    let stopTasks: (() => void) | undefined
    let controlRequest: Promise<unknown> | undefined
    const received: { message: PeerMessage; result: Promise<ChatEvent[]> }[] = []
    const collect = (stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> => {
      const run = (async (): Promise<ChatEvent[]> => {
        const events: ChatEvent[] = []
        for await (const event of stream) events.push(event)
        return events
      })()
      runs.push(run)
      void run.catch(() => undefined)
      return run
    }
    try {
      for (const id of ['agent-1', 'agent-2']) {
        const { backend } = await TypescriptBackend.open(
          {
            project: importAgentProject(join(root, 'agent.ts')),
            args: parseArgs([]),
            cwd: root,
            initialWorkspace: root,
            peerEndpointId: id,
            mcpPaths: [],
            mcpStrictPaths: [],
          },
          config,
          registry
        )
        backends.push(backend)
        registry.register({
          id,
          name: id,
          status: () => 'idle',
          enqueue: (message) => {
            received.push({ message, result: collect(backend.streamPeer(message)) })
            return true
          },
        })
      }
      const [first, second] = backends as [TypescriptBackend, TypescriptBackend]
      await Promise.all([
        first.allowPermission('alpha'),
        second.allowPermission('beta'),
        config.setSettings({ animations: false }),
      ])
      await TypescriptBackend.syncConfiguration(config)
      expect((await CliConfigStore.load(configPath)).snapshot()).toMatchObject({
        permissions: { allow: ['alpha', 'beta'] },
        settings: { animations: false },
      })
      const allowed = await Promise.all([
        collect(first.stream('{"tool":"beta"}')),
        collect(second.stream('{"tool":"alpha"}')),
      ])
      for (const events of allowed) {
        expect(events).toContainEqual(expect.objectContaining({ type: 'toolResult', status: 'success' }))
      }
      const pending = new Map<number, ChatPermissionRequest>()
      const stopPermissions = backends.map((backend, index) =>
        backend.watchPermissions((request) => {
          if (request) pending.set(index, request)
        })
      )
      const blocked = backends.map((backend) => collect(backend.stream('{"tool":"gamma"}')))
      await vi.waitFor(() => expect(pending.size).toBe(2))
      await first.setPermissionMode('bypassPermissions')
      await Promise.all(blocked)
      for (let index = 0; index < backends.length; index++) {
        expect(await backends[index]!.respondPermission(pending.get(index)!.id, 'allow-once')).toBe(false)
      }
      stopPermissions.forEach((stop) => stop())

      const sent = await collect(
        first.stream(
          JSON.stringify({
            tool: 'message_agent',
            input: { action: 'send', to: 'agent-2', message: 'hello child' },
          })
        )
      )
      expect(sent).toContainEqual(expect.objectContaining({ type: 'toolResult', status: 'success' }))
      expect(received).toHaveLength(1)
      expect(received[0]!.message).toEqual({ from: { id: 'agent-1', name: 'agent-1' }, body: 'hello child' })
      expect(await received[0]!.result).toContainEqual({
        type: 'textDelta',
        text: expect.stringContaining('hello child'),
      })

      let watchedTasks: readonly ChatTask[] = []
      stopTasks = second.watchTasks((tasks) => {
        watchedTasks = tasks
      })
      const background = collect(
        second.stream(
          JSON.stringify({
            tool: 'subagent',
            input: { task: 'hold-background' },
          })
        )
      )
      await vi.waitFor(() => expect(registry.list().some((peer) => peer.id.includes(':task-'))).toBe(true))
      const task = registry.list().find((peer) => peer.id.includes(':task-'))!
      const delivered = await collect(
        first.stream(
          JSON.stringify({
            tool: 'message_agent',
            input: { action: 'send', to: task.id, message: 'note for live task' },
          })
        )
      )
      expect(delivered).toContainEqual(expect.objectContaining({ type: 'toolResult', status: 'success' }))
      const backgroundEvents = await background
      const backgroundTask = [
        ...watchedTasks,
        ...backgroundEvents.flatMap((event) => (event.type === 'tasks' ? event.tasks : [])),
      ].find((task) => task.source === 'background')!
      expect(backgroundTask).toBeDefined()
      let activityUpdates = 0
      stopActivity = second.watchTaskActivity(backgroundTask.id, () => {
        // A slow renderer and large activity snapshots put real IPC writes under backpressure.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3)
        activityUpdates++
      })
      await vi.waitFor(() => expect(activityUpdates).toBeGreaterThan(25))
      let listedSkills: unknown
      controlRequest = second.skills.list().then((skills) => {
        listedSkills = skills
      })
      void controlRequest.catch(() => undefined)
      await vi.waitFor(() => expect(listedSkills).toEqual([]), { timeout: 5000 })
      const updatesAtResponse = activityUpdates
      await vi.waitFor(() => expect(activityUpdates).toBeGreaterThan(updatesAtResponse))
      expect(second.getTaskActivity(backgroundTask.id)?.status).toBe('working')
      stopActivity()
      stopActivity = undefined
      await writeFile(release, 'done')
      await vi.waitFor(() => expect(registry.list().some((peer) => peer.id === task.id)).toBe(false))
      expect(() => registry.send('agent-1', task.id, 'too late')).toThrow('Unknown peer agent')
    } finally {
      stopActivity?.()
      stopTasks?.()
      await writeFile(release, 'done')
      await Promise.all(backends.map((backend) => backend.dispose()))
      await Promise.allSettled([...runs, controlRequest])
    }
  }, 20000)
})

function endpoint(id: string, name: string) {
  return {
    id,
    name,
    status: () => 'idle' as const,
    enqueue: () => true,
  }
}

function bindMessageTool(messaging: AgentMessaging, endpointId: string, agent: LocalAgent, router?: PeerMessageRouter) {
  const plugin = messaging.createPlugin(endpointId, router)
  plugin.initAgent(agent)
  return plugin.getTools()[0] as FunctionTool
}
