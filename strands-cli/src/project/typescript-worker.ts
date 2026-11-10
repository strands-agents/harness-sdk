import { Message } from '@strands-agents/sdk'
import { resolve } from 'node:path'

import type { SetupChange } from '../agent/configuration.js'
import { AgentMessaging, type PeerEndpointInfo } from '../agent/messaging.js'
import {
  cloneConversation,
  createInteractiveRuntime,
  type InteractiveRuntime,
  type InteractiveRuntimeBackend,
} from '../agent/runtime.js'
import type { ChatEvent, ChatRunResult } from '../agent/types.js'
import { invocationAgentForRun } from '../cli/invocation.js'
import type { RuntimeConfig } from '../config/store.js'
import { effortForModel, effortOptions, validateEffortSelection } from '../model/selection.js'
import { DEFAULT_SESSION_DIR, sessionSettings } from '../session/sessions.js'
import { errorMessage } from '../terminal/text.js'
import { prepareArchiveDependencies } from './archive.js'
import { agentPrivatePaths } from './export.js'
import type {
  TypescriptCall,
  TypescriptConfig,
  TypescriptHostCall,
  TypescriptInit,
  TypescriptMetadata,
  TypescriptParentMessage,
  TypescriptRotation,
  TypescriptRunResult,
  TypescriptSeed,
  TypescriptWorkerMessage,
} from './typescript-backend.js'

type Stream = AsyncGenerator<ChatEvent, ChatRunResult, undefined>
type Notification = Exclude<TypescriptWorkerMessage, { type: 'response' | 'error' | 'hostCall' }>

let started = false
let closing = false
let owner: InteractiveRuntime | undefined
let active: InteractiveRuntimeBackend | undefined
let config: TypescriptConfig | undefined
let managedSession = false
let nextId = 1
let shutdown: Promise<void> | undefined
let initialization: Promise<unknown> | undefined
let pendingConfiguration: { token: number; change: SetupChange } | undefined
const messaging = new AgentMessaging()
const streams = new Map<number, { generator: Stream; pulling: boolean }>()
const naming = new Map<number, AbortController>()
const usageWatches = new Map<number, () => void>()
const afterResponses = new Map<number, () => void>()
const activityWatches = new Map<string, () => void>()
const subscriptions: (() => void)[] = []
const hostRequests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
const notifications = new Map<string, Notification>()
let sendingNotifications: Promise<void> | undefined

function send(message: TypescriptWorkerMessage): Promise<void> {
  return new Promise((resolveSend, reject) => {
    if (!process.connected || !process.send) {
      reject(new Error('TypeScript runtime parent disconnected.'))
      return
    }
    process.send(message, (error) => {
      if (error) reject(error)
      else resolveSend()
    })
  })
}

function publish(message: Notification): void {
  if (closing) return
  const key = 'id' in message ? `${message.type}:${message.id}` : message.type
  notifications.set(key, message)
  if (!sendingNotifications) void flushNotifications().catch(() => close())
}

async function flushNotifications(): Promise<void> {
  await sendingNotifications
  if (!sendingNotifications && notifications.size > 0) {
    const batch = [...notifications.values()]
    notifications.clear()
    sendingNotifications = (async (): Promise<void> => {
      for (const message of batch) await send(message)
    })().finally(() => {
      sendingNotifications = undefined
      if (notifications.size > 0) void flushNotifications().catch(() => close())
    })
  }
  await sendingNotifications
}

function hostCall<T>(call: TypescriptHostCall): Promise<T> {
  const id = nextId++
  return new Promise<T>((resolveCall, reject) => {
    hostRequests.set(id, { resolve: (value) => resolveCall(value as T), reject })
    void send({ type: 'hostCall', id, call }).catch((error: Error) => {
      hostRequests.delete(id)
      reject(error)
    })
  })
}

function current(): InteractiveRuntimeBackend {
  if (!active || closing) throw new Error('TypeScript runtime is not available.')
  return active
}

function metadata(): TypescriptMetadata {
  const { runtime, backend, mcp, profile } = current()
  return {
    name: backend.name,
    info: backend.info(),
    context: backend.contextUsage(),
    sessionId: runtime.sessionId,
    sessionDirectory: runtime.sessionDirectory,
    sessionIdentity: backend.sessionIdentity,
    managedSession,
    currentModel: runtime.current,
    provider: runtime.provider,
    selection: runtime.forkConfiguration(),
    sourceSelection: backend.sourceSelection(),
    privatePaths: agentPrivatePaths(runtime.agent),
    profile: profile(),
    mcp: {
      paths: mcp.paths,
      warnings: mcp.warnings,
      ...(mcp.startup ? { startup: mcp.startup.progress() } : {}),
    },
  }
}

function publishConfiguration(): void {
  const change = active?.configuration?.takePending()
  if (!change?.agentProject) return
  const token = nextId++
  pendingConfiguration = { token, change }
  publish({ type: 'configuration', value: { token, change: { agentProject: change.agentProject } } })
}

async function installConfig(value: TypescriptConfig): Promise<void> {
  const changedMode = config?.snapshot.permissions.mode !== value.snapshot.permissions.mode
  config = value
  if (active && changedMode) {
    await active.backend.setPermissionMode(value.snapshot.permissions.mode)
  }
}

async function writePermission(
  method: Extract<TypescriptHostCall, { operation: 'permission' }>['method'],
  value: string
): Promise<void> {
  if (method === 'setPermissionMode' && value === config?.snapshot.permissions.mode) return
  await installConfig(await hostCall<TypescriptConfig>({ operation: 'permission', method, value }))
}

async function initialize(
  input: TypescriptInit
): Promise<{ metadata: TypescriptMetadata; messages: ReturnType<Message['toJSON']>[] }> {
  if (started || closing) throw new Error('TypeScript runtime can only be initialized once.')
  started = true
  config = input.config
  process.chdir(input.cwd)
  const runtimeConfig: RuntimeConfig = {
    snapshot: () => globalThis.structuredClone(config!.snapshot),
    providerEnvironment: () => globalThis.structuredClone(config!.environment),
    setPermissionMode: (value) => writePermission('setPermissionMode', value),
    allowTool: (value) => writePermission('allowTool', value),
    denyTool: (value) => writePermission('denyTool', value),
    removeAllowedTool: (value) => writePermission('removeAllowedTool', value),
    removeDeniedTool: (value) => writePermission('removeDeniedTool', value),
  }
  try {
    const invocation = await invocationAgentForRun(
      { ...input.args, agent: input.project.entrypoint },
      {
        snapshot: runtimeConfig.snapshot,
        // The parent applies all env-file values before spawning, including non-provider keys.
        applyProviderEnvironment: (): void => {},
      },
      input.cwd,
      input.project
    )
    if (closing) throw new Error('TypeScript runtime closed during initialization.')
    const configured = sessionSettings(invocation.options.session)
    const initialDirectory = resolve(input.initialWorkspace, configured.dir ?? DEFAULT_SESSION_DIR)
    const saved = input.conversation?.session
    const preserve =
      saved &&
      (input.preserveSession ||
        (saved.configured.sessionId === (configured.id ?? null) && saved.configured.sessionDir === initialDirectory))
    const directory = input.sessionDirectory ?? (preserve ? saved.sessionDirectory : initialDirectory)
    const sessionId = input.freshSession ? undefined : (input.sessionId ?? (preserve ? saved.sessionId : configured.id))
    const sessionManager =
      input.peerEndpointId === 'agent-1' && !input.freshSession && input.restoreSeedMessages !== false
        ? (invocation.options.sessionManager ?? configured.manager)
        : undefined
    managedSession = sessionManager !== undefined
    owner = await createInteractiveRuntime({
      agentOptions: invocation.options,
      ...(invocation.buildAgent ? { buildAgent: invocation.buildAgent } : {}),
      project: input.project,
      cwd: input.initialWorkspace,
      ...(input.args.dev?.workspace
        ? { sessionRoot: resolve(input.args.dev.workspace, '.strands/state/catalog') }
        : {}),
      config: runtimeConfig,
      mcpPaths: input.mcpPaths,
      mcpStrictPaths: input.mcpStrictPaths,
      ...(input.mcpDigests ? { mcpDigests: input.mcpDigests } : {}),
      agentMessaging: messaging,
      peerMessageRouter: {
        list: (senderId) => hostCall<readonly PeerEndpointInfo[]>({ operation: 'listPeers', senderId }),
        send: (senderId, to, body) => hostCall<string>({ operation: 'sendPeer', senderId, to, body }),
      },
      configurationEnabled: true,
      allowRebuild: false,
    })
    if (closing) throw new Error('TypeScript runtime closed during initialization.')
    active = await owner.createBackend(
      {
        workspace: input.cwd,
        sessionDirectory: directory,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(sessionManager !== undefined ? { sessionManager } : {}),
        ...(input.seed ? { seed: { ...input.seed, messages: input.seed.messages.map(Message.fromMessageData) } } : {}),
        ...(input.restoreSeedMessages !== undefined ? { restoreSeedMessages: input.restoreSeedMessages } : {}),
        ...(input.selection ? { selection: input.selection } : {}),
        peerEndpointId: input.peerEndpointId,
        onConfigurationDiscard: () => {
          pendingConfiguration = undefined
          publish({ type: 'configurationDiscarded' })
        },
      },
      input.conversation
    )
    if (closing) throw new Error('TypeScript runtime closed during initialization.')
    subscriptions.push(
      active.backend.watchTasks((tasks) => {
        publish({ type: 'tasks', value: tasks })
        publishConfiguration()
      })
    )
    subscriptions.push(active.backend.watchPermissions((request) => publish({ type: 'permission', value: request })))
    subscriptions.push(messaging.subscribe(() => publish({ type: 'peers', value: messaging.list() })))
    if (active.mcp.startup) {
      subscriptions.push(active.mcp.startup.subscribe(() => publish({ type: 'metadata', value: metadata() })))
    }
    if (active.mcp.subscribeTools) {
      subscriptions.push(active.mcp.subscribeTools(() => publish({ type: 'metadata', value: metadata() })))
    }
    publishConfiguration()
    return { metadata: metadata(), messages: active.runtime.agent.messages.map((message) => message.toJSON()) }
  } catch (error) {
    await owner?.dispose()
    throw error
  }
}

async function captureFork(preserveReasoning = true): Promise<TypescriptSeed> {
  const { runtime, backend } = current()
  await runtime.agent.memoryManager?.flush()
  const stash = await backend.forkStash()
  return {
    ...runtime.forkConfiguration(),
    messages: cloneConversation(runtime.agent.messages, preserveReasoning).map((message) => message.toJSON()),
    ...(stash ? { stash } : {}),
  }
}

async function prepareRotation(
  input: TypescriptRotation
): Promise<{ selection: TypescriptMetadata['selection']; seed?: TypescriptSeed }> {
  const { runtime } = current()
  if (input.kind === 'model') {
    const request = await runtime.prepareRestart(input.modelId)
    const thinking = input.thinking === undefined ? request.thinking : effortForModel(request.model, input.thinking)
    const selection = { model: request.model, thinking: thinking === undefined ? 'auto' : thinking }
    return { selection, seed: { ...(await captureFork(request.preserveReasoning)), ...selection } }
  }
  const selection = { ...runtime.forkConfiguration(), thinking: input.thinking }
  if (typeof input.thinking === 'string') {
    validateEffortSelection(input.thinking, effortOptions(selection.model, runtime.thinking))
  }
  if (input.kind === 'clear') {
    if (managedSession) {
      throw new Error('The custom session manager owns this session. Start a new session in the agent configuration.')
    }
    await runtime.agent.memoryManager?.flush()
    return { selection }
  }
  return { selection, seed: { ...(await captureFork()), ...selection } }
}

function runResult(result: ChatRunResult, responseId: number): TypescriptRunResult {
  const { watchUsage, ...data } = result
  if (!watchUsage) return data
  const id = nextId++
  afterResponses.set(responseId, () => {
    let finished = false
    const stop = watchUsage((usage) => {
      finished = true
      usageWatches.delete(id)
      publish({ type: 'usage', id, value: usage })
    })
    if (finished) stop()
    else usageWatches.set(id, stop)
  })
  return { ...data, usageId: id }
}

async function close(): Promise<void> {
  if (shutdown) return shutdown
  closing = true
  shutdown = (async (): Promise<void> => {
    active?.backend.cancel()
    for (const controller of naming.values()) controller.abort()
    for (const stop of [...subscriptions, ...usageWatches.values(), ...activityWatches.values()]) stop()
    subscriptions.length = 0
    usageWatches.clear()
    afterResponses.clear()
    activityWatches.clear()
    notifications.clear()
    pendingConfiguration = undefined
    for (const request of hostRequests.values()) request.reject(new Error('TypeScript runtime closed.'))
    hostRequests.clear()
    for (const { generator } of streams.values()) {
      void generator.return({ stopReason: 'cancelled' }).catch(() => undefined)
    }
    streams.clear()
    await initialization?.catch(() => undefined)
    await owner?.dispose()
  })()
  return shutdown
}

async function dispatch(call: TypescriptCall): Promise<unknown> {
  if (call.operation === 'prepare') return prepareArchiveDependencies(call.input.root, call.input.language)
  if (call.operation === 'init') {
    if (started) throw new Error('TypeScript runtime can only be initialized once.')
    initialization = initialize(call.input)
    try {
      return await initialization
    } finally {
      initialization = undefined
    }
  }
  if (call.operation === 'close') return close()
  if (call.operation === 'config') return installConfig(call.input)
  const { runtime, backend, skills, mcp } = current()
  switch (call.operation) {
    case 'start': {
      if (streams.size > 0) throw new Error('A TypeScript runtime stream is already active.')
      const input = call.input
      const generator =
        input.kind === 'model'
          ? backend.stream(input.prompt)
          : input.kind === 'peer'
            ? backend.streamPeer(input.message)
            : input.kind === 'shell'
              ? backend.streamShell(input.command)
              : backend.streamBackgroundResults()
      const id = nextId++
      streams.set(id, { generator, pulling: false })
      return id
    }
    case 'next': {
      const stream = streams.get(call.input)
      if (!stream || stream.pulling)
        throw new Error('TypeScript runtime stream is unavailable or already being pulled.')
      stream.pulling = true
      try {
        const next = await stream.generator.next()
        if (next.done) {
          streams.delete(call.input)
          publishConfiguration()
          publish({ type: 'metadata', value: metadata() })
          return { done: true, value: runResult(next.value, call.id) }
        }
        if (next.value.type === 'toolResult' || next.value.type === 'tasks' || next.value.type === 'context') {
          publish({ type: 'metadata', value: metadata() })
        }
        return next
      } catch (error) {
        streams.delete(call.input)
        publishConfiguration()
        publish({ type: 'metadata', value: metadata() })
        throw error
      } finally {
        stream.pulling = false
      }
    }
    case 'return': {
      const stream = streams.get(call.input)
      if (!stream) return
      backend.cancel()
      try {
        await stream.generator.return({ stopReason: 'cancelled' })
      } finally {
        streams.delete(call.input)
      }
      publishConfiguration()
      return
    }
    case 'cancel':
      return backend.cancel()
    case 'drainSteering':
      return backend.drainSteering()
    case 'steer':
      return backend.queueSteering(call.input.prompt, () => publish({ type: 'consumed', id: call.input.id }))
    case 'listModels':
      return backend.listModels()
    case 'switchModel':
      return backend.switchModel(call.input)
    case 'setEffort':
      return backend.setEffort(call.input)
    case 'prepareRotation':
      return prepareRotation(call.input)
    case 'captureFork':
      return captureFork()
    case 'captureConversation':
      return backend.captureConversation()
    case 'flush':
      return runtime.agent.memoryManager?.flush()
    case 'compact':
      return backend.compact()
    case 'nameSession': {
      const controller = new AbortController()
      naming.set(call.input, controller)
      try {
        return await backend.generateSessionName(controller.signal)
      } finally {
        naming.delete(call.input)
      }
    }
    case 'cancelNaming':
      return naming.get(call.input)?.abort()
    case 'respondPermission':
      return backend.respondPermission(call.input.requestId, call.input.optionId, call.input.rule)
    case 'setPermissionMode':
      return backend.setPermissionMode(call.input)
    case 'allowPermission':
      return backend.allowPermission(call.input)
    case 'removeAllowedPermission':
      return backend.removeAllowedPermission(call.input)
    case 'removeDeniedPermission':
      return backend.removeDeniedPermission(call.input)
    case 'listSkills':
      return skills.list()
    case 'activateSkill':
      return skills.activate(call.input)
    case 'listMcp':
      return mcp.list(call.input)
    case 'enableMcp':
      return mcp.setEnabled?.(call.input.name, call.input.enabled)
    case 'watchActivity':
      activityWatches.get(call.input.id)?.()
      activityWatches.delete(call.input.id)
      if (call.input.enabled) {
        activityWatches.set(
          call.input.id,
          backend.watchTaskActivity(call.input.id, (value) => publish({ type: 'activity', id: call.input.id, value }))
        )
      }
      return
    case 'unwatchUsage':
      usageWatches.get(call.input)?.()
      usageWatches.delete(call.input)
      return
    case 'deliverPeer':
      return messaging.deliver(call.input.id, call.input.message)
    case 'configurationFailed':
      if (pendingConfiguration?.token !== call.input.token)
        throw new Error('Configuration request is no longer pending.')
      await pendingConfiguration.change.onFailure?.(call.input.message)
      pendingConfiguration = undefined
      return
  }
}

async function receive(message: TypescriptParentMessage): Promise<void> {
  if (message.type !== 'call') {
    const request = hostRequests.get(message.id)
    if (!request) return
    hostRequests.delete(message.id)
    if (message.type === 'hostError') request.reject(new Error(message.message))
    else request.resolve(message.result)
    return
  }
  try {
    const result = await dispatch(message)
    if (
      active &&
      !closing &&
      (message.operation === 'switchModel' ||
        message.operation === 'setEffort' ||
        message.operation === 'compact' ||
        message.operation === 'enableMcp' ||
        message.operation === 'activateSkill' ||
        message.operation === 'configurationFailed')
    ) {
      publish({ type: 'metadata', value: metadata() })
    }
    await flushNotifications()
    await send({ type: 'response', id: message.id, result })
    const afterResponse = afterResponses.get(message.id)
    afterResponses.delete(message.id)
    afterResponse?.()
    if (message.operation === 'close') process.disconnect?.()
  } catch (error) {
    await flushNotifications()
    await send({ type: 'error', id: message.id, message: errorMessage(error) })
  }
}

process.on('message', (message: TypescriptParentMessage) => {
  void receive(message).catch(() => close())
})
process.once('disconnect', () => {
  void close().finally(() => process.exit())
})
