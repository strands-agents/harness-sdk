# Porting from TypeScript

## Overview

This guide collects the rules for porting a feature from the TypeScript SDK (`strands-ts`) into the Python SDK (`strands-py`). TypeScript is canonical: a port reproduces the TypeScript behavior, expressed idiomatically in Python.

The rules below are construct-to-construct mappings; general language idiom a competent porter already applies is left out. Concessions forced by a Python limitation are collected under [Workarounds](#workarounds).

## A TypeScript `interface` maps to one of three Python forms, by role

A single TypeScript `interface` covers roles that Python expresses with distinct constructs, so the Python form depends on what the interface is *for*:

1. **Behavioral contract (has method members)** maps to a `Protocol` (implemented implicitly).
   - `interface Extractor { extract() }` to `class Extractor(Protocol)`
2. **Any data shape (fields, constructed and passed around)** maps to a `@dataclass`. `readonly` fields map to `@dataclass(frozen=True)`.
   - `interface ExtractionResult` to `@dataclass class ExtractionResult`
3. **Pure constructor config (destructured once to build an object, never kept as a unit)** maps to explicit `__init__` parameters, no type at all; the fields become attributes. A required field (especially a required callback) is a positional parameter; optional fields go after a bare `*,` as keyword-only.
   - `interface ContextInjectorConfig` to `__init__(self, render_content, *, name=None, trigger=None)`

## A tagged object-literal union member maps to a frozen dataclass

A union member that is a TypeScript object literal with a string tag becomes a frozen dataclass whose tag is a non-init defaulted field:

```python
# type Deny = { type: 'deny'; reason: string }   ->
@dataclass(frozen=True)
class Deny:
    type: str = field(default="deny", init=False)
    reason: str = ""
```

`readonly` maps to `frozen=True`; the literal `type:` tag maps to `field(default="...", init=False)` (present at runtime, not a constructor argument). A factory function (`function deny(reason): Deny`) collapses into the constructor (`deny("x")` becomes `Deny(reason="x")`). The union alias maps directly (`type X = A | B` to `X = A | B`). Downstream dispatch on the tag (`switch (action.type)`) becomes `isinstance` checks (`isinstance(action, Deny)`).

## A `tool({...})` object-literal maps to a `@tool`-decorated function

Each field of the tool object lands in a specific place:

| TypeScript `tool({...})` field | Python `@tool` function |
|---|---|
| `name: 'summarize_context'` | the function name (`def summarize_context`) |
| `description: '...'` | the function docstring |
| `inputSchema: z.object({ keepRecent: z.number().int().optional() })` | typed parameters (`keep_recent: int \| None = None`) |
| per-field `.describe('...')` | the matching `Args:` docstring entry |
| `callback: (input, context) => {...}` | the function body |
| `context` (2nd callback arg) | `@tool(context=True)` plus a `tool_context: ToolContext` param |

The declarative schema and its descriptions collapse into the function signature plus its Google-style docstring.

## External wire keys stay verbatim

A key that belongs to an external API or protocol (not our own surface) is copied character-for-character, not re-cased: `max_tokens`, `input_tokens`, `tool_use`, `stop_reason` are the third-party spelling. This extends to docstrings and comments that *name* those keys.

## Workarounds

Concessions forced by a Python (or current-codebase) limitation, where the port is constrained by what already exists rather than chosen freely. Unlike the rules above, these would not be how you'd do it porting Python from scratch.

### The Python surface is async; bridge a sync-only client with a worker thread

The exposed method is always an async generator (`async def stream(...) -> AsyncGenerator[...]`). How the underlying client is driven depends on what it offers:

- **Async client available** (for example Anthropic's `AsyncAnthropic`): use it directly with `async with` / `async for`. When a TypeScript API exposes both sync and async forms, the Python port takes the async form.
- **Sync-only client** (boto3 has no async client): keep the async-generator surface but run the blocking call in `asyncio.to_thread`, feeding events back through an `asyncio.Queue` plus a callback, with a sentinel (`None`) to close. The blocking work must never run on the event loop thread.

### Shared types are looked up by their existing target name, never renamed

Exceptions, content-block types, and stream-event types live in a central types module on each side. When the source references one, use the target's existing name for it; do not transform the identifier. There is no suffix rule: `ProviderTokenCountError` keeps that exact name in both languages, while `ContextWindowOverflowError` is `ContextWindowOverflowException` in Python, because that is how each is already spelled. Resolve each against what is actually there rather than applying a uniform `Error` to `Exception` rename.
