import { createAgent } from '../src/agent-factory.js'
import { bash } from '../../../strands-ts/src/vended-tools/bash/index.js'
import { makeKvStore } from '../src/tools/kv-store.js'
import { scenario } from '../src/scenario.js'
import { toolPairingIntact, historyWellFormed, contextUnderWindow, stateConsistent } from '../src/invariants.js'
import type { ProfilerObserver } from '../src/observer.js'

const WINDOW = 12
const UNRELIABLE = process.env.CHAOS === '1'

export default scenario({
  description: 'Agent maintains a long-running session building a complex plugin-system configuration across 25 invocations. The KV store returns verbose paginated JSON with version numbers. Later turns must retrieve and parse earlier decisions from the store before extending the design.',
  stresses: `Conversational coherence across 25 invocations where the KV store returns verbose JSON (with version numbers, metadata, pagination on list). Under window=12, the prose of turns 1-13 is evicted. The ONLY durable record of early decisions is the KV store — the agent must re-read and parse verbose responses to stay consistent. With CHAOS=1, ~15% of reads immediately after writes return stale data, forcing the agent to retry reads. Each step explicitly names which prior keys to retrieve, creating a dense cross-reference graph.`,
  dimensions: ['context-management', 'state-consistency'],
  run,
})

async function run(profiler: ProfilerObserver) {
  const kv = makeKvStore({ pageSize: 8, unreliable: UNRELIABLE })

  const agent = createAgent(profiler, {
    systemPrompt: `You are a system designer building a plugin-system configuration incrementally. Use the kv store to persist your design decisions.

IMPORTANT NOTES ON THE KV STORE:
- kv_get returns JSON with {found, key, value, version} — parse the "value" field for your stored content
- kv_set returns JSON with {success, key, version} — check "success" is true
- kv_list returns paginated results {keys, totalKeys, hasMore, nextCursor} — follow pagination if hasMore=true
- If you get a STALE_READ warning, retry the read
- Store your decisions as structured text that can be parsed later

Before extending or modifying any subsystem, retrieve the specific prior keys named in the request with kv_get so your new decision is consistent with them. Use bash only if you need to inspect existing code for reference. Your design must remain internally consistent — later decisions must not contradict earlier ones.`,
    tools: [bash, ...kv.tools],
    windowSize: WINDOW,
  })

  const tasks = [
    // Foundation (1-4)
    'We are designing a plugin system config. Define the plugin interface: fields a plugin declaration needs (name, id, version, entryPoint, capabilities, author, license, minHostVersion). Store under "plugin-interface".',

    'Retrieve "plugin-interface". Define lifecycle hooks: init, activate, deactivate, dispose, upgrade, healthCheck. Each hook has a timeout, retry policy, and required capabilities. Must be compatible with interface fields. Store under "lifecycle-hooks".',

    'Retrieve "plugin-interface". Define the versioning scheme: semver format, what constitutes breaking/minor/patch changes, pre-release labels, and how the "version" field is validated. Store under "versioning".',

    'Retrieve "plugin-interface" and "versioning". Define dependency resolution: plugins declare deps by id + version range (using your semver scheme). Define resolution algorithm (topological sort), circular dependency detection, and optional vs required deps. Store under "dependency-resolution".',

    // Core subsystems (5-10)
    'Retrieve "plugin-interface" and "lifecycle-hooks". Define instance configuration schema: fields for a running plugin instance, which lifecycle hooks it subscribes to, resource limits (memory, CPU, connections), and how config references the interface. Store under "instance-config".',

    'Retrieve "plugin-interface". Define the permissions model: capability types (filesystem, network, database, ipc, ui), grant levels (full, restricted, deny), inheritance rules, and how they map to the "capabilities" field. Store under "permissions".',

    'Retrieve "dependency-resolution" and "instance-config". Define plugin groups: bundles of instances with shared config overrides, group-level dependency constraints, and activation ordering rules. Store under "plugin-groups".',

    'Retrieve "permissions" and "plugin-groups". Define sandboxing: isolation modes (process, thread, wasm), resource enforcement per sandbox, how permissions map onto sandbox boundaries for instances vs groups, and escape hatches for trusted plugins. Store under "sandboxing".',

    'Retrieve "lifecycle-hooks" and "permissions". Define telemetry: which hook transitions emit events, event schema (timestamp, pluginId, hookName, duration, outcome), required permissions for collection, and sampling rates. Store under "telemetry".',

    'Retrieve "lifecycle-hooks" and "dependency-resolution". Define error handling: failure modes per hook type, retry semantics, cascade rules (if A depends on B and B fails), circuit breaker thresholds, and graceful degradation. Store under "error-handling".',

    // Advanced features (11-17)
    'Retrieve "dependency-resolution", "plugin-groups", and "error-handling". Define hot-reload: add/remove/upgrade at runtime, constraints from dependencies and groups, rollback on failure, state migration during reload, and cooldown periods. Store under "hot-reload".',

    'Retrieve "instance-config", "permissions", and "versioning". Define config validation: rules to validate before load (required fields present, permissions known, version well-formed, resource limits within bounds, no conflicting capabilities). Store under "config-validation".',

    'Retrieve "versioning", "instance-config", and "dependency-resolution". Define migration: how instance configs evolve across versions, migration scripts with rollback, dependent notification protocol, and data format versioning. Store under "migration".',

    'Retrieve "instance-config", "plugin-groups", and "hot-reload". Define persistence: storage backends (file, database, remote), serialization format, restore ordering respecting dependencies, in-flight reload handling, and consistency guarantees (eventual vs strong). Store under "persistence".',

    'Retrieve "telemetry", "error-handling", and "permissions". Define audit policy: which errors and telemetry events are recorded, retention periods, access control to audit logs, alert rules for critical failures, and compliance tagging. Store under "audit-policy".',

    'Retrieve "config-validation", "migration", and "versioning". Define compatibility matrix: host-version to plugin-version mapping, feature flags per host version, deprecation timeline, and automated compatibility checking during config validation. Store under "compatibility-matrix".',

    'Retrieve "sandboxing", "hot-reload", and "telemetry". Define resource quotas: per-plugin and per-group resource budgets, enforcement mechanisms in sandboxes, telemetry for quota usage, and behavior on quota breach (throttle vs kill). Store under "resource-quotas".',

    // Integration layer (18-22)
    'Retrieve "permissions", "sandboxing", and "resource-quotas". Define inter-plugin communication: IPC mechanisms (events, shared memory, RPC), required permissions for each, sandbox crossing rules, and rate limiting per channel. Store under "ipc".',

    'Retrieve "lifecycle-hooks", "ipc", and "plugin-groups". Define service discovery: how plugins register services, lookup protocol, load balancing across group instances, health-check integration, and stale-service eviction. Store under "service-discovery".',

    'Retrieve "config-validation", "persistence", and "compatibility-matrix". Define deployment: packaging format, registry protocol, signature verification, staged rollout (canary → full), and rollback triggers. Store under "deployment".',

    'Retrieve "audit-policy", "deployment", and "error-handling". Define incident response: automated responses to cascading failures, plugin isolation procedures, forensic data capture, and recovery playbooks. Store under "incident-response".',

    'Retrieve "ipc", "service-discovery", and "resource-quotas". Define scaling: horizontal plugin scaling rules, load-based auto-scaling, shared-state consistency across replicas, and quota redistribution during scale events. Store under "scaling".',

    // Synthesis (23-25)
    'Retrieve "deployment", "incident-response", and "scaling". Define the operational runbook: startup sequence, shutdown sequence, upgrade procedure, disaster recovery, and health-check endpoints. Store under "operational-runbook".',

    'Call kv_list (follow pagination to get ALL keys). Verify you have exactly 23 stored decisions. Report any missing keys.',

    'Retrieve ALL 23 keys one by one. Produce a final coherent summary that groups them into layers (Core, Lifecycle, Security, Operations) and explicitly calls out any cross-references between subsystems. Flag any contradictions between earlier and later decisions.',
  ]

  for (const task of tasks) {
    profiler.recordInvocationInput(task)
    const result = await agent.invoke(task, { limits: { turns: 12 } })
    profiler.recordResult(result)
  }

  profiler.recordInvariants(
    toolPairingIntact(agent.messages),
    historyWellFormed(agent.messages),
    contextUnderWindow(agent.messages, WINDOW),
  )

  // State oracle: verify all expected keys are present and non-empty
  const expectedKeys = [
    'plugin-interface', 'lifecycle-hooks', 'versioning', 'dependency-resolution',
    'instance-config', 'permissions', 'plugin-groups', 'sandboxing', 'telemetry',
    'error-handling', 'hot-reload', 'config-validation', 'migration', 'persistence',
    'audit-policy', 'compatibility-matrix', 'resource-quotas', 'ipc',
    'service-discovery', 'deployment', 'incident-response', 'scaling', 'operational-runbook',
  ]

  const allStored = kv.getAll()
  const present = new Set(Object.keys(allStored))
  const missing = expectedKeys.filter(k => !present.has(k))
  const empty = expectedKeys.filter(k => present.has(k) && (!allStored[k] || allStored[k].trim() === ''))

  profiler.recordInvariants(
    stateConsistent(
      'session-state-accumulated',
      missing.length === 0 && empty.length === 0,
      missing.length === 0 && empty.length === 0
        ? `all ${expectedKeys.length} design decisions persisted and non-empty (${present.size} keys total in store)`
        : `missing keys: [${missing.join(', ')}]; empty keys: [${empty.join(', ')}]`,
    ),
  )
}
