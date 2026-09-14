# Agent Development Guide - TypeScript SDK

This document provides guidance for AI agents working on the Strands TypeScript SDK (`strands-ts/`). For human contributor guidelines, see [CONTRIBUTING.md](../CONTRIBUTING.md).

> **Cross-SDK rules live in the [root AGENTS.md](../AGENTS.md).** Plugin naming, cross-SDK parity, public/internal API marking, the structured-logging format, and the evergreen-comment rule apply to both SDKs and are stated once there — this file shows only the TypeScript-idiomatic form and the rules unique to TypeScript. When a rule applies to both SDKs, edit the root, not this file.

## Product Overview

The Strands TypeScript SDK is the TypeScript/JavaScript port of the Strands Agents framework for building AI agents with a model-driven approach. It mirrors the Python SDK in concepts and names (re-cased to TS idiom) while being idiomatic TypeScript, and runs in both Node.js and browser environments.

**Core Features:**
- Model Agnostic: Multiple model providers (Amazon Bedrock, Anthropic, OpenAI, Google, Vercel AI SDK, etc.)
- Tools: `tool()` factory with Zod schemas
- MCP Integration: Native Model Context Protocol support
- Multi-Agent Systems: Agent-to-agent, swarms, and graph patterns
- Streaming Support: Real-time response streaming via async generators
- Hooks: Event-driven extensibility for agent lifecycle
- Session Management: Pluggable session managers
- Observability: OpenTelemetry tracing and metrics

## Directory Structure

```
strands-ts/
├── src/                  # All production source code
│   ├── agent/            # Core agent loop, state, agent-as-tool
│   ├── models/           # Model provider implementations (anthropic.ts, bedrock.ts, openai/, google/, …)
│   ├── tools/            # Tool system (registry, execution, factory)
│   ├── conversation-manager/ # Message history, compression
│   ├── multiagent/       # Multi-agent orchestration (A2A, graphs, swarm)
│   ├── session/          # Session persistence
│   ├── telemetry/        # Tracing and metrics
│   ├── hooks/            # Agent lifecycle hooks
│   ├── types/            # Shared type definitions
│   └── …                 # Key subsystems shown; run `ls src/` for the full list
├── src/**/__tests__/     # Unit tests (co-located with source)
├── test/integ/           # Integration tests with real providers
├── docs/                 # Developer documentation
└── package.json          # SDK package config, dependencies, npm scripts
```

## Development Workflow

### 1. Environment Setup

See [CONTRIBUTING.md - TypeScript SDK](../CONTRIBUTING.md#typescript-sdk) for prerequisites (Node.js 22+, npm), installation, and verification commands.

### 2. Making Changes

1. **Create feature branch**: `git checkout -b agent-tasks/{ISSUE_NUMBER}`
2. **Implement changes** following the patterns below
3. **Run quality checks** before committing (pre-commit hooks will run automatically)
4. **Commit with conventional commits**: `feat:`, `fix:`, `refactor:`, `docs:`, etc.
5. **Push to remote**: `git push origin agent-tasks/{ISSUE_NUMBER}`
6. **Create pull request** following [PR.md](../team/PR.md) guidelines

### 3. Pull Request Guidelines

When creating pull requests, you **MUST** follow the guidelines in [PR.md](../team/PR.md) and use the [PR template](../.github/PULL_REQUEST_TEMPLATE.md).

### 4. Quality Gates

Pre-commit hooks run automatically and must all pass: build (`npm run build`), unit tests with coverage (`npm run test:coverage`), linting (`npm run lint`), format check (`npm run format:check`), and type check (`npm run type-check`).

**ESLint and Prettier already enforce formatting (no semicolons, single quotes, 120 cols), the `no-explicit-any` and `explicit-function-return-type` rules, and TSDoc syntax.** This guide does not re-list those — it covers the conventions a linter *cannot* check. When a rule below says "enforced by review," it means exactly that: no tool catches it, so it is on you and the reviewer.

### 5. Testing Guidelines

When writing tests, you **MUST** follow the guidelines in [docs/TESTING.md](./docs/TESTING.md); see [Testing](#testing) below.

## Coding Patterns and Best Practices

### Logging

Structured logging is a cross-SDK rule — see the format in the [root AGENTS.md](../AGENTS.md). The TypeScript-idiomatic form uses template literals (never printf `%s`/`%d`):

```typescript
logger.warn(`stop_reason=<${stopReason}>, fallback=<${fallback}> | unknown stop reason, converting to camelCase`)
logger.warn('cache points are not supported in openai system prompts, ignoring cache points')  // no context fields
```

### TypeScript Type Safety

**Optional chaining for null safety**: prefer optional chaining over verbose `typeof` checks when accessing potentially undefined properties:

```typescript
// Good
return globalThis?.process?.env?.API_KEY

// Bad
if (typeof process !== 'undefined' && typeof process.env !== 'undefined') {
  return process.env.API_KEY
}
return undefined
```

**Strict requirements** (beyond what ESLint catches):

- **Function and method *signatures* MUST have explicit return types** (ESLint enforces this). Let TypeScript infer the types of *local variables and intermediate expressions* — don't annotate those redundantly.
- Never use `any` (enforced by ESLint). Reach for `unknown` (then narrow) when a type is genuinely open.
- Use TypeScript strict-mode features.

**`interface` vs `type` alias**: Use an `interface` for object shapes — model configs, `*Options`/`*Config` bags, data blocks, capability contracts — and prefer `extends` for composition (even when extending an interface in the same file). Use a `type` alias only when the type is *not* a plain object shape: unions (including discriminated unions), string-literal unions, intersections, function types, or mapped/conditional/utility-derived types.

```typescript
// Good — object shape as an interface, composed with extends
interface AnthropicModelConfig extends BaseModelConfig { maxTokens?: number }
interface AnthropicModelOptions extends AnthropicModelConfig { apiKey?: string }

// Good — type alias for a discriminated union (not an object shape)
type OpenAIModelOptions =
  | ({ api?: 'responses' } & OpenAIResponsesConfig & OpenAIClientOptions)
  | ({ api: 'chat' } & OpenAIChatConfig & OpenAIClientOptions)
```

The model-provider config family (`BaseModelConfig` and each `{Provider}ModelConfig`/`{Provider}ModelOptions`) is the reference pattern. A handful of older object shapes are still `type X = { ... }` (e.g. `AgentConfig`, `ConversationManagerOptions`, `SessionStorage`) — migrate them to `interface` on next touch, don't rewrite them en masse.

**Optional properties**: `tsconfig` enables `exactOptionalPropertyTypes`, which makes `prop?: T` and `prop?: T | undefined` semantically distinct. Write the bare `prop?: T` form (the overwhelming majority); only add `| undefined` when a caller genuinely needs to pass an explicit `undefined`.

### Naming Conventions

- **Private class fields**: underscore prefix (`private readonly _config: Config`, `private _state: State`).
- **Name every variable for its content**, including short-lived loop/catch bindings — `event`, `index`, `error`, never `e`/`i`/`x` (e.g. `for (const message of messages)`, not `for (const m of messages)`).
- **Plugin / construct naming** and **cross-SDK literal parity** are cross-SDK rules — see the [root AGENTS.md](../AGENTS.md). In short: name a construct for what it does (`AgentSkills`, not `AgentSkillsPlugin`); match the Python literal re-cased to TS idiom; single-word string-literal *values* are byte-identical, multi-word ones are camelCased in TS (`tool_use` → `toolUse`, via `STOP_REASON_MAP` / `snakeToCamel`, never emitted ad hoc); wire field *names* keep their wire format (`inputSchema`, `tool_use_id`).

### Import Organization

Order imports: (1) external dependencies, (2) internal modules via relative paths, (3) type-only imports (`import type { … }`).

### File Organization

- **Test file locations and naming** are defined in [docs/TESTING.md](./docs/TESTING.md) (see [Testing](#testing) below).
- **Function ordering within a file** reads top-down, most general to most specific: main entry-point/exported functions at the top, private helpers below in order of use.
- **Keep functions small and focused** — a single responsibility each.

### Public API Surface

Public/internal marking is a cross-SDK rule — see the [root AGENTS.md](../AGENTS.md). The TypeScript-idiomatic form:

- **Named exports only — never `export default`.** The codebase has zero default exports.
- **Convey module privacy by *not* re-exporting from the barrel (`index.ts`)**, not by an `_`-prefixed filename. Unlike the Python SDK, TS has no `_`-prefixed module files; an internal-but-cross-module symbol gets the `@internal` TSDoc tag instead (see the `CancelledError` intentional-omission comment in `index.ts`).
- **Source and test files are kebab-case** (`tool-caller.ts`, `agent-skills.ts`); the class/type *inside* keeps its PascalCase. No linter checks filename casing, so this is a review item.

### Documentation Requirements

TSDoc is required on all exported functions, classes, and interfaces (syntax enforced by ESLint). The judgment rules a linter can't check:

- Include `@param` for all parameters and `@returns` for return values.
- Include `@example` only for exported classes (main SDK entry points like `BedrockModel`, `Agent`); do **NOT** add `@example` to type definitions, interfaces, or internal types.
- Include `@throws` on an exported function/method that can throw as part of its contract — name the error type and the condition (the TS counterpart to Python's `Raises:`).
- Interface properties MUST have single-line descriptions.
- Mark non-public exports with the `@internal` tag (it may also be applied to non-exported symbols for clarity).

### Dependency Management

When adding or modifying dependencies, you **MUST** follow [docs/DEPENDENCIES.md](./docs/DEPENDENCIES.md). Key points:

- **`dependencies`**: core SDK functionality users don't interact with directly
- **`peerDependencies`**: dependencies that cross API boundaries (users construct/pass instances)
- **`devDependencies`**: build tools, testing frameworks, linters — not shipped to users

**Rule**: if a dependency crosses an API boundary, it **MUST** be a peer dependency.

### Error Handling

- Handle errors explicitly; prefer optional chaining over verbose `typeof` checks for possibly-undefined access.
- **Model providers translate vendor errors into the SDK's typed errors** — context-window / token overflow → `ContextWindowOverflowError`, throttling / 429 → `ModelThrottledError` — and **preserve the original via the `cause` option** (`new ModelThrottledError(message, { cause: error })`). Never let a raw vendor error escape the provider boundary (see `models/openai/errors.ts`, `models/google/errors.ts`).
- Document thrown errors with `@throws` (see Documentation Requirements).

## Adding a Model Provider

The model provider is the most-repeated pattern in the SDK; `models/anthropic.ts` is the cleanest reference.

- **`export class XModel extends Model<XModelConfig>`** with `private _config` and `private _client`.
- **Two interfaces**: `interface XModelConfig extends BaseModelConfig` (the model knobs) and a superset `interface XModelOptions extends XModelConfig` adding client/credential fields (`apiKey`, `client`, `clientConfig`). The constructor takes `XModelOptions`, destructures the client fields, and spreads the rest into `_config`.
- **Implement the base contract** from `models/model.ts`: `updateConfig(modelConfig)` (spread-merge into `_config`), `getConfig()` (return `resolveConfigMetadata(this._config, this._config.modelId ?? <default>)`), and `async *stream(...)`. `structuredOutput` is **not** part of the TS provider contract — TS does structured output via a tool + agent config (`tools/structured-output-tool.ts`, `AgentConfig.structuredOutputSchema`), not a provider method.
- **Keep conversion private** (`_formatRequest`, `_formatMessages`, `_formatContentBlock`). Default to a **flat `models/<name>.ts`**; only reach for a `models/<name>/` subdirectory with standalone adapter modules + `types.ts`/`errors.ts` when the provider spans **multiple API surfaces** (the reason `openai/` exists — chat vs responses).

```typescript
export interface XModelConfig extends BaseModelConfig {
  maxTokens?: number
}
export interface XModelOptions extends XModelConfig {
  apiKey?: string
  client?: VendorClient
}

export class XModel extends Model<XModelConfig> {
  private _config: XModelConfig
  private _client: VendorClient

  updateConfig(modelConfig: XModelConfig): void {
    this._config = { ...this._config, ...modelConfig }
  }

  getConfig(): XModelConfig {
    return resolveConfigMetadata(this._config, this._config.modelId ?? MODEL_DEFAULTS.x.modelId)
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    // map vendor errors to ContextWindowOverflowError / ModelThrottledError with { cause }
  }
}
```

### Async & Streaming

- **`stream` is an async generator** typed `async *stream(messages, options?): AsyncIterable<ModelStreamEvent>`, matching the abstract base exactly. Consume async iterables with `for await`.
- **Providers emit raw `ModelStreamEvent`s and must not buffer the whole response.** The base `Model.streamAggregated` performs event accumulation on top of `stream`.
- **The SDK is async-only — no sync facade.** `invoke()` returns a `Promise`; there is no blocking equivalent (unlike the Python SDK's `__call__`).
- **Cancellation uses `AbortSignal`.** Tools receive the execution-scoped signal through `ToolContext.cancelSignal`, and tool middleware through `ExecuteToolContext.cancelSignal`; foreground and direct tool execution use `agent.cancelSignal`. Callers may pass an external `cancelSignal` via `invoke`/`stream` options (merged with `AbortSignal.any`). When merging concurrent async generators, race `.next()` with `Promise.race` and close the rest with `Promise.allSettled(gen.return())` in `finally`; use `Promise.all`/`allSettled` for simple fan-out.

## Testing

When writing tests, you **MUST** follow [docs/TESTING.md](./docs/TESTING.md). It is the authoritative reference for test file location and naming (co-location, environment suffixes), the nested `describe` pattern, batching strategy, whole-object assertions, fixtures, coverage requirements, and multi-environment testing.

## Quick Rules

The un-lintable rules an agent most often misses — every one is **enforced by review**, not tooling (formatting, `no-explicit-any`, explicit return types, and TSDoc syntax are already handled by ESLint/Prettier; run `npm run lint`). Cross-SDK rules (plugin naming, parity, public/internal marking, logging format, evergreen comments) are in the [root AGENTS.md](../AGENTS.md).

**Do:**
- Use an `interface` for object shapes (with `extends`); a `type` alias only for unions/intersections/function/mapped types
- Use **named exports only**; convey privacy by barrel omission + `@internal`, never an `_`-prefixed filename
- Name source/test files kebab-case (the class inside stays PascalCase)
- Document errors with `@throws`; reserve `@example` for entry-point classes, never type defs
- Translate vendor errors to typed SDK errors and preserve `{ cause }`
- Prefer the bare `prop?: T` optional form under `exactOptionalPropertyTypes`
- Name every variable for its content, even short-lived loop/catch bindings (`event`/`index`/`error`, never `e`/`i`/`x`)

**Don't:**
- `export default` — named exports only
- Use printf-style placeholders (`%s`, `%d`) in logs — use template literals
- Put unit tests in a separate `tests/` directory (use `src/**/__tests__/`)
- Annotate local variables with redundant explicit types (infer locals; annotate signatures)
- Let a raw vendor error escape a provider boundary

## Development Commands

```bash
npm test              # Run unit tests in Node.js
npm run test:browser  # Run unit tests in browser (Chromium via Playwright)
npm run test:all      # Run all tests in all environments
npm run test:integ    # Run integration tests
npm run test:coverage # Run tests with coverage report
npm run lint          # Check code quality
npm run format        # Auto-fix formatting
npm run type-check    # Verify TypeScript types
npm run build         # Compile TypeScript
```

## Agent-Specific Notes

### Writing Code

- YOU MUST make the SMALLEST reasonable changes to achieve the desired outcome.
- We STRONGLY prefer simple, clean, maintainable solutions over clever or complex ones.
- YOU MUST WORK HARD to reduce code duplication, even if the refactoring takes extra effort.
- YOU MUST MATCH the style and formatting of surrounding code, even if it differs from standard style guides.
- Fix broken things immediately when you find them. Don't ask permission to fix bugs.

### Code Comments

Comments are to-the-point, state only what cannot be inferred from the code, and stay evergreen. The full rule (including how it applies to tests, and the deprecated/legacy nuance) is in the [root AGENTS.md](../AGENTS.md).

### Integration with Other Files

- **CONTRIBUTING.md**: testing/setup commands and human contribution guidelines
- **docs/TESTING.md**: comprehensive testing guidelines (MUST follow when writing tests)
- **docs/DEPENDENCIES.md**: dependency-management rules
- **team/PR.md**: pull request guidelines and template
- **package.json** / **strands-ts/package.json**: workspace and SDK package config

## Additional Resources

- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)
- [Vitest Documentation](https://vitest.dev/)
- [TSDoc Reference](https://tsdoc.org/)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [Strands Agents Documentation](https://strandsagents.com/)
