# Decision Record

A record of design and API decisions with their rationale, enabling prior decisions to guide future ones.

## Hooks as Low-Level Primitives, Not High-Level Abstractions

**Date**: Jan 6, 2026

### Decision

Hooks serve as low-level extensibility primitives for the agent loop. High-level constructs SHOULD be built on top of hooks rather than exposing `HookProvider` as the sole developer-facing interface. These higher-level constructs should define their own interface with domain-specific methods and type signatures beyond what `HookProvider` alone provides.

### Rationale

Exposing only `HookProvider` directly to consumers adds complexity to the implementor while offering no guidance on implementation requirements or type safety for specific use cases.

For example, an Agent-provided `retry_strategy` should **not** be implemented as:

```python
def Agent.__init__(
    ...
    retry_strategy: HookProvider
)
```

This is too low-level and gives no guidance on how a retry strategy should be implemented. Instead, a specific interface or base class should be built on top of hooks, providing additional scaffolding:

```python
class RetryStrategy(HookProvider):
  
    def register_hooks(registry):
        ...
    
    @abstractmethod
    def should_retry_model(e: Exception) -> bool:
        """Return true if the model call should be retried based on this exception"""
        ...
    
    def calculate_retry_delay(attempt: int) -> int:
        ...
```

Higher-level abstractions require additional interface definitions, but this tradeoff provides an improved developer experience through explicit contracts. Developers with edge cases can still drop to raw `HookProvider` (and `agent.hooks`) when needed — optimizing for the common path while preserving that escape hatch.


## Prefer Flat Namespaces Over Nested Modules

**Date**: Jan 16, 2026

### Decision

Public APIs should expose commonly-used functionality through flat, top-level namespaces rather than requiring users to import from deeply nested module paths.

### Rationale

Fewer imports are simpler to use and more discoverable when using IDE autocompletion & documentation. While inspired by Python's "Flat is better than nested" (PEP 20 - The Zen of Python), this principle applies across SDK languages.

We don't want users continually importing additional modules for common functionality. The goal is to optimize for the 80% case where users need standard features, while still allowing advanced users to import from specific submodules when needed.

For example, we prefer exporting all hook events from a single module:

```python
from strands.hooks import MultiAgentInitializedEvent
```

instead of categorizing them based on their purpose

```python
from strands.hooks.multiagent import MultiAgentInitializedEvent
```

this is even more important when the event names already indicate their grouping (**MultiAgent**InitializeEvent). 

Internal module organization can remain nested for code maintainability — the key is re-exporting public symbols at common locations.

## When Internal Interfaces Should Extend HookProvider

**Date**: Jan 21, 2026

### Decision

Internal interfaces that integrate with the agent lifecycle (such as `RetryStrategy`, `SessionManager`, and `ConversationManager`) SHOULD extend `HookProvider`. When uncertain whether a new interface requires `HookProvider`, prefer a simple domain interface—it can always be evolved to extend `HookProvider` later, but the reverse migration breaks existing implementations.

### Rationale

The team considered two approaches for `RetryStrategy`: extending `HookProvider` or exposing a simple domain interface with methods like `should_retry(exception, attempt) -> bool`.

While `RetryStrategy` is simple enough that a non-`HookProvider` interface would suffice, extending `HookProvider` maintains a uniform pattern across all agent constructor parameters that integrate with the lifecycle. Users implementing any of these interfaces learn one composition model. This aligns with the **composability** tenet: primitives are building blocks with each other.

The tradeoff is that `HookProvider` exposure can leak implementation details for interfaces with single decision points. Use the following criteria for future interfaces:

**Use a simple interface when:**

- The interface has a single responsibility expressible as one or two methods
- The interface does not need to respond to multiple lifecycle events
- Consistency with existing interfaces is not a priority

**Extend HookProvider when:**

- The capability requires responding to multiple distinct lifecycle events
- Users need to customize which events to subscribe to or add callbacks beyond base class defaults


## Pay for Play: Opt-In Breaking Changes Are Acceptable

**Date**: Jan 28, 2026

### Decision

Small breaking changes that follow the "pay for play" principle are acceptable without a major version bump. Programs can call new APIs to access new features, but programs that choose not to do so are unaffected — old code continues to work as it did before.

### Rationale

Strict semver adherence can slow SDK development when the breaking change only affects users who explicitly adopt new functionality. If existing code paths remain unaffected, the practical impact on users is minimal.

For example, converting a `TypedDict` to `total=False` is technically breaking change - code that creates instances of that `TypedDict` without the new field will still work, but code that *reads* from the `TypedDict` and expects the field to always be present would break. However, if the old field is only missing when using a new tool, users who don't adopt that tool never encounter the missing field. The break is "pay for play": you only see it if you opt into the new functionality.

This applies when the breaking change is gated behind new functionality — users who don't touch the new feature never see the break, and those who do will find the breakage more obvious since it's tied to something they just added.

This doesn't apply when existing code breaks without any user action, or when the change affects default behavior. If someone upgrades and their code stops working with no obvious reason why, that's a bad experience we want to avoid.

See also: [Raymond Chen on "pay for play" in API design](https://devblogs.microsoft.com/oldnewthing/20260127-00/?p=112018)


## Provide Both Low-Level and High-Level APIs

**Date**: Jan 30, 2026

### Decision

When introducing new features, we SHOULD provide both low-level APIs that offer fine-grained control and high-level APIs that simplify common use cases. Low-level APIs serve as building blocks for power users and edge cases, while high-level APIs guide most users toward the happy path with opinionated defaults.

### Rationale

Our tenets emphasize being **extensible by design** and **simple at any scale**. These goals can appear to conflict: maximum extensibility often requires exposing implementation details, while simplicity favors hiding them. A tiered API approach resolves this tension.

**Low-level APIs** provide fine-grained control, building blocks for custom implementations, and escape hatches for edge cases. They require deeper understanding of the underlying concepts but enable use cases the high-level API doesn't anticipate.

**High-level APIs** provide opinionated defaults for common use cases and reduced cognitive load. They push users toward the pit of success — the easy path is also the correct path. Most users should reach for these first.

For example, `BidiAgent` exposes `send`/`receive` as low-level APIs. Using them directly requires managing concurrency, lifecycle, and event routing:

```python
await agent.start()

async def read_input():
    while True:
        event = await input_source.read()
        await agent.send(event)

asyncio.create_task(read_input())

async for event in agent.receive():
    ...

await agent.stop()
```

The `run` method builds on these to abstract the complexity. Users provide IO callbacks and the method handles the rest:

```python
await agent.run(inputs=[audio_input], outputs=[audio_output, text_output])
```

This pattern aligns with progressive disclosure from UX design: show users what they need for common tasks while making advanced capabilities discoverable when needed.


## Avoid Overloading Domain Terms in API Naming

**Date**: Mar 4, 2026

### Decision

When naming API parameters, types, and interfaces, avoid reusing terms that already carry specific meaning within the SDK. Prefer domain-appropriate terminology from the underlying library or concept, even if it diverges from naming in another SDK language.

### Rationale

Overloaded terms create ambiguity for users and contributors. When a single word means different things depending on context, it increases cognitive load and makes documentation harder to write clearly. Prefer the term native to the library or domain you're wrapping, especially when the alternative is already claimed by a prominent concept in the SDK or the broader language ecosystem. Cross-language consistency is valuable, but not at the cost of within-language clarity.

For example, the Python SDK uses `structured_output_model` because Pydantic calls its schemas "models." The TypeScript SDK chose `structuredOutputSchema` instead. Zod (the TypeScript validation library) uses "schema" as its core term — `z.object()` returns a `ZodSchema` — and "model" in the Strands SDK already refers to the LLM provider (`BedrockModel`, `model` config parameter, etc.). Reusing it for a validation shape would force readers to disambiguate from context every time they encounter the word.

Similarly, the SDK documentation uses "agent loop" rather than "event loop" to describe the core execution cycle. "Event loop" is an overloaded term in programming — in Python it refers to `asyncio`'s concurrency primitive, and in JavaScript/Node.js it's the runtime's fundamental execution model. Calling the agent's tool-use cycle an "event loop" would conflate an SDK concept with a well-established language runtime concept, making it harder to discuss both in the same context. "Agent loop" is unambiguous and describes exactly what it is.


## Use LLM-Native Units in Public APIs

**Date**: Apr 23, 2026

### Decision

Public APIs should express parameters in the units that LLMs operate on, rather than units familiar to traditional software development. For example, size-based thresholds should use token counts rather than character counts, and parameters should be named accordingly (e.g., `max_tokens` over `max_chars`).

### Rationale

LLMs think in tokens — they consume tokens, produce tokens, and their context windows are measured in tokens. Our APIs should reflect the language of the models they orchestrate, not the language of general-purpose string processing. This makes APIs more accurate, since the parameters directly map to the resource being managed, and more intuitive for users building on top of LLMs.

Tokens are also a unified unit across modalities — text, images, JSON, video, and other content types all tokenize into the same currency. Characters only apply to text, forcing different heuristics for different content types. Token-based parameters provide a single, consistent metric regardless of what the model is processing.

But the principle extends beyond size — wherever there is an LLM-native concept, our APIs should prefer it over a traditional developer abstraction.


## Null Means Explicit Removal; Undefined Means Apply the Default

**Date**: Aug 19, 2026

### Decision

This decision governs **pass-through values**: fields the caller supplies for the SDK to forward to a downstream service, such as a provider's `params` bag or `additional_request_fields`. For those, the SDK distinguishes two "no value" states:

- **`null` means explicit removal.** The user is deliberately opting a field out. When plumbing information through to a downstream service, a `null` field SHOULD be removed from the request — not sent as `null`, and not replaced with an SDK default.
- **`undefined` (or an absent field) means the default case.** The SDK is free to apply its own logic for sensible defaults — which may itself be to omit the field.

In Python, which has no `undefined`, an absent key plays the `undefined` role and an explicit `None` SHOULD be treated as `null`. This does not reinterpret parameters where `None` already means "unspecified" — `Agent(model=None)` still applies the default model.

It does **not** govern **feature enablement**. Parameters that switch an SDK-managed feature on or off keep `false`/`False` as the explicit off-switch (e.g. `MemoryManager(injection=False)`, `sandbox: false`). The two kinds cannot share a sentinel: a pass-through field may legitimately carry the value `false` (`store: false`, `parallel_tool_calls: false`), so `false` cannot mean "remove this field" — while a toggle's value is never forwarded, so `false` is unambiguous there.

### Rationale

Users need a way to say "don't send this field at all" that is distinct from "I didn't specify this field." Collapsing the two either makes SDK-managed defaults impossible to opt out of, or forces the SDK to treat every unspecified field as a deliberate removal.

For example, the TypeScript `OpenAIModel` manages `stream_options: { include_usage: true }` on streaming requests, but some OpenAI-compatible endpoints — e.g. Cohere's Compatibility API — reject the field entirely. [#3872](https://github.com/strands-agents/harness-sdk/pull/3872) applies this decision: an explicit `params.stream_options: null` omits the field from the wire request, while leaving it undefined keeps the managed default.
