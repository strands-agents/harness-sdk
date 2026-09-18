# Scoped Naming for Bidirectional Streaming Components

**Status**: Proposed

**Date**: 2026-09-16

**Issue**: TBD

## Problem

Most components under `strands.experimental.bidi` also carry a `Bidi` prefix:

```python
from strands.experimental.bidi.io import BidiAudioIO
from strands.experimental.bidi.models import BidiModel
from strands.experimental.bidi.types import BidiInput, BidiOutput
```

Using `Bidi` on nearly every symbol obscures where the prefix adds value. It is useful
for top-level APIs and shared data or event contracts, but redundant for components
already scoped by the bidi package. Removing it mechanically is also unsafe:
`BidiInput` is a channel while `BidiAgentInput` is its payload, and some unprefixed
names would collide with existing `AgentInput`, `ContentBlock`, and `Model` types.

## Goals

- Keep `BidiAgent` recognizable alongside `Agent`.
- Remove redundant prefixes from package-scoped components.
- Keep bidi-specific data and event contracts explicit.
- Establish a rule for future bidi components and future SDK implementations.

## Proposal

The tables below cover every current package-owned `Bidi...` identifier. They omit
existing unprefixed APIs because those names require no decision.

### Agent and model APIs

| Current Name | Decision | Proposed Name |
|---|---|---|
| `BidiAgent` | Keep | - |
| `BidiModel` | Keep | - |
| `BidiModelConfig` | Change | `ModelConfig` |
| `BidiConnectionConfig` | Change | `ConnectionConfig` |
| `BidiModelTimeoutError` | Change | `ConnectionTimeoutError` |

`BidiAgent` and `BidiModel` remain explicit because each has a direct standard-SDK
counterpart named `Agent` or `Model`. `ModelConfig` has no equivalent collision and is
scoped by `bidi.models`. `ConnectionTimeoutError` identifies the persistent provider
connection as the resource that expired. Configuration dictionary keys do not change.

### I/O APIs

| Current Name | Decision | Proposed Name |
|---|---|---|
| `BidiAudioIO` | Change | `AudioIO` |
| `BidiTextIO` | Change | `ConsoleIO` |
| `BidiAudioIOConfig` | Change | `AudioIOConfig` |
| `BidiAudioProcessorConfig` | Change | `AudioProcessorConfig` |
| `BidiInput` | Change | `InputChannel` |
| `BidiOutput` | Change | `OutputChannel` |

`ConsoleIO` matches the implementation: it reads interactive text from standard input
and writes output to standard output. The name avoids Python's `TextIO` type alias and
platform-specific terms such as terminal or shell.

`InputChannel` and `OutputChannel` make the protocol/value distinction explicit:

```python
class InputChannel(Protocol):
    def __call__(self) -> Awaitable[BidiAgentInput]: ...


class OutputChannel(Protocol):
    def __call__(self, event: BidiOutputEvent) -> Awaitable[None]: ...
```

### Input and output type aliases

| Current Name | Decision | Proposed Name |
|---|---|---|
| `BidiAgentInput` | Keep | - |
| `BidiContentBlock` | Keep | - |
| `BidiContentBlockData` | Keep | - |
| `BidiContentDelta` | Keep | - |
| `BidiContentDeltaData` | Keep | - |
| `BidiOutputEvent` | Keep | - |

Keeping the aliases also makes the channel relationship clear:

```python
InputChannel  # produces BidiAgentInput
OutputChannel  # consumes BidiOutputEvent
```

### Streaming events

Every concrete bidi output event remains unchanged:

| Current Name | Decision | Proposed Name |
|---|---|---|
| `BidiConnectionStartEvent` | Keep | - |
| `BidiConnectionRestartEvent` | Keep | - |
| `BidiConnectionWarningEvent` | Keep | - |
| `BidiResponseStartEvent` | Keep | - |
| `BidiAudioStreamEvent` | Keep | - |
| `BidiTranscriptStreamEvent` | Keep | - |
| `BidiTranscriptCompleteEvent` | Keep | - |
| `BidiInterruptionEvent` | Keep | - |
| `BidiResponseCompleteEvent` | Keep | - |
| `BidiUsageEvent` | Keep | - |
| `BidiConnectionCloseEvent` | Keep | - |
| `BidiErrorEvent` | Keep | - |

Events commonly enter shared queues, hook registries, logs, and pattern matches where
their module path is unavailable. The prefix identifies the lifecycle that emitted
them and avoids generic names such as `UsageEvent` or `ResponseCompleteEvent`.

Shared standard events such as `ToolUseStreamEvent`, `ToolResultEvent`, and
`ToolResultMessageEvent` also remain unchanged.

### Hook events

| Current Name | Decision | Proposed Name |
|---|---|---|
| `BidiAgentStopEvent` | Keep | - |
| `BidiResponseCompleteEvent` | Keep | - |
| `BidiInterruptionEvent` | Keep | - |
| `BidiBeforeConnectionRestartEvent` | Keep | - |
| `BidiAfterConnectionRestartEvent` | Keep | - |
| `BidiHookEvent` | Change | `_HookEvent` |
| `BidiInterruptionHookEvent` | Change | `InterruptionHookEvent` |
| `BidiResponseCompleteHookEvent` | Change | `ResponseCompleteHookEvent` |

The hook and streaming packages intentionally contain separate
`BidiResponseCompleteEvent` and `BidiInterruptionEvent` classes. Their import paths
distinguish delivery through the hook registry from delivery through
`BidiAgent.receive()`.

The package does not export `BidiHookEvent`. `_HookEvent` communicates its internal
status more effectively than the current prefix.

### Private implementation components

| Current Name | Decision | Proposed Name |
|---|---|---|
| `_BidiAgentLoop` | Change | `_AgentLoop` |
| `BidiReconnectTimer` | Change | `_ReconnectTimer` |
| `_BidiAudioInput` | Change | `_AudioInput` |
| `_BidiAudioOutput` | Change | `_AudioOutput` |
| `_BidiTextInput` | Change | `_TextInput` |
| `_BidiTextOutput` | Change | `_TextOutput` |
| `_BidiTranscriptOutput` | Change | `_TranscriptOutput` |

These classes never need to disambiguate outside the bidi package. The module path
already provides complete context, and the leading underscore consistently marks
their visibility.

### External identifiers

The following are not Python component names and remain unchanged:

| Area | Examples |
|---|---|
| Package | `strands.experimental.bidi` |
| Installation extras | `bidi`, `bidi-io`, `bidi-google`, `bidi-openai`, `bidi-aec`, `bidi-pyaudio`, `bidi-all` |
| Event discriminators | `bidi_connection_start`, `bidi_response_complete`, `bidi_error` |
| Telemetry operations | `bidi_session`, `bidi_connect`, `bidi_response`, `bidi_connection_restart` |
| Telemetry attributes | `gen_ai.bidi.restart_reason`, `gen_ai.bidi.restart_error_message` |
| Documentation | `bidirectional-streaming` routes and `bidi-streaming` tags |

The AWS SDK type `BidirectionalInputPayloadPart` also remains unchanged because it is
an external vendor type.

Changing these would create wire, dashboard, query, or deployment migrations without
improving Python API clarity.

## Future Component Naming

New components should use package scope and role-based names. Use `Bidi` when a public
data contract needs to distinguish itself from an existing SDK contract or when the
name belongs to the concrete bidi event family.

These are naming examples, not implemented components:

| Candidate Name | Decision | Proposed Name |
|---|---|---|
| `BidiWebRtcIO` | Change | `WebRTCIO` |
| `BidiReconnectCoordinator` | Change | `ReconnectCoordinator` |
| `BidiConnection` | Change | `Connection` |
| `BidiSessionTimer` | Change | `SessionTimer` or `_SessionTimer` |
| `BidiHandoffBuffer` | Change | `HandoffBuffer` or `_HandoffBuffer` |
| `ToolResultDeferredEvent` | Change | `BidiToolResultDeferredEvent` |

Future SDKs should use the same conceptual names with language-idiomatic casing.

## Developer Experience

### Audio

```python
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.io import AudioIO
from strands.experimental.bidi.models import BedrockNovaSonicModel

agent = BidiAgent(model=BedrockNovaSonicModel())
audio_io = AudioIO()

await agent.run(
    inputs=[audio_io.input()],
    outputs=[audio_io.output()],
)
```

### Console

```python
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.io import ConsoleIO
from strands.experimental.bidi.models import BedrockNovaSonicModel

agent = BidiAgent(model=BedrockNovaSonicModel())
console_io = ConsoleIO(input_prompt="You: ")
await agent.run(
    inputs=[console_io.input()],
    outputs=[console_io.output()],
)
```

## Migration

The public import migration is:

| Current Name | Decision | Proposed Name |
|---|---|---|
| `BidiModelConfig` | Change | `ModelConfig` |
| `BidiConnectionConfig` | Change | `ConnectionConfig` |
| `BidiModelTimeoutError` | Change | `ConnectionTimeoutError` |
| `BidiAudioIO` | Change | `AudioIO` |
| `BidiTextIO` | Change | `ConsoleIO` |
| `BidiAudioIOConfig` | Change | `AudioIOConfig` |
| `BidiAudioProcessorConfig` | Change | `AudioProcessorConfig` |
| `BidiInput` | Change | `InputChannel` |
| `BidiOutput` | Change | `OutputChannel` |

Keep these names:

- `BidiAgent`.
- `BidiModel`.
- Input/output type aliases.
- Concrete streaming and hook events.
- Provider model classes.
- Serialized event values and telemetry names.
- Runtime configuration keys.

Because the API is experimental, the recommended implementation makes the rename in
one coordinated change without permanently exporting both vocabularies. The change
must update definitions, annotations, `__all__`, lazy imports, tests, examples, and
current documentation together.

## Alternatives

| Alternative | Why it is not recommended |
|---|---|
| Remove `Bidi` from every Python symbol | Produces collisions with `Agent`, `Model`, `AgentInput`, and `ContentBlock`, and removes useful event-family context |
| Keep `Bidi` on every public symbol | Preserves redundant names and the ambiguous `BidiInput`/`BidiAgentInput` relationship |
| Replace `Bidi` with `Realtime` | Repeats a different prefix and changes the feature vocabulary without improving scope |
| Rename aliases to `InputContent`, `InputBlock`, and `OutputEvent` | Loses explicit boundary and event-family context for little practical brevity |

## Willingness to Implement

Yes.
