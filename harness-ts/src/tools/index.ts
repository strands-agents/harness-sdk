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
export { AgentSpec, Choice, Fixed, Inherit, Open, Option, Preset } from '@strands-agents/sdk/multiagent'
export type { AgentBuilder, PresetOptions } from '@strands-agents/sdk/multiagent'
export { makeSubagent } from '@strands-agents/sdk/vended-tools/subagent'
export type { MakeSubagentOptions } from '@strands-agents/sdk/vended-tools/subagent'
