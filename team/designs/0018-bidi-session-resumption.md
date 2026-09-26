# Session Resumption for Strands Bidirectional Streaming

**Status**: Proposed

**Date**: 2026-08-10

**Issue**: TBD

## Problem

Realtime voice providers cap how long a streaming session can live: Nova Sonic ends the session at about 8 minutes, Gemini Live's connection drops at about 10 minutes, and OpenAI Realtime ends at 60 minutes.

A Strands bidi agent learns about the limit only after the provider has already closed the session. The model raises `BidiModelTimeoutError`, the agent loop reconnects, and the conversation continues, but the reconnect starts from a session that is already gone. That timing causes four concrete failures, detailed in [Current State](#current-state).

Anyone building on `strands.experimental.bidi` hits this, and reliable long sessions are a prerequisite for bidi leaving `experimental`.

### Background: how bidi works

*Skip to [Current State](#current-state) if you already know the bidi architecture.*

Ordinary Strands agents are request/response. Bidirectional ("bidi") streaming keeps a persistent connection to a realtime model, with microphone audio flowing up and generated speech flowing down at the same time, for as long as the conversation lasts. The package lives at `strands-py/src/strands/experimental/bidi/`:

- `agent/agent.py`: `BidiAgent`, holds the model, tools, system prompt, and messages.
- `agent/loop.py`: `_BidiAgentLoop`, owns the event queue, send gate, tool execution, and reconnect.
- `models/model.py`: the `BidiModel` protocol and `BidiModelTimeoutError`.
- `models/nova_sonic.py`, `models/gemini_live.py`, `models/openai_realtime.py`: the three provider implementations.
- `io/`: `audio.py` (mic/speaker) and `text.py` (stdin/stdout).
- `types/`: `events.py`, `model.py` (`AudioConfig`), `io.py`.
- `_telemetry.py`: session, response, and restart spans.

`BidiModel` (`models/model.py`) has five members:

```python
@runtime_checkable
class BidiModel(Protocol):
    config: dict[str, Any]

    async def start(self, system_prompt=None, tools=None, messages=None, **kwargs) -> None: ...
    async def stop(self) -> None: ...
    def receive(self) -> AsyncIterable[BidiOutputEvent]: ...
    async def send(self, content: BidiInputEvent | ToolResultEvent) -> None: ...
```

One detail matters for everything below:

- `start()` and `stop()` mutate the model instance. `start()` populates fields (a connection ID, a socket, a stream), and `send()` and `receive()` read those fields.
- One model instance is therefore one session, and that session is implicit. There is no object you can point at and call "the connection."

### Current State

Reconnect works today, but only after the fact. `_BidiAgentLoop.receive()` watches for the timeout error on its event queue, and on catching it, calls `_restart_connection()`, which closes the send gate, calls `model.stop()`, calls `model.start()` again with `agent.messages` as history, and reopens the gate. The mechanism works. The timing is the problem, and three failures follow from it:

- **A failed reconnect ends the call.** With no live session to fall back on, a transient error is fatal. Retrying requires time, which only a living session provides.
- **Reconnects can land mid-response.** Session limits are hit while the model is still generating, and resuming in that state can lose data.
- **User speech is lost.** The socket dies mid-sentence with the send gate still open, so audio recorded during the gap is discarded by the upstream buffer once it fills.

This happens on every conversation that runs longer than a provider's session limit. For voice agents these are ordinary durations.

**Provider limits, for reference:**

| | Nova Sonic | Gemini Live | OpenAI Realtime |
|---|---|---|---|
| Session limit | ~8 min | ~15 min | 60 min (client caps at 50) |
| Connection limit | same as session | ~10 min | same as session |
| Warns before closing? | No | Yes, `GoAway` with time remaining | No |

Gemini is the one provider where these two limits differ: its connection drops at around 10 minutes, well before its session limit of 15. A timer armed against the 15-minute session limit would fire about 5 minutes after the connection was already dead, so Gemini's connection limit and session limit need to be tracked as two separate values, not one.

## Goals

- A bidi conversation reconnects before the provider ends the session, not after, without any change to application code.
- A reconnect waits for a natural pause in the conversation when it can, rather than always cutting off a response mid-sentence.
- User audio spoken during a reconnect is not lost.
- The application can be notified before a reconnect happens, so it can inform the user if it chooses to.
- Token usage is reported correctly across reconnects, per connection and per session.
- A provider opts into this behavior by declaring data about its own limits, not by implementing timing or retry logic itself.
- The reconnect logic itself is unit-testable without a live provider or the full event loop.

## Non-Goals

- Restoring assistant audio on OpenAI after a reconnect.
- Unbounded conversations via context compaction.
- Cross-process session migration.
- Changes to the IO layer or the `BidiInput`/`BidiOutput` interfaces.

## Proposal

### Option 1: proactive reconnect (recommended)

The agent needs to know when a session will end before the provider ends it. None of the three providers report this at runtime or guarantee it in their API contract, but their approximate limits are known from documentation and direct testing. This proposal hardcodes those values as declared constants per provider, and adds one component that acts on them.

**`BidiConnectionConfig`** is a new `TypedDict` in `types/model.py`. Each provider declares its own connection lifetime, resume mechanism, and usage-reporting behavior as data:

```python
class BidiConnectionConfig(TypedDict, total=False):
    """Connection lifetime and resume facts a provider declares."""

    max_connection_s: float    # one connection's lifetime (Gemini: 600, the binding limit)
    max_session_s: float       # logical session lifetime (Nova: 480, OpenAI: ~3000)

    warning_lead_s: float      # warn this far before the deadline (default 30)
    reconnect_margin_s: float  # reconnect this far before the limit (default 60)
    auto_reconnect: bool       # default True

    resume: Literal["handle", "replay", "replay_text_only"]
    usage_is_cumulative: bool  # True for Nova, False for OpenAI
```

- Nova: `resume="replay"`, `usage_is_cumulative=True`.
- Gemini: `resume="handle"`, `usage_is_cumulative=False`.
- OpenAI: `resume="replay_text_only"`, `usage_is_cumulative=False`.
- A provider that declares nothing gets `{}`: no timer arms, and behavior is unchanged from today.

This is named `connection_config`, not `session_config`, to avoid colliding with `SessionManager`, an existing abstraction for persisting conversation history across process restarts, a different concern.

**`BidiConnection`** is a new protocol in `models/model.py`, alongside `BidiModel`. It is what a reconnect actually manipulates: one live connection, with its own ID, and the ability to receive events, send content, and close.

```python
@runtime_checkable
class BidiConnection(Protocol):
    connection_id: str

    def receive(self) -> AsyncIterable[BidiOutputEvent]: ...
    async def send(self, content) -> None: ...
    async def close(self) -> None: ...            # terminal and idempotent
    def restart_kwargs(self) -> dict[str, Any]:   # what's needed to resume FROM this one
        ...
    supports_overlap: bool
```

`_LegacyModelConnection` is a new adapter class in `agent/_reconnect.py`, alongside the coordinator. None of the three in-repo providers implement `BidiConnection` directly, they only implement the existing `BidiModel`, so this class wraps a `BidiModel` and exposes it as a `BidiConnection`: `close()` calls the model's `stop()`, `send()`/`receive()` delegate straight through. The coordinator only ever holds `BidiConnection` objects; for these three providers, that object happens to be one of these adapters, created automatically, with no provider code changes required.

**`BidiReconnectCoordinator`** is a new class, `agent/_reconnect.py`, that owns the connection lifecycle: the active `BidiConnection`, a generation counter, the `reconnect()` method, and per-connection token totals. `_BidiAgentLoop` keeps the event queue, send gate, and tool execution, and delegates everything else to the coordinator, because a proactive timer fires from a background task, while today's reconnect runs inline on the consumer's task.

```python
class BidiReconnectCoordinator:
    _active_conn: BidiConnection | None
    _generation: int
    _reconnect_lock: asyncio.Lock
    _timer: _BidiSessionTimer
    _handoff: _BidiHandoffBuffer
    _turns: _TurnBoundaryWatcher

    async def reconnect(self, trigger, timeout_error=None) -> None: ...
```

The coordinator's `reconnect()` needs to do three separate things well before it can swap connections, and each is delegated to its own collaborator rather than handled inline:

- **Know when to reconnect.** `_BidiSessionTimer` reads the declared `BidiConnectionConfig` and arms two timers per connection: one that fires early as a warning, one that fires at the actual reconnect deadline.
- **Not lose audio spoken during the swap.** The send gate closes before the old connection is torn down, so any user speech captured in that window would otherwise be dropped. `_BidiHandoffBuffer` holds a few seconds of that audio and replays it into the new connection once it's ready.
- **Not cut off a response mid-sentence.** The model may still be generating a response when the deadline arrives. `_TurnBoundaryWatcher` waits, with a bound, for that response to finish before the swap proceeds.

The coordinator also tracks a generation counter: an integer tagged onto each connection's event stream, so if a superseded connection is still draining events during a swap, only the current generation's events reach the application.

Both a proactive timer deadline and a reactive `BidiModelTimeoutError` enter the coordinator's `reconnect()` method, sharing the same lock, hooks, telemetry, and buffer:

```python
async def reconnect(self, trigger, timeout_error=None):
    async with self._reconnect_lock:
        await self._timer.stop()
        self._handoff.activate()            # buffer user audio
        self._channel.close_gate()          # stop writing to the old connection
        await self._turns.await_boundary()  # bounded; proceeds anyway on timeout

        if self._active_conn is not None:
            await self._active_conn.close()
            self._active_conn = None
        new_conn = await self._acquire(messages, **restart_kwargs)
        self._generation += 1
        self._active_conn = new_conn
        self._channel.spawn(self._run_model(new_conn, self._generation))
        for buffered in self._handoff.drain():
            await new_conn.send(buffered)

        self._timer.reset(self._connection_config())
        self._channel.open_gate()
```

Token accounting also moves to the coordinator, and now branches on the declared `usage_is_cumulative` fact instead of applying one rule to every provider, which fixes today's miscounting.

One provider change is required: Gemini needs to emit a turn-completion event (it discards this signal today), which `_TurnBoundaryWatcher` needs to detect a turn boundary.

**Pros**

- Addresses every goal except closing the audio gap: retry budget, turn alignment, preserved audio, accurate tokens, advance warning.
- `BidiModel` is untouched, so nothing breaks. A model that adopts nothing behaves identically to today.
- A provider opts in with one attribute: no new methods, no concurrency assumptions.
- Nothing is gated on unvalidated provider behavior. All of it is buildable and testable now.

**Cons**

- A brief audible gap remains at each reconnect. See [The reconnect gap](#the-reconnect-gap) below.
- One more component in bidi. `_BidiAgentLoop` gets simpler, and the system gains a part.
- Providers now hold constants that can go stale if a provider changes its limits. A wrong value causes an early reconnect or a missed deadline that falls back to the reactive path. That is degradation, not breakage.

#### The audio gap is a known, accepted tradeoff

Aligning the reconnect to a turn boundary and buffering user audio across the gap reduces the impact of the gap, but does not remove it: closing the old connection and opening a new one takes measurable time. This design accepts that gap rather than eliminating it. [The reconnect gap](#the-reconnect-gap) measured it directly at about 265-300ms across all three providers, once a small provider-side fix ships, and that number is why this design does not recommend the alternative in Option 2.

### Option 2: overlapping connections

This alternative removes the audio gap entirely, at a much higher cost, by letting a model open a new connection before closing the old one (make-before-break).

Today, one `BidiModel` instance owns exactly one set of connection state, guarded by a check that raises if `start()` is called twice. Deleting that guard does not create a second connection; it silently corrupts the first, because fields like the stream and connection ID get overwritten in place, microphone input and playback audio diverge onto different connections, and in-flight sends violate the wire protocol. Overlap requires moving that state onto a per-connection object instead, so two connections can exist side by side.

Providers would opt in through a new, separate protocol, `BidiResumableModel`, adding a `connect()` method that returns an independent `BidiConnection` without mutating shared model state:

```python
@runtime_checkable
class BidiResumableModel(Protocol):
    """Opt-in: a model that can open independent connections."""

    connection_config: BidiConnectionConfig

    async def connect(self, system_prompt=None, tools=None, messages=None, **kwargs) -> BidiConnection:
        """Open a NEW connection without mutating shared model state."""
        ...
```

`reconnect()` would gain a branch: when a connection reports `supports_overlap`, open the new one while the old still streams, swap the generation counter, then close the old out of band. Everything else (lock, hooks, telemetry, timer, turn gating) is shared with Option 1.

**Pros**

- Removes the audio gap.
- Safer failure mode: if opening the new connection fails, the old one is untouched and still serving, so a transient error becomes a retry rather than a dropped call.
- Feasible on Nova today: a working reference holds two live sessions at once and promotes the new one only after the swap.

**Cons**

- A per-provider refactor of every field that currently lives on the model instance rather than on a connection.
- Two providers are unvalidated: whether OpenAI tolerates two concurrent WebSockets, whether Gemini accepts a handle-resume while the old socket is open, and whether either double-bills the overlap.
- It buys exactly one thing beyond Option 1: no audible gap. Every other goal is already delivered by Option 1, and Gemini's server-side resumption handle already restores context in full across a serial reconnect, so overlap changes latency, not what the model remembers.

Whether the gap Option 1 accepts is small enough to skip this refactor is a product decision about acceptable audio artifacts, not a purely technical one. See [The reconnect gap](#the-reconnect-gap).

### Other options considered

**Each provider handles its own reconnection.** Every `BidiModel` detects its own deadline and reconnects internally, invisibly to the loop. This avoids new model-agnostic components, but the same timing logic gets written three times and diverges immediately, there are no consistent hooks or telemetry across providers, and a third-party provider gets none of it. This inverts how bidi is layered by putting model-agnostic policy inside model-specific code.

**Put the timer directly in `_BidiAgentLoop`.** The smallest diff, but today's reconnect already needs the same restructuring Option 1 does, since it runs inline on the consumer's task while a timer fires from a background one. Doing this directly on the loop, which already owns the queue, tool orchestration, telemetry, and gating, pays the same cost as Option 1 without a separately testable unit.

## Investigation

### The reconnect gap

The choice between Option 1 and Option 2 rests on one number: how long does a serial reconnect (`stop()` then `start()`) actually take. This was measured directly.

**Method.** A standalone script opened a connection, timed `stop()` and `start()` separately across repeated trials, and reported min/median/p95 per provider (Nova and Gemini: 8 trials each; OpenAI: 14 trials across two runs, to confirm the result wasn't a fluke).

**Results:**

| Provider | `stop()` | `start()` | Total reconnect gap (median) |
|---|---|---|---|
| Nova Sonic | ~0.7-1.7 ms | ~240-310 ms | ~265 ms |
| Gemini Live | ~37-47 ms | ~220-480 ms | ~275 ms |
| OpenAI Realtime | ~2070-2080 ms | ~285-700 ms | ~2380 ms |

Nova and Gemini matched the prediction: `stop()` is nearly free because it writes into an already-open channel, and the real cost is in `start()`'s credential resolution and transport handshake.

OpenAI's `stop()` was the anomaly. Its cost, about 2.07 seconds, was isolated to the WebSocket close handshake itself, confirmed with a bare `websockets.connect()` / `.close()` reproduction entirely outside the SDK, ruling out a bug in the provider code or the harness. OpenAI's server takes a consistent two seconds to acknowledge a clean close on every call.

The fix does not touch reconnect architecture at all. Firing `close()` as a background task instead of awaiting it inline drops the caller-visible cost to about 0.01ms. The close frame still goes out and the socket still reaches a clean closed state, just off the critical path. Validated end to end: the very next `start()` to the same endpoint completes in about 290-350ms, unblocked and unthrottled, even with several prior close handshakes still draining in the background.

Once that fix ships, all three providers land in the same 265-300ms range. That is the number Option 1 and Option 2 should be evaluated against, and it is why this design does not recommend Option 2 on latency grounds.

### Gemini's warning lead time

Gemini's `GoAway` message gives a client advance notice before the connection closes. Whether that notice arrives early enough to complete a turn-aligned reconnect was resolved by reading rather than measuring: Google's published Live API limits state the notification arrives about 60 seconds before the connection ends, roughly two orders of magnitude more than the measured Gemini reconnect gap above. `GoAway` is secondary to the client-side connection timer in this design regardless, so this number does not gate anything.

## Developer Experience

### Application developers: no change

```python
agent = BidiAgent(model=BidiNovaSonicModel(), tools=[calculator])
await agent.run(inputs=[audio_io.input()], outputs=[audio_io.output()])
```

Identical to today, except the conversation now continues past 8 minutes. There is one optional new event, `BidiConnectionWarningEvent` in `types/events.py`:

```python
async for event in agent.receive():
    if isinstance(event, BidiConnectionWarningEvent):
        display(f"reconnecting shortly (~{event.time_left_s:.0f}s left)")
    elif isinstance(event, BidiAudioStreamEvent):
        play(event)
```

The event is informational: the core emits it, the application decides whether to surface it, and nothing is injected into the conversation. Thresholds are tunable per provider:

```python
model = BidiNovaSonicModel(provider_config={
    "connection": {"warning_lead_s": 45, "reconnect_margin_s": 60},
})
```

### Custom model authors: two levels

**Level 1: an existing model, untouched.** No `connection_config`, no timer, purely reactive. Identical to today's behavior.

**Level 2: add one attribute and the timer arms.**

```python
class MyVoiceModel:
    connection_config: BidiConnectionConfig = {"max_session_s": 480.0, "resume": "replay"}
    # start / stop / send / receive unchanged
```

```
t=0     connect; timer arms warning and deadline
t=390   BidiConnectionWarningEvent(time_left_s=90)
t=420   reconnect: close gate, await turn boundary, swap connection, open gate
t=480   the limit the provider would have enforced, never reached
```

Capability is detected, not required. `BidiAgent.__init__` admits models via `isinstance(model, BidiModel)`, and `isinstance` against a `runtime_checkable` Protocol checks every declared member, including attributes. If `connection_config` were added directly to `BidiModel`, any third-party model that doesn't declare it would fail that check, and `BidiAgent` would silently construct a `BidiNovaSonicModel` in its place instead of raising an error. To avoid that, capability is detected with two separate probes instead:

```python
# Limits: missing ⇒ {} ⇒ no timer ⇒ today's behavior.
def _connection_config(self) -> BidiConnectionConfig:
    return getattr(self._agent.model, "connection_config", {})

# Shape: missing ⇒ adapter ⇒ serial reconnect.
async def _acquire(self, messages, **restart_kwargs) -> BidiConnection:
    model = self._agent.model
    if isinstance(model, BidiResumableModel):
        return await model.connect(...)
    return await _LegacyModelConnection.open(model, ...)
```

### Operators

- Restart spans gain a trigger attribute, distinguishing scheduled from reactive reconnects.
- A new `add_connection_warning_event` mirrors the existing `add_interruption_event`.
- Session token totals are accurate, with per-connection attribution retained.
- `auto_reconnect: False` opts out entirely.

### Error cases

- Reconnect fails with nothing left serving: the error surfaces through `receive()`, as today.
- Turn boundary not reached in time: the coordinator proceeds anyway rather than overrun the provider's cap.
- Provider declares no limits: no timer, purely reactive, as today.
- Provider declares a wrong limit: an early reconnect (harmless) or a missed deadline that falls back to reactive. Degradation, not breakage.

## Consequences

**Easier**

- Long conversations on all three providers, with no application code.
- Accurate cost reporting, with Nova's inflated counts fixed.
- Testing reconnect: a fake channel and a fake connection, no event pump, no provider.
- Adding a provider: connection behavior is one declared attribute.

**Harder or newly owed**

- One more component to understand in bidi.
- Providers carry constants that go stale if a provider changes its limits. They belong in the provider docstring beside the value.
- Reconnects become routine rather than exceptional, so a latent bug in that path surfaces more often. This is an argument for shipping the simpler serial path first.
- Reasoning about a bidi session means reasoning about a sequence of connections. The generation counter keeps this invisible to applications, but contributors need the model in their heads.

## Open Questions

1. **Overlap or serial?** The team needs to decide between Option 1 and Option 2. The reconnect gap is measured at about 265-300ms across all providers once the OpenAI fix ships; whether that's small enough to live with is a product call, not a technical one.
2. **How much does OpenAI's cached-token loss cost** at each ~50-minute boundary? Still open, and genuinely requires production usage data rather than a live experiment. Not gating: this is a documented, non-blocking cost consequence, not a decision point.

## Willingness to Implement

Yes.
