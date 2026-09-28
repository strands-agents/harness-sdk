import type { SnapshotStorage, SnapshotLocation } from './storage.js'
import type { Storage } from '../storage/storage.js'
import { NAMESPACED, namespace } from '../storage/storage.js'
import { SnapshotStorageAdapter } from './snapshot-storage-adapter.js'
import { validateIdentifier } from './validation.js'
import type { SnapshotTriggerCallback } from './types.js'
import type { Snapshot } from '../types/snapshot.js'
import type { JSONValue } from '../types/json.js'
import type { Plugin } from '../plugins/plugin.js'
import type { LocalAgent } from '../types/agent.js'
import { Stash } from '../context-manager/stash.js'
import { AfterInvocationEvent, AfterModelCallEvent, InitializedEvent, MessageAddedEvent } from '../hooks/events.js'
import { v7 as uuidV7 } from 'uuid'
import { logger } from '../logging/logger.js'
import type { MultiAgentPlugin, MultiAgent } from '../multiagent/index.js'
import { MultiAgentState } from '../multiagent/state.js'
import {
  takeSnapshot as takeMultiAgentSnapshot,
  loadSnapshot as loadMultiAgentSnapshot,
} from '../multiagent/snapshot.js'
import {
  AfterMultiAgentInvocationEvent,
  AfterNodeCallEvent,
  BeforeMultiAgentInvocationEvent,
} from '../multiagent/events.js'
import type { Graph } from '../multiagent/graph.js'
import type { Swarm } from '../multiagent/swarm.js'

/**
 * Controls when `snapshot_latest` is saved automatically for agents.
 *
 * There are two kinds of snapshots:
 * - **`snapshot_latest`**: A single mutable snapshot that is overwritten on each save. Used to
 *   resume the most recent conversation state (e.g. after a crash or restart). Always reflects
 *   the last saved point in time.
 * - **Immutable snapshots**: Append-only snapshots with unique IDs (UUID v7), created only when
 *   `snapshotTrigger` fires. Used for checkpointing — you can restore to any prior state, not
 *   just the latest.
 *
 * `SaveLatestStrategy` controls how frequently `snapshot_latest` is updated:
 * - `'invocation'`: after every agent invocation completes (default; balances durability and I/O)
 * - `'message'`: after every message added and when an invocation completes
 *   (most durable, highest I/O)
 * - `'trigger'`: only when a `snapshotTrigger` fires (or manually via `saveSnapshot`)
 *
 * Under `'invocation'` and `'message'`, guardrail redactions are persisted immediately so
 * pre-redaction content never sits at rest. Under `'trigger'`, the caller's `snapshotTrigger`
 * stays in control; redactions are only flushed if the trigger fires or `saveSnapshot` is called.
 */
export type SaveLatestStrategy = 'message' | 'invocation' | 'trigger'

/**
 * Controls when `snapshot_latest` is saved for multi-agent orchestrators.
 *
 * - `'node'`: after every node invocation completes (default; enables resume
 *   from the last completed node after a crash or restart)
 * - `'invocation'`: after every orchestrator invocation completes (lower I/O,
 *   but only captures state at orchestrator invocation boundaries)
 */
export type MultiAgentSaveLatestStrategy = 'node' | 'invocation'

export interface SessionManagerConfig {
  /**
   * Storage backend for snapshot persistence.
   *
   * Accepts either:
   * - A unified {@link Storage} instance (recommended) — wrapped internally with {@link SnapshotStorageAdapter}
   * - A legacy `{ snapshot: SnapshotStorage }` object
   *
   * When omitted, resolves from the agent-level `storage` during initialization.
   * If no agent-level storage is available either, an error is thrown.
   */
  storage?: Storage | { snapshot: SnapshotStorage }
  /** Unique session identifier. Defaults to `'default-session'`. */
  sessionId?: string
  /** When to save snapshot_latest. Default: `'invocation'` (after each agent invocation completes). See {@link SaveLatestStrategy} for details. */
  saveLatestOn?: SaveLatestStrategy
  /** Callback invoked after each invocation to decide whether to create an immutable snapshot. */
  snapshotTrigger?: SnapshotTriggerCallback
  /**
   * When to save snapshot_latest for multi-agent orchestrators.
   * Default: `'node'` (after each node invocation completes).
   * See {@link MultiAgentSaveLatestStrategy} for details.
   */
  multiAgentSaveLatestOn?: MultiAgentSaveLatestStrategy
}

/**
 * Stash data envelope stored in snapshot.data.stash.
 *
 * Extends `Record<string, JSONValue>` so it is directly assignable to
 * `Snapshot.data` entries without casts.
 *
 * @internal
 */
interface InlineStashSnapshot extends Record<string, JSONValue> {
  location: 'inline'
  entries: Record<string, JSONValue>
}
interface ExternalStashSnapshot extends Record<string, JSONValue> {
  location: 'external'
  storageType: string
}
type StashSnapshotData = InlineStashSnapshot | ExternalStashSnapshot

/**
 * Manages session persistence for agents, enabling conversation state
 * to be saved and restored across invocations using pluggable storage backends.
 *
 * Also supports multi-agent orchestrators (Graph, Swarm) via the MultiAgentPlugin interface.
 * Scope is auto-detected based on whether initAgent or initMultiAgent is called.
 *
 * @example
 * ```typescript
 * import { SessionManager, FileStorage } from '@strands-agents/sdk'
 *
 * const session = new SessionManager({
 *   sessionId: 'my-session',
 *   storage: { snapshot: new FileStorage() },
 * })
 * const agent = new Agent({ sessionManager: session })
 * ```
 */
export class SessionManager implements Plugin, MultiAgentPlugin {
  private readonly _sessionId: string
  private _storage!: { snapshot: SnapshotStorage }
  private readonly _configStorage?: Storage | { snapshot: SnapshotStorage } | undefined
  private _agentStash: Stash | undefined
  private readonly _saveLatestOn: SaveLatestStrategy
  private readonly _snapshotTrigger?: SnapshotTriggerCallback | undefined
  private readonly _multiAgentSaveLatestOn: MultiAgentSaveLatestStrategy
  private _multiAgentRestoredIds = new Set<string>()

  /**
   * Unique identifier for this plugin.
   */
  get name(): string {
    return 'strands:session-manager'
  }

  /**
   * The session identifier for this session manager.
   */
  get sessionId(): string {
    return this._sessionId
  }

  constructor(config: SessionManagerConfig) {
    this._sessionId = validateIdentifier(config.sessionId ?? 'default-session')
    this._configStorage = config.storage
    if (config.storage) {
      this._storage = { snapshot: this._resolveSnapshotStorage(config.storage) }
    }
    this._saveLatestOn = config.saveLatestOn ?? 'invocation'
    this._multiAgentSaveLatestOn = config.multiAgentSaveLatestOn ?? 'node'
    this._snapshotTrigger = config.snapshotTrigger
  }

  private get _snapshotStorage(): SnapshotStorage {
    if (!this._storage) {
      throw new Error(
        'SessionManager requires a storage backend. Provide storage in SessionManagerConfig or set storage on the Agent.'
      )
    }
    return this._storage.snapshot
  }

  private _resolveSnapshotStorage(storage: Storage | { snapshot: SnapshotStorage }): SnapshotStorage {
    if ('snapshot' in storage) return storage.snapshot
    const scoped = NAMESPACED in storage ? storage : namespace(storage, 'session')
    return new SnapshotStorageAdapter(scoped)
  }

  /** Initializes the plugin by registering lifecycle hook callbacks. */
  public initAgent(agent: LocalAgent): void {
    if (!this._configStorage) {
      if (!agent.storage) {
        throw new Error(
          'SessionManager requires a storage backend. Provide storage in SessionManagerConfig or set storage on the Agent.'
        )
      }
      this._storage = { snapshot: this._resolveSnapshotStorage(agent.storage) }
    }
    this._agentStash = agent.contextManager?.stash
    agent.addHook(InitializedEvent, async (event) => {
      await this._onAgentInitialized(event)
    })
    if (this._saveLatestOn === 'message') {
      agent.addHook(MessageAddedEvent, async (event) => {
        await this._onMessageAdded(event)
      })
    }

    // Persist guardrail redactions immediately for auto-save strategies.
    // 'trigger' is an explicit opt-out from auto-saves, so the caller's snapshotTrigger
    // stays in control there.
    if (this._saveLatestOn !== 'trigger') {
      agent.addHook(AfterModelCallEvent, async (event) => {
        await this._onAfterModelCall(event)
      })
    }
    agent.addHook(AfterInvocationEvent, async (event) => {
      await this._onAfterAgentInvocation(event)
    })
  }

  private _location(agent: LocalAgent): SnapshotLocation {
    return { sessionId: this._sessionId, scope: 'agent', scopeId: agent.id }
  }

  /** Saves a snapshot of the target's current state. */
  async saveSnapshot(params: { target: LocalAgent; isLatest: boolean }): Promise<void>
  async saveSnapshot(params: { target: Graph | Swarm; state?: MultiAgentState; isLatest: boolean }): Promise<void>
  async saveSnapshot(params: {
    target: LocalAgent | Graph | Swarm
    state?: MultiAgentState
    isLatest: boolean
  }): Promise<void> {
    const isAgent = 'messages' in params.target
    const snapshot = isAgent
      ? (params.target as LocalAgent).takeSnapshot({ preset: 'session' })
      : takeMultiAgentSnapshot(params.target as Graph | Swarm, params.state)
    if (isAgent) {
      await this._includeStashData(params.target as LocalAgent, snapshot)
    }
    const snapshotId = params.isLatest ? 'latest' : uuidV7()
    const location = isAgent
      ? this._location(params.target as LocalAgent)
      : this._multiAgentLocation(params.target as MultiAgent)
    await this._snapshotStorage.saveSnapshot({ location, snapshotId, isLatest: params.isLatest, snapshot })
  }

  /** Deletes all snapshots, manifests, and stash data for this session from storage. */
  async deleteSession(): Promise<void> {
    await this._snapshotStorage.deleteSession({ sessionId: this._sessionId })
    await this._deleteStashData()
  }

  /** Lists all available immutable snapshot IDs for the given agent target. */
  async listSnapshotIds(params: { target: LocalAgent; limit?: number; startAfter?: string }): Promise<string[]> {
    return this._snapshotStorage.listSnapshotIds({
      location: this._location(params.target),
      ...(params.limit !== undefined && { limit: params.limit }),
      ...(params.startAfter !== undefined && { startAfter: params.startAfter }),
    })
  }

  /** Loads a snapshot from storage and restores it into the target. Returns false if no snapshot exists. */
  async restoreSnapshot(params: { target: LocalAgent; snapshotId?: string }): Promise<boolean>
  async restoreSnapshot(params: {
    target: Graph | Swarm
    state?: MultiAgentState
    snapshotId?: string
  }): Promise<boolean>
  async restoreSnapshot(params: {
    target: LocalAgent | Graph | Swarm
    state?: MultiAgentState
    snapshotId?: string
  }): Promise<boolean> {
    const isAgent = 'messages' in params.target
    const location = isAgent
      ? this._location(params.target as LocalAgent)
      : this._multiAgentLocation(params.target as MultiAgent)
    const snapshot = await this._snapshotStorage.loadSnapshot({
      location,
      ...(params.snapshotId !== undefined && { snapshotId: params.snapshotId }),
    })

    if (!snapshot) return false

    if (isAgent) {
      ;(params.target as LocalAgent).loadSnapshot(snapshot)
      await this._restoreStashData(params.target as LocalAgent, snapshot)
    } else {
      loadMultiAgentSnapshot(params.target as Graph | Swarm, snapshot, params.state)
    }
    return true
  }

  /** Restores session state on agent initialization. */
  private async _onAgentInitialized(event: InitializedEvent): Promise<void> {
    const hadMessages = event.agent.messages.length > 0
    const restored = await this.restoreSnapshot({ target: event.agent })

    if (restored && hadMessages) {
      logger.warn(
        `agent_id=<${event.agent.id}>, session_id=<${this._sessionId}> | agent had existing messages that were overwritten by session restore`
      )
    }

    // Stateful models manage conversation history server-side, so any messages
    // loaded from the snapshot would drift from the server's view on the next
    // invocation. Duck-type the agent's `model` since `LocalAgent` does not
    // expose it — `Agent` is the only implementor and always has one.
    const statefulModel = (event.agent as { model?: { stateful?: boolean } }).model?.stateful
    if (restored && statefulModel && event.agent.messages.length > 0) {
      logger.debug(
        `agent_id=<${event.agent.id}>, message_count=<${event.agent.messages.length}> | discarding restored messages for stateful model`
      )
      event.agent.messages.length = 0
    }
  }

  /** Saves latest for auto-save strategies and fires the snapshot trigger if configured. */
  private async _onAfterAgentInvocation(event: AfterInvocationEvent): Promise<void> {
    if (this._saveLatestOn !== 'trigger') {
      await this.saveSnapshot({ target: event.agent, isLatest: true })
    }

    if (this._snapshotTrigger?.({ agentData: event.agent })) {
      await this._saveImmutableAndLatest(event.agent)
    }
  }

  private async _onMessageAdded(event: MessageAddedEvent): Promise<void> {
    await this.saveSnapshot({ target: event.agent, isLatest: true })
  }

  /**
   * Saves snapshot when a message is redacted after a model call.
   * Critical for ensuring guardrail redactions are persisted immediately.
   */
  private async _onAfterModelCall(event: AfterModelCallEvent): Promise<void> {
    // Only save if there was a redaction
    if (event.stopData?.redaction) {
      await this.saveSnapshot({ target: event.agent, isLatest: true })
    }
  }

  /** Captures one snapshot and writes it to both immutable history and snapshot_latest. */
  private async _saveImmutableAndLatest(agent: LocalAgent): Promise<void> {
    const snapshot = agent.takeSnapshot({ preset: 'session' })
    await this._includeStashData(agent, snapshot)
    const snapshotId = uuidV7()
    await Promise.all([
      this._snapshotStorage.saveSnapshot({ location: this._location(agent), snapshotId, isLatest: false, snapshot }),
      this._snapshotStorage.saveSnapshot({
        location: this._location(agent),
        snapshotId: 'latest',
        isLatest: true,
        snapshot,
      }),
    ])
  }

  // ---------------------------------------------------------------------------
  // Stash integration
  // ---------------------------------------------------------------------------

  private async _includeStashData(agent: LocalAgent, snapshot: Snapshot): Promise<void> {
    const contextManager = agent.contextManager
    if (!contextManager?.stash) return

    if (contextManager.stashIsDurable) {
      const storageType = contextManager.stash.storageTypeName
      snapshot.data.stash = { location: 'external', storageType } satisfies StashSnapshotData
      return
    }

    const entries = await contextManager.stash.takeSnapshot()
    if (Object.keys(entries).length > 0) {
      snapshot.data.stash = { location: 'inline', entries } satisfies StashSnapshotData
    }
  }

  private async _restoreStashData(agent: LocalAgent, snapshot: Snapshot): Promise<void> {
    if (!('stash' in snapshot.data) || !snapshot.data.stash) return
    const stash = agent.contextManager?.stash
    if (!stash) return

    const stashData = snapshot.data.stash as StashSnapshotData
    if (stashData.location === 'external') {
      const currentType = stash.storageTypeName
      if (stashData.storageType && currentType && stashData.storageType !== currentType) {
        logger.warn(
          `session_id=<${this._sessionId}>, snapshot_storage=<${stashData.storageType}>, current_storage=<${currentType}> | stash storage type changed since snapshot was created, stash data may be inaccessible`
        )
      }
      return
    }
    if (stashData.location === 'inline') {
      await stash.loadSnapshot(stashData.entries)
    }
  }

  private async _deleteStashData(): Promise<void> {
    if (this._agentStash) {
      await this._agentStash.clear()
      await this._agentStash.clearSession()
    }
  }

  // ---------------------------------------------------------------------------
  // Multi-agent
  // ---------------------------------------------------------------------------

  /** Initializes the multi-agent plugin by registering orchestrator lifecycle hooks. */
  public initMultiAgent(orchestrator: MultiAgent): void {
    if (!this._storage) {
      throw new Error(
        'SessionManager requires a storage backend. Provide storage in SessionManagerConfig when using with multi-agent orchestrators.'
      )
    }
    orchestrator.addHook(BeforeMultiAgentInvocationEvent, async (event) => {
      await this._onBeforeMultiAgentInvocation(event)
    })
    if (this._multiAgentSaveLatestOn === 'node') {
      orchestrator.addHook(AfterNodeCallEvent, async (event) => {
        await this._onAfterNodeCall(event)
      })
    }
    orchestrator.addHook(AfterMultiAgentInvocationEvent, async (event) => {
      await this._onAfterMultiAgentInvocation(event)
    })
  }

  private _multiAgentLocation(orchestrator: MultiAgent): SnapshotLocation {
    return { sessionId: this._sessionId, scope: 'multiAgent', scopeId: orchestrator.id }
  }

  /** Restores orchestrator state on first invocation (loads snapshot from storage once per orchestrator, then no-ops). */
  private async _onBeforeMultiAgentInvocation(event: BeforeMultiAgentInvocationEvent): Promise<void> {
    if (this._multiAgentRestoredIds.has(event.orchestrator.id)) return
    this._multiAgentRestoredIds.add(event.orchestrator.id)

    const location = this._multiAgentLocation(event.orchestrator)
    const snapshot = await this._snapshotStorage.loadSnapshot({ location })
    if (!snapshot) return

    loadMultiAgentSnapshot(event.orchestrator as Graph | Swarm, snapshot, event.state)
  }

  /** Saves latest orchestrator snapshot after each node completes. */
  private async _onAfterNodeCall(event: AfterNodeCallEvent): Promise<void> {
    await this.saveSnapshot({
      target: event.orchestrator as Graph | Swarm,
      state: event.state,
      isLatest: true,
    })
  }

  /** Saves latest orchestrator snapshot after invocation completes. */
  private async _onAfterMultiAgentInvocation(event: AfterMultiAgentInvocationEvent): Promise<void> {
    await this.saveSnapshot({
      target: event.orchestrator as Graph | Swarm,
      state: event.state,
      isLatest: true,
    })
  }
}
