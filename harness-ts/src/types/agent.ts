/**
 * Option types for {@link createHarness}. Mirrors the SDK's `src/types/agent.ts` layout.
 *
 * Naming: `*Config` is a data shape (also the JSON-expressible form), `*Option` (singular) is the
 * union of what the like-named option accepts, and `HarnessAgentOptions` (in `agent.ts`) is the
 * config plus runtime-only fields.
 */

import type { AgentConfig, MemoryStore, Model, ModelRouter } from '@strands-agents/sdk'

import type {
  BuiltinToolName,
  ProgrammaticToolCallerConfig,
  ReadConfig,
  ShellConfig,
  SubagentConfig,
  WebSearchSetting,
} from '../config.js'

/** Reasoning effort applied to the resolved model; see `HarnessAgentOptions.effort`. */
export type Effort = 'auto' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** How `web_fetch` makes its request: `curl` inside the agent's sandbox, or `direct` from the process. */
export type WebFetchTransport = 'curl' | 'direct'

/** Per-tool config for the `web_fetch` built-in: `HarnessConfigWebFetch` with a live model allowed. */
export interface WebFetchConfig {
  /**
   * Model the `web_fetch` summarizer runs on: a `Model` or `ModelRouter` instance, a
   * `"provider/name"` string, or `undefined` (the default) to use the small fast model for the main
   * agent's provider so credentials align. A router uses its concrete default model.
   */
  model?: Model | ModelRouter | string
  /**
   * `'curl'` (the default) runs the request as `curl` inside the agent's `sandbox`, so the sandbox's
   * network controls apply; `'direct'` issues it from the harness process with global `fetch`, bypassing
   * the sandbox.
   */
  transport?: WebFetchTransport
}

export type { ProgrammaticToolCallerConfig, ReadConfig, ShellConfig, SubagentConfig, WebSearchSetting }

/** Per-tool config; `never` for tools that have none, so `{ read: {} }` is a type error. */
export type ToolConfig<K extends BuiltinToolName> = K extends 'read'
  ? ReadConfig
  : K extends 'shell'
    ? ShellConfig
    : K extends 'web_fetch'
      ? WebFetchConfig
      : K extends 'programmatic_tool_caller'
        ? ProgrammaticToolCallerConfig
        : K extends 'subagent'
          ? SubagentConfig
          : never

/**
 * Edits to the default built-in tool set. `false` disables a tool, `true` enables it, and a
 * per-tool config object enables and configures it (`web_search` takes `'exa'` instead, its
 * third-party fallback). The `'*'` key (default `true`) includes the harness's defaults; write `false` to
 * start from nothing and enable tools one by one.
 */
export type BuiltinToolsConfig = { '*'?: boolean } & {
  [K in BuiltinToolName]?: K extends 'web_search' ? WebSearchSetting : boolean | ToolConfig<K>
}

/** Session persistence. `true`/`{}` selects the defaults. */
export interface SessionConfig {
  /**
   * Identifier for the session's stored state (sanitized to `[a-z0-9_-]`). Defaults to a fresh
   * random 8-hex id each run; pass the id from a previous run (`agent.sessionId`) to resume it.
   */
  id?: string
  /** Root directory for session state and offloaded artifacts. Defaults to `'./.agent/sessions'`. */
  dir?: string
}

/**
 * The harness's default long-term memory. `true`/`{}` selects the defaults. Harness-level keys only; for a
 * different policy pass the SDK's `memoryManager` instead.
 */
export interface MemoryConfig {
  /** Directory the default file store's files live in. Defaults to `'./.agent/memory'`. */
  dir?: string
  /**
   * Replaces the default file store while keeping the harness's memory policy (injection on,
   * `search_memory` on, no `add_memory` tool). Unlike a full `memoryManager`, the `subagent`
   * delegate shares these stores read-only.
   */
  stores?: MemoryStore[]
}

/**
 * Exactly the SDK's `AgentConfig.contextManager` type (`'auto' | 'agentic' | ContextManager |
 * false`) plus `null`, which like `false` disables SDK-managed context.
 */
export type ContextManagerOption = NonNullable<AgentConfig['contextManager']> | null
