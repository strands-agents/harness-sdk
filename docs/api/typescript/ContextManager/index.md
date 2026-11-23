Defined in: [src/context-manager/context-manager.ts:86](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/context-manager.ts#L86)

Manages context reduction for an agent’s conversation.

On context overflow, runs the strategy pipeline (offload, summarize, emergency truncate). The emergency truncation is always appended as the final strategy — it fires only if the window is still overflowing after the user strategies have run.

Configured through the Agent’s `contextManager` parameter — pass a preset string (`'auto'`, or the experimental `'agentic'`), a `ContextManagerConfig`, or a `ContextManager` instance; the Agent registers the manager. When present, it owns overflow recovery and proactive compression — no separate ConversationManager is needed.

## Implements

-   [`Plugin`](/docs/api/typescript/Plugin/index.md)

## Constructors

### Constructor

```ts
new ContextManager(config?): ContextManager;
```

Defined in: [src/context-manager/context-manager.ts:101](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/context-manager.ts#L101)

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `config?` | [`ContextManagerConfig`](/docs/api/typescript/ContextManagerConfig/index.md) | The strategies and archive to use; the default pipeline when omitted |

#### Returns

`ContextManager`

#### Throws

Error when the strategies hold more than one `Offload.defer` strategy, the `deferredToolLoading` preset included

## Properties

### name

```ts
readonly name: "strands:context-manager" = 'strands:context-manager';
```

Defined in: [src/context-manager/context-manager.ts:87](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/context-manager.ts#L87)

A stable string identifier for the plugin. Used for logging, duplicate detection, and plugin management.

For strands-vended plugins, names should be prefixed with `strands:`.

#### Implementation of

[`Plugin`](/docs/api/typescript/Plugin/index.md).[`name`](/docs/api/typescript/Plugin/index.md#name)

## Accessors

### archive

#### Get Signature

```ts
get archive(): Archive;
```

Defined in: [src/context-manager/context-manager.ts:224](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/context-manager.ts#L224)

The L1 archive instance, if archive is enabled and the agent has been initialized.

##### Returns

`Archive`

The archive, or undefined if archive is disabled or initAgent has not run

---

### archiveIsDurable

#### Get Signature

```ts
get archiveIsDurable(): boolean;
```

Defined in: [src/context-manager/context-manager.ts:234](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/context-manager.ts#L234)

Whether the archive is backed by durable storage that survives process restarts. When true, archive data does not need to be embedded in session snapshots.

##### Returns

`boolean`

true if the archive storage is not ephemeral

---

### stash

#### Get Signature

```ts
get stash(): Archive;
```

Defined in: [src/context-manager/context-manager.ts:242](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/context-manager.ts#L242)

##### Deprecated

Renamed to [ContextManager.archive](#archive). Removed in the next minor.

##### Returns

`Archive`

The archive, or undefined if archive is disabled or initAgent has not run

---

### stashIsDurable

#### Get Signature

```ts
get stashIsDurable(): boolean;
```

Defined in: [src/context-manager/context-manager.ts:250](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/context-manager.ts#L250)

##### Deprecated

Renamed to [ContextManager.archiveIsDurable](#archiveisdurable). Removed in the next minor.

##### Returns

`boolean`

true if the archive storage is not ephemeral

## Methods

### from()

```ts
static from(strategy): ContextManager;
```

Defined in: [src/context-manager/context-manager.ts:120](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/context-manager.ts#L120)

Resolves a `ContextManagerStrategy` value into a `ContextManager` instance.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `strategy` | [`ContextManagerStrategy`](/docs/api/typescript/ContextManagerStrategy/index.md) | A preset string, config object, ContextManager instance, false, or undefined |

#### Returns

`ContextManager`

The instance as-is; a new ContextManager for preset strings and configs; undefined for false/undefined

---

### getTools()

```ts
getTools(): Tool[];
```

Defined in: [src/context-manager/context-manager.ts:134](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/context-manager.ts#L134)

Returns tools provided by this plugin for auto-registration. Called after [initAgent](/docs/api/typescript/Plugin/index.md#initagent) resolves; may depend on state set there.

#### Returns

[`Tool`](/docs/api/typescript/Tool/index.md)\[\]

Array of tools to register with the agent

#### Implementation of

[`Plugin`](/docs/api/typescript/Plugin/index.md).[`getTools`](/docs/api/typescript/Plugin/index.md#gettools)

---

### initAgent()

```ts
initAgent(agent): Promise<void>;
```

Defined in: [src/context-manager/context-manager.ts:156](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/context-manager.ts#L156)

Initialize the plugin with the agent instance.

Implement this method to register hooks and perform custom initialization. Tool registration from [getTools](/docs/api/typescript/Plugin/index.md#gettools) is handled automatically by the PluginRegistry.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `agent` | `LocalAgent` | The agent instance this plugin is being attached to |

#### Returns

`Promise`<`void`\>

#### Implementation of

[`Plugin`](/docs/api/typescript/Plugin/index.md).[`initAgent`](/docs/api/typescript/Plugin/index.md#initagent)