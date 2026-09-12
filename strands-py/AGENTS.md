# Agent Development Guide - Python SDK

This document provides context, patterns, and guidelines for AI coding assistants working on the Strands Python SDK (`strands-py/`). For human contributors, see [CONTRIBUTING.md](../CONTRIBUTING.md).

> **Cross-SDK rules live in the [root AGENTS.md](../AGENTS.md).** Plugin naming, cross-SDK parity, public/internal API marking, the structured-logging format, and the evergreen-comment rule apply to both SDKs and are stated once there — this file shows only the Python-idiomatic form and the rules unique to Python. When a rule applies to both SDKs, edit the root, not this file.

## Product Overview

Strands Agents is an open-source Python SDK for building AI agents with a model-driven approach. It provides a lightweight, flexible framework that scales from simple conversational assistants to complex autonomous workflows.

**Core Features:**
- Model Agnostic: Multiple model providers (Amazon Bedrock, Anthropic, OpenAI, Gemini, Ollama, etc.)
- Python-Based Tools: Simple `@tool` decorator with hot reloading
- MCP Integration: Native Model Context Protocol support
- Multi-Agent Systems: Agent-to-agent, swarms, and graph patterns
- Streaming Support: Real-time response streaming
- Hooks: Event-driven extensibility for agent lifecycle
- Session Management: Pluggable session managers (file, S3, custom)
- Observability: OpenTelemetry tracing and metrics

## Directory Structure

```
strands-py/
├── src/strands/          # All production source code
│   ├── agent/            # Core agent loop, state, conversation management
│   ├── models/           # Model provider implementations (Bedrock, OpenAI, etc.)
│   ├── tools/            # Tool system (registry, execution, MCP client)
│   ├── event_loop/       # Event loop and streaming
│   ├── multiagent/       # Multi-agent orchestration (A2A, graphs, swarm)
│   ├── session/          # Session persistence
│   ├── telemetry/        # Tracing and metrics
│   ├── types/            # Shared type definitions
│   └── …                 # Key subsystems shown; run `ls src/strands/` for the full list
├── tests/                # Unit tests (mirrors src/ structure)
├── tests_integ/          # Integration tests with real providers
├── docs/                 # Developer documentation
└── pyproject.toml        # Build config, dependencies, tool settings
```

## Development Workflow

### 1. Environment Setup

```bash
hatch shell                                    # Enter dev environment
pre-commit install -t pre-commit -t commit-msg # Install hooks
```

### 2. Making Changes

1. Create feature branch
2. Implement changes following the patterns below
3. Run quality checks before committing
4. Commit with conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`)
5. Push and open PR

### 3. Pull Request Guidelines

When creating pull requests, you MUST follow the guidelines and template in [PR.md](../team/PR.md).

### 4. Quality Gates

Pre-commit hooks run automatically on commit and must all pass: formatting (ruff), linting (ruff + mypy strict), tests (pytest), and commit-message validation (commitizen). Run them yourself with `hatch fmt --formatter` and `hatch fmt --linter` before committing.

**ruff, isort, mypy, and pydocstyle already enforce import order, line length (120), logging format, docstring presence, and type-annotation coverage.** This guide does not re-list those — it covers the conventions a linter *cannot* check. When a rule below says "enforced by review," it means exactly that: no tool catches it, so it is on you and the reviewer.

## Coding Patterns and Best Practices

### Logging

Structured logging is a cross-SDK rule — see the format in the [root AGENTS.md](../AGENTS.md). The Python-idiomatic form uses `%s` interpolation (never f-strings; ruff `G` enforces this) so interpolation is skipped when the log level is disabled:

```python
logger.debug("user_id=<%s>, action=<%s> | user performed action", user_id, action)
```

**`warnings.warn` vs `logger.warning` — pick by audience, not severity.** The two are not interchangeable; the split runs throughout the codebase:
- **`warnings.warn(...)` for developer-facing notices about how the SDK is being *used*** — an ignored/invalid config field, a deprecated argument, an unsupported option that will be dropped. These target the developer writing the code, are controllable via `-W` / `PYTHONWARNINGS` / `pytest.warns`, and the standard library already dedupes them *once per call site* under the default filter — so do **not** hand-roll a warn-once helper for this. Pass an explicit `stacklevel` so the warning points at the caller, not the SDK internals (see `models/_validation.py`, the reference: `validate_config_keys` and `warn_on_tool_choice_not_supported` both use `warnings.warn(..., stacklevel=4)`).
- **`logger.warning(...)` for runtime/operational diagnostics** — something went wrong while the SDK was *running* that an operator would want in their logs (an MCP server failed to start, a tool failed to load, a store write failed). These are for log aggregation, not the developer's console.

If you catch yourself building a process-global "warn once" set over the logger, you almost certainly want `warnings.warn` instead.

### Type Annotations

All code is fully type-annotated (mypy strict enforces parameter/return types and rejects implicit optionals). Use `typing` / `typing_extensions` for complex types. Beyond what the type checker catches:

- **Spell optionals as PEP 604 unions, not `Optional[...]`.** Write `X | None` and `X | Y`, never `Optional[X]` / `Union[X, Y]` — including for forward references, where ruff's `UP045` will *not* auto-fix it for you. The codebase is ~99% `X | None` already; don't reintroduce `Optional`.
- **Scope every type suppression to a code.** Use `# type: ignore[code]` (no bare `# type: ignore`, no space before the bracket — `# type: ignore [assignment]` silently degrades to a bare ignore). mypy runs with `warn_unused_ignores`, so a coded ignore stays narrow and self-cleans when the underlying error goes away. When narrowing an overridden signature (e.g. `update_config`), the code is `[override]`.
- **Avoid `Any` without a good reason.** Reach for a precise type or a `Protocol` first.

```python
def process_message(content: str, max_tokens: int | None = None) -> AgentResult:
    ...
```

### Data Structures

Choose the construct by the role the data plays — don't model the same kind of thing two ways:

- **`TypedDict` for wire / message / config shapes and `**kwargs` option bags** — anything that is fundamentally a JSON-serializable dict or a keyword-option payload (the Bedrock-API-modeled `content`/`streaming`/`tools` types, and every model-provider `*Config`). Use `total=False` for option/config bags and mark the few mandatory keys with `typing_extensions.Required`; for required wire shapes keep the default `total=True` and mark optional keys with `typing_extensions.NotRequired`.
- **`@dataclass` for runtime objects that own behavior, defaults, or serialization helpers** — results, contexts, events, state, persistence models (e.g. `agent/agent_result.py`).
- **`pydantic BaseModel` only for schemas the model reads or writes** — structured output and tool-input validation (e.g. `vended_plugins/goal/judge.py`). Do not reach for pydantic to model internal data.
- **Do not introduce `NamedTuple`** for new data structures.

Canonical examples: `types/content.py` (TypedDict), `agent/agent_result.py` (dataclass), `vended_plugins/goal/judge.py` (BaseModel).

### Naming Conventions

- **Variables/Functions**: `snake_case`
- **Classes**: `PascalCase`
- **Constants**: `UPPER_SNAKE_CASE`
- **Private members, functions, and modules**: prefix with `_` (e.g. `_helper()`, `_internal.py`)
- **Name every variable for its content**, including short-lived loop/catch bindings — `event`, `index`, `error`, never `e`/`i`/`x`.

### Docstrings

Use Google-style docstrings for all public functions, classes, and modules. ruff's pydocstyle (`D`) enforces that a docstring *exists* and is well-formed, but **not** that its sections are complete — so the judgment rule is: **include a `Raises:` section whenever a public function raises as part of its contract** (a missing one passes lint and is caught only in review).

```python
def example_function(param1: str, param2: int) -> bool:
    """Brief description of function.

    Longer description if needed. This docstring is used by LLMs
    to understand the function's purpose when used as a tool.

    Args:
        param1: Description of param1
        param2: Description of param2

    Returns:
        Description of return value

    Raises:
        ValueError: When invalid input is provided
    """
    pass
```

### Import Organization

Imports go at the top of the file; ruff/isort orders them (stdlib → third-party → local). Use absolute imports for cross-package references, relative imports within a package.

### File Organization

- Each major feature in its own directory
- Base classes and interfaces defined first
- Implementation-specific code in separate files
- Private modules prefixed with `_`
- Test files prefixed with `test_`

### Public API Surface

Public/internal marking is a cross-SDK rule — see the [root AGENTS.md](../AGENTS.md). The Python-idiomatic form:

- **Every public package declares its surface with an explicit `__all__`** in its `__init__.py`. Internal (`_`-prefixed) and namespace-only packages may omit it. Don't lean on the redundant `import X as X` re-export alias in place of `__all__` for a public package.
- **Optional or heavy model providers stay out of `__all__`** and are lazy-loaded via a module-level `__getattr__` (see `models/__init__.py`) so importing the package doesn't pull every provider's third-party dependency.

### Error Handling

- Use custom exceptions from `strands.types.exceptions`; provide clear, context-rich messages; never swallow exceptions silently.
- **Reserve a bare `raise Exception(...)` for nothing — pick the specific type.** A malformed model response is a `ValueError` (the convention across every provider); a timeout is a `TimeoutError`. When you re-raise, preserve the cause with `raise NewError(...) from original`.
- **Model providers translate vendor errors into the SDK's typed exceptions.** A vendor SDK's context-window / token-overflow error becomes `ContextWindowOverflowException`; rate-limiting / throttling (HTTP 429) becomes `ModelThrottledException`. Preserve the original with `raise ... from error`; never let a raw vendor exception escape the provider boundary. Most providers already do this (see `openai.py`, `bedrock.py`, `anthropic.py`); match them when adding or touching one.

### Extensible Interfaces (Protocol vs ABC)

> **Before adding or changing a public interface, read [docs/STYLE_GUIDE.md](./docs/STYLE_GUIDE.md).** It carries two rules a linter cannot enforce, summarized here so you don't miss them:

- **Use a `Protocol` with `**kwargs`, not a `Callable`, for extensible interfaces.** A `Protocol` lets you add optional keyword arguments later without breaking implementors; a bare `Callable` signature can't evolve. Example: `def __call__(self, state: GraphState, **kwargs: Any) -> bool: ...`.
- **Reference a tool by its `tool_name` property, never a hardcoded string.** `tool.tool_name` stays correct when a tool is renamed; a string literal silently rots.

### Hook Events

> **Before adding a hook event, read [docs/HOOKS.md](./docs/HOOKS.md).** Event names take an `Event` suffix, paired events follow `Before{Action}Event` / `After{Action}Event` (the action word comes *after* the lifecycle word), and every `Before` has a matching `After` invoked in reverse registration order. Hook event names are shared with the TypeScript SDK — see the cross-SDK parity rule in the [root AGENTS.md](../AGENTS.md).

## Adding a Model Provider

A model provider is the single most-repeated pattern in the SDK. Follow the existing skeleton — `models/anthropic.py` is the cleanest reference.

- **One flat file** `models/<name>.py` defining `class XModel(Model)`. (`models/model.py` is the abstract base; `models/_validation.py` and `models/_defaults.py` hold the shared helpers.)
- **Config is a nested `TypedDict`** `class XConfig(BaseModelConfig, total=False)` declared inside the class, with mandatory keys marked `typing_extensions.Required` (e.g. `model_id: Required[str]`).
- **`__init__(self, *, <client args>, **model_config: Unpack[XConfig])`** calls `validate_config_keys(model_config, self.XConfig)` *before* storing, then stores the typed config (`self.config = XModel.XConfig(**model_config)` — store the `TypedDict`, don't keep a plain `dict` and `cast` later).
- **Implement the abstract contract** from `Model`: `update_config` (re-validate, then `self.config.update(...)`; decorate `@override` and suppress with `# type: ignore[override]` because it narrows `**kwargs`), `get_config` (return `resolve_config_metadata(self.config, self.config["model_id"])`), `stream`, and `structured_output`.
- **Conversion helpers are conventional**, not abstract: `format_request(...)` builds the vendor request and `format_chunk(event) -> StreamEvent` maps a vendor chunk to a `StreamEvent`.
- **Map vendor errors** to typed SDK exceptions and chain the cause (see Error Handling above).

```python
class XModel(Model):
    class XConfig(BaseModelConfig, total=False):
        model_id: Required[str]
        params: dict[str, Any] | None

    def __init__(self, *, client_args: dict[str, Any] | None = None, **model_config: Unpack[XConfig]) -> None:
        validate_config_keys(model_config, self.XConfig)
        self.config = XModel.XConfig(**model_config)
        self.client = vendor.AsyncClient(**(client_args or {}))

    @override
    def update_config(self, **model_config: Unpack[XConfig]) -> None:  # type: ignore[override]
        validate_config_keys(model_config, self.XConfig)
        self.config.update(model_config)

    @override
    def get_config(self) -> XConfig:
        return resolve_config_metadata(self.config, self.config["model_id"])
```

### Async & Streaming

- **`stream` is an async generator.** Annotate provider overrides `-> AsyncGenerator[StreamEvent, None]` (the abstract base widens the return to `AsyncIterable`); annotate `structured_output` `-> AsyncGenerator[dict[str, T | Any], None]`.
- **Everything after `system_prompt` in a `stream` override is keyword-only — place a bare `*` before `tool_choice`.** Every provider does this; it keeps the orchestrator's keyword call site stable as new options are added.
- **Never buffer a stream into a list before yielding.** Consume upstream async iterables with `async for` and yield as you go.
- **Async-first with thin sync facades.** Public APIs come in async form (`invoke_async`, `stream_async`) plus thin sync wrappers (`__call__`, `invoke`) that delegate via `_async.run_async`. Never block the event loop — wrap blocking or third-party-sync calls in `asyncio.to_thread` (see `bedrock.py`).
- **The floor is Python 3.10.** Do not use `asyncio.TaskGroup` or `asyncio.timeout` (3.11+) without a `sys.version_info` gate and a 3.10 fallback (see `multiagent/swarm.py`); for concurrent work use `asyncio.create_task` and clean up in `finally` with `task.cancel()` then `await asyncio.gather(*tasks, return_exceptions=True)`.
- **Cancellation is cooperative.** Long-running integrations must propagate and observe the agent cancellation signal rather than blocking the event loop. *(The TypeScript SDK uses `AbortSignal` instead — see its AGENTS.md.)*

## MCP Tasks (Experimental)

The SDK supports MCP task-augmented execution for long-running tools. This feature is experimental and subject to change. Which task protocol runs depends on the installed `mcp` line:

- **mcp 2.x**: finalized SEP-2663 Tasks (protocol `2026-07-28`) — `tools/call` returns a direct result or a task handle, followed by `tasks/get` / `tasks/update` / `tasks/cancel`.
- **mcp 1.x**: the legacy 2025-11-25 flow — `call_tool_as_task`, `poll_task`, `get_task_result`.

### Configuration

Enable tasks by passing a `TasksConfig` to `MCPClient`:

```python
from datetime import timedelta
from strands.tools.mcp import MCPClient, TasksConfig

# Enable with defaults
client = MCPClient(transport, tasks_config={})

# Or configure explicitly
client = MCPClient(
    transport,
    tasks_config=TasksConfig(
        poll_timeout=timedelta(minutes=10),      # Overall task deadline (default 5min)
        request_timeout=timedelta(minutes=1),    # Per lifecycle request (default 1min)
        poll_interval=timedelta(seconds=1),      # Fallback when the server omits pollIntervalMs
        ttl=timedelta(minutes=2),                # Legacy 1.x task time-to-live (default 1min)
    ),
)
```

### Decision Logic

Task-augmented execution is used when ALL conditions are met:
1. Client opts in via `tasks_config` (not None)
2. Server advertises task capability (on 1.x, `tasks.requests.tools.call`; on 2.x, the `io.modelcontextprotocol/tasks` extension)
3. On the mcp 1.x line only: tool's `execution.taskSupport` is `required` or `optional` (the finalized extension has no tool-level setting)

### Key Files

- `src/strands/tools/mcp/mcp_tasks.py` - `TasksConfig`, task result models, and defaults
- `src/strands/tools/mcp/mcp_client.py` - Task execution logic (2.x: `_call_tool_with_task_and_poll_async`; 1.x: `_call_tool_as_task_and_poll_async`) and the public task lifecycle methods (`submit_tool_*`, `get_task_*`, `update_task_*`, `cancel_task_*`)
- `tests/strands/tools/mcp/test_mcp_client_tasks.py` - Unit tests (1.x flow; runs in the MCP 1.x Compat CI job)
- `tests/strands/tools/mcp/test_mcp_client_tasks_v2.py` - Unit tests (2.x flow)
- `tests_integ/mcp/test_mcp_client_tasks.py` - Integration tests
- `tests_integ/mcp/task_echo_server.py` - Test server with task support

## Testing

> **Before writing tests, read [docs/TESTING.md](./docs/TESTING.md).** It is the authoritative reference for the shared fixtures (reuse them — don't hand-roll mock models/hooks), the `tru_`/`exp_` assertion-pair naming, whole-object assertions, and test organization. The summary below is just the entry point.

- **Unit tests** in `tests/` mirror the `src/strands/` structure exactly (`tests/strands/agent/test_agent.py` ↔ `src/strands/agent/agent.py`); use mocking for external dependencies and fixtures from `tests/fixtures/`.
- **Integration tests** in `tests_integ/` exercise real providers end to end, require credentials, and are organized by feature area.
- **File naming**: `test_{module}.py` in `tests/strands/{path}/`; `test_{feature}.py` in `tests_integ/`.
- **Writing tests**: pytest fixtures for setup/teardown, `moto` for AWS, `@pytest.mark.asyncio` on every async test (strict mode), keep tests focused and independent, import packages at the top of the file.

## Quick Rules

The un-lintable rules an agent most often misses — every one is **enforced by review**, not tooling (formatting, import order, line length, docstring presence, and type-annotation coverage are already handled by ruff/mypy; run `hatch fmt`). Cross-SDK rules (plugin naming, parity, public/internal marking, logging format, evergreen comments) are in the [root AGENTS.md](../AGENTS.md).

**Do:**
- Spell optionals `X | None` (never `Optional[X]`); scope suppressions `# type: ignore[code]`
- Choose the data construct by role (TypedDict / dataclass / pydantic) — see Data Structures
- Document a `Raises:` section when a public function raises as part of its contract
- Declare a public package's surface with an explicit `__all__`
- Use a `Protocol` with `**kwargs` (not `Callable`) for extensible interfaces; compare tools by `tool_name`, not a string literal
- Name hook events `…Event` with `Before{Action}Event`/`After{Action}Event` pairing (read `docs/HOOKS.md` first)
- In a `stream` override, put a bare `*` before `tool_choice`; type it `AsyncGenerator[StreamEvent, None]`
- Wrap blocking/sync work in `asyncio.to_thread`; gate any 3.11+ asyncio API behind `sys.version_info`
- Name every variable for its content, even short-lived loop/catch bindings (`event`/`index`/`error`, never `e`/`i`/`x`)

**Don't:**
- `raise Exception(...)` — raise a specific type and chain the cause with `from`
- Let a raw vendor error escape a provider boundary — translate to a typed SDK exception
- Keep a model-provider config as a plain `dict` + `cast` — store the `TypedDict`
- Buffer a stream into a list before yielding

## Development Commands

```bash
# Environment
hatch shell                    # Enter dev environment

# Formatting & Linting
hatch fmt --formatter          # Format code
hatch fmt --linter             # Run linters (ruff + mypy)

# Testing
hatch test                     # Run unit tests
hatch test -c                  # Run with coverage
hatch run test-integ           # Run integration tests
hatch test --all               # Test all Python versions

# Pre-commit
pre-commit run --all-files     # Run all hooks manually

# Readiness Check
hatch run prepare              # Run all checks (format, lint, test)

# Build
hatch build                    # Build package
```

## Agent-Specific Notes

### Writing Code

- Make the SMALLEST reasonable changes to achieve the desired outcome
- Prefer simple, clean, maintainable solutions over clever ones
- Reduce code duplication, even if refactoring takes extra effort
- Match the style and formatting of surrounding code
- Fix broken things immediately when you find them

### Code Comments

Comments are to-the-point, state only what cannot be inferred from the code, and stay evergreen. The full rule (including how it applies to tests, and the deprecated/legacy nuance) is in the [root AGENTS.md](../AGENTS.md).

### Code Review Considerations

- Address all review comments
- Test changes thoroughly
- Update documentation if behavior changes
- Maintain test coverage
- Follow conventional commit format for fix commits

## Additional Resources

- [Strands Agents Documentation](https://strandsagents.com/)
- [CONTRIBUTING.md](../CONTRIBUTING.md) - Human contributor guidelines
- [docs/](./docs/) - Developer documentation
  - [STYLE_GUIDE.md](./docs/STYLE_GUIDE.md) - Code style conventions
  - [TESTING.md](./docs/TESTING.md) - Testing reference
  - [HOOKS.md](./docs/HOOKS.md) - Hooks system guide
  - [MCP_CLIENT_ARCHITECTURE.md](./docs/MCP_CLIENT_ARCHITECTURE.md) - MCP threading design
  - [MCP_VERSIONS.md](./docs/MCP_VERSIONS.md) - MCP 1.x/2.x support and migration
- [PR.md](../team/PR.md) - PR description guidelines
