/**
 * Harness-authored tools.
 *
 * Thin, self-contained tools that fill gaps in the SDK's vended set. Each is a candidate to port
 * into the core SDK later; keep them minimal and SDK-idiomatic.
 */

export { edit, makeRead, read, write } from './file-tools.js'
export {
  DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION,
  makeProgrammaticToolCaller,
  programmaticToolCaller,
} from './programmatic-tool-caller.js'
export type { MakeProgrammaticToolCallerOptions } from './programmatic-tool-caller.js'
export { makeWebFetch } from './web-fetch.js'
export type { MakeWebFetchOptions } from './web-fetch.js'
export { exaWebSearch, makeExaWebSearch } from './web-search.js'
export { AgentSpec, Choice, Fixed, Inherit, makeSubagent, Open, Option, Preset } from './subagent.js'
export type {
  AgentBuilder,
  ContextAxis,
  ContextMode,
  InstructionsMode,
  MakeSubagentOptions,
  ModelMode,
  PresetOptions,
  ToolsMode,
} from './subagent.js'
