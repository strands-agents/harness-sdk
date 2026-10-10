/**
 * Strands harness: a preconfigured, opinionated Strands agent in one call.
 */

export { createHarness, type HarnessAgentOptions } from './agent.js'
export {
  BUILTIN_PLUGIN_NAMES,
  BUILTIN_TOOL_NAMES,
  DEFAULT_HARNESS_AGENT_CONFIG,
  defineHarnessAgentConfig,
  harnessAgentOptionsFromConfig,
  type BuiltinPluginName,
  type BuiltinToolName,
  type HarnessAgentConfig,
  type HarnessConfigBuiltinTools,
  type HarnessConfigContextManager,
  type HarnessConfigMemory,
  type HarnessConfigWebFetch,
  type HarnessDependencies,
  type HarnessModuleKind,
  type HarnessModuleLanguage,
  type HarnessModuleReference,
} from './config.js'
export { HARNESS_CONTRACT, buildSystemPrompt } from './prompt.js'
export type {
  BuiltinToolsConfig,
  ContextManagerOption,
  Effort,
  MemoryConfig,
  ProgrammaticToolCallerConfig,
  ReadConfig,
  SessionConfig,
  ShellConfig,
  SubagentConfig,
  ToolConfig,
  WebFetchConfig,
  WebFetchTransport,
  WebSearchSetting,
} from './types/agent.js'
export { supportsThinking, supportsWebSearch } from './models.js'
export { type InterventionsOption } from './interventions.js'
export { configureLogging } from './logging.js'
export {
  AgentSpec,
  Choice,
  DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION,
  edit,
  exaWebSearch,
  Fixed,
  Inherit,
  makeExaWebSearch,
  makeProgrammaticToolCaller,
  makeSubagent,
  makeWebFetch,
  Open,
  Option,
  Preset,
  programmaticToolCaller,
  read,
  write,
} from './tools/index.js'
export type {
  AgentBuilder,
  ContextAxis,
  ContextMode,
  InstructionsMode,
  MakeProgrammaticToolCallerOptions,
  MakeSubagentOptions,
  MakeWebFetchOptions,
  ModelMode,
  PresetOptions,
  ToolsMode,
} from './tools/index.js'
export { EnvironmentContext, Todos } from './plugins/index.js'
export type { EnvironmentContextConfig, TodoItem } from './plugins/index.js'
