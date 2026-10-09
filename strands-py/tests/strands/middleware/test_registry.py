"""Unit tests for MiddlewareRegistry compose and invoke mechanics."""

import asyncio
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from typing import Any

import pytest

from strands.interrupt import Interrupt, InterruptException
from strands.middleware._registry import MiddlewareRegistry
from strands.middleware.types import MiddlewareStage


class _Done(str):
    """The fake stage's result event: a string the registry can recognize by type."""


@dataclass
class _DoneResult:
    result: _Done


@pytest.fixture
def registry():
    return MiddlewareRegistry()


@pytest.fixture
def stage():
    return MiddlewareStage[dict, _DoneResult, str](name="test", result_type=_DoneResult, result_event=_Done)


def _make_terminal(*events: Any, result: str = "terminal_result"):
    """Create a terminal that yields events then a final result event."""

    async def terminal(context: Any) -> AsyncGenerator[Any, None]:
        for event in events:
            yield event
        yield _Done(result)

    return terminal


# --- compose: no handlers ---


@pytest.mark.asyncio
async def test_compose_no_handlers_returns_terminal_directly(registry, stage):
    terminal = _make_terminal("e1", "e2", result="done")
    chain = registry.compose(stage, terminal)
    assert chain is terminal


@pytest.mark.asyncio
async def test_compose_no_handlers_events_and_result_pass_through(registry, stage, alist):
    terminal = _make_terminal("e1", "e2", result="done")
    *events, result = await alist(registry.invoke(stage, {}, terminal))
    assert events == ["e1", "e2"]
    assert result == "done"


# --- wrap handler ---


@pytest.mark.asyncio
async def test_wrap_passthrough_forwards_events_and_result(registry, stage, alist):
    async def passthrough(context, next_fn):
        async for event in next_fn(context):
            yield event

    registry.add_middleware(stage, passthrough)
    terminal = _make_terminal("e1", result="done")
    *events, result = await alist(registry.invoke(stage, {}, terminal))
    assert events == ["e1"]
    assert result == "done"


@pytest.mark.asyncio
async def test_wrap_phase_token_registers_wrap_handler(registry, stage, alist):
    """Registering via the explicit .Wrap token behaves like passing the bare stage."""
    seen = []

    async def handler(context, next_fn):
        seen.append("wrap")
        async for event in next_fn(context):
            yield event

    registry.add_middleware(stage.Wrap, handler)
    terminal = _make_terminal("e1", result="done")
    *events, result = await alist(registry.invoke(stage, {}, terminal))
    assert seen == ["wrap"]
    assert events == ["e1"]
    assert result == "done"


@pytest.mark.asyncio
async def test_wrap_context_modification_reaches_terminal(registry, stage, alist):
    received_context = {}

    async def terminal(context):
        received_context.update(context)
        yield _Done("done")

    async def modifier(context, next_fn):
        async for event in next_fn({**context, "added": True}):
            yield event

    registry.add_middleware(stage, modifier)
    await alist(registry.invoke(stage, {"original": True}, terminal))
    assert received_context == {"original": True, "added": True}


@pytest.mark.asyncio
async def test_wrap_short_circuit_skips_terminal(registry, stage, alist):
    terminal_called = False

    async def terminal(context):
        nonlocal terminal_called
        terminal_called = True
        yield _Done("should not reach")

    async def short_circuit(context, next_fn):
        yield "cached_event"
        yield _Done("cached_result")

    registry.add_middleware(stage, short_circuit)
    *events, result = await alist(registry.invoke(stage, {}, terminal))
    assert not terminal_called
    assert events == ["cached_event"]
    assert result == "cached_result"


@pytest.mark.asyncio
async def test_wrap_event_filtering(registry, stage, alist):
    async def filter_middleware(context, next_fn):
        async for event in next_fn(context):
            if event != "skip_me":
                yield event

    registry.add_middleware(stage, filter_middleware)
    terminal = _make_terminal("keep", "skip_me", "also_keep", result="done")
    *events, result = await alist(registry.invoke(stage, {}, terminal))
    assert events == ["keep", "also_keep"]
    assert result == "done"


@pytest.mark.asyncio
async def test_wrap_event_injection(registry, stage, alist):
    async def before_after_injector(context, next_fn):
        yield "before"
        last = None
        async for event in next_fn(context):
            if last is not None:
                yield last
            last = event
        yield "after"
        yield last

    registry.add_middleware(stage, before_after_injector)
    terminal = _make_terminal("inner", result="done")
    *events, result = await alist(registry.invoke(stage, {}, terminal))
    assert events == ["before", "inner", "after"]
    assert result == "done"


@pytest.mark.asyncio
async def test_wrap_retry_calls_next_multiple_times(registry, stage, alist):
    call_count = 0

    async def terminal(context):
        nonlocal call_count
        call_count += 1
        if call_count < 3:
            raise ValueError("not yet")
        yield "success"
        yield _Done("done")

    async def retry_middleware(context, next_fn):
        for attempt in range(3):
            try:
                async for event in next_fn(context):
                    yield event
                return
            except ValueError:
                if attempt == 2:
                    raise

    registry.add_middleware(stage, retry_middleware)
    *events, result = await alist(registry.invoke(stage, {}, terminal))
    assert call_count == 3
    assert events == ["success"]
    assert result == "done"


# --- composition order ---


@pytest.mark.asyncio
async def test_first_registered_is_outermost(registry, stage, alist):
    order: list[str] = []

    async def outer(context, next_fn):
        order.append("outer_before")
        async for event in next_fn(context):
            yield event
        order.append("outer_after")

    async def inner(context, next_fn):
        order.append("inner_before")
        async for event in next_fn(context):
            yield event
        order.append("inner_after")

    registry.add_middleware(stage, outer)
    registry.add_middleware(stage, inner)
    terminal = _make_terminal(result="done")
    await alist(registry.invoke(stage, {}, terminal))
    assert order == ["outer_before", "inner_before", "inner_after", "outer_after"]


@pytest.mark.asyncio
async def test_multiple_handlers_all_see_events(registry, stage, alist):
    seen_by: dict[str, list] = {"a": [], "b": []}

    async def handler_a(context, next_fn):
        async for event in next_fn(context):
            seen_by["a"].append(event)
            yield event

    async def handler_b(context, next_fn):
        async for event in next_fn(context):
            seen_by["b"].append(event)
            yield event

    registry.add_middleware(stage, handler_a)
    registry.add_middleware(stage, handler_b)
    terminal = _make_terminal("e1", "e2", result="done")
    await alist(registry.invoke(stage, {}, terminal))
    # Both handlers see all events including the result (last event)
    assert seen_by["b"] == ["e1", "e2", "done"]
    assert seen_by["a"] == ["e1", "e2", "done"]


# --- input phase ---


@pytest.mark.asyncio
async def test_input_transforms_context(registry, stage, alist):
    received_context = {}

    async def terminal(context):
        received_context.update(context)
        yield _Done("done")

    def input_handler(context):
        return {**context, "injected": True}

    registry.add_middleware(stage.Input, input_handler)
    await alist(registry.invoke(stage, {"original": True}, terminal))
    assert received_context == {"original": True, "injected": True}


@pytest.mark.asyncio
async def test_input_async_handler(registry, stage, alist):
    received_context = {}

    async def terminal(context):
        received_context.update(context)
        yield _Done("done")

    async def async_input(context):
        return {**context, "async": True}

    registry.add_middleware(stage.Input, async_input)
    await alist(registry.invoke(stage, {}, terminal))
    assert received_context == {"async": True}


@pytest.mark.asyncio
async def test_input_runs_before_wrap(registry, stage, alist):
    order: list[str] = []

    async def terminal(context):
        order.append(f"terminal(injected={context.get('injected')})")
        yield _Done("done")

    def input_handler(context):
        order.append("input")
        return {**context, "injected": True}

    async def wrap_handler(context, next_fn):
        order.append(f"wrap(injected={context.get('injected')})")
        async for event in next_fn(context):
            yield event

    # Register wrap FIRST, then input — input still runs first due to phase ordering
    registry.add_middleware(stage, wrap_handler)
    registry.add_middleware(stage.Input, input_handler)
    await alist(registry.invoke(stage, {}, terminal))
    assert order == ["input", "wrap(injected=True)", "terminal(injected=True)"]


@pytest.mark.asyncio
async def test_input_multiple_compose_in_order(registry, stage, alist):
    received_context = {}

    async def terminal(context):
        received_context.update(context)
        yield _Done("done")

    def first_input(context):
        return {**context, "first": True}

    def second_input(context):
        return {**context, "second": True, "saw_first": context.get("first")}

    registry.add_middleware(stage.Input, first_input)
    registry.add_middleware(stage.Input, second_input)
    await alist(registry.invoke(stage, {}, terminal))
    assert received_context["first"] is True
    assert received_context["second"] is True
    assert received_context["saw_first"] is True


# --- output phase ---


@pytest.mark.asyncio
async def test_output_transforms_result(registry, stage, alist):
    def output_handler(result):
        return _DoneResult(result=_Done(result.result + "_transformed"))

    registry.add_middleware(stage.Output, output_handler)
    terminal = _make_terminal(result="original")
    *events, result = await alist(registry.invoke(stage, {}, terminal))
    assert result == "original_transformed"


@pytest.mark.asyncio
async def test_output_receives_stage_result_wrapper(registry, stage, alist):
    received = []

    def output_handler(result):
        received.append(result)
        return result

    registry.add_middleware(stage.Output, output_handler)
    terminal = _make_terminal(result="original")
    await alist(registry.invoke(stage, {}, terminal))
    assert received == [_DoneResult(result=_Done("original"))]


@pytest.mark.asyncio
async def test_output_async_handler(registry, stage, alist):
    async def async_output(result):
        return _DoneResult(result=_Done(result.result + "_async"))

    registry.add_middleware(stage.Output, async_output)
    terminal = _make_terminal(result="base")
    *events, result = await alist(registry.invoke(stage, {}, terminal))
    assert result == "base_async"


@pytest.mark.asyncio
async def test_output_does_not_affect_events(registry, stage, alist):
    def output_handler(result):
        return _DoneResult(result=_Done("transformed"))

    registry.add_middleware(stage.Output, output_handler)
    terminal = _make_terminal("e1", "e2", result="original")
    *events, result = await alist(registry.invoke(stage, {}, terminal))
    assert events == ["e1", "e2"]
    assert result == "transformed"


@pytest.mark.asyncio
async def test_output_runs_after_wrap(registry, stage, alist):
    order: list[str] = []

    async def wrap_handler(context, next_fn):
        order.append("wrap_before")
        async for event in next_fn(context):
            yield event
        order.append("wrap_after")

    def output_handler(result):
        order.append("output")
        return _DoneResult(result=_Done(result.result + "_out"))

    registry.add_middleware(stage.Output, output_handler)
    registry.add_middleware(stage, wrap_handler)
    terminal = _make_terminal(result="base")
    *events, result = await alist(registry.invoke(stage, {}, terminal))
    assert "output" in order
    assert result == "base_out"


@pytest.mark.asyncio
async def test_output_handler_must_return_stage_result_type(registry, stage, alist):
    def bad_handler(result):
        return result.result

    registry.add_middleware(stage.Output, bad_handler)
    terminal = _make_terminal(result="base")
    with pytest.raises(TypeError, match="Output handler must return _DoneResult, got _Done"):
        await alist(registry.invoke(stage, {}, terminal))


@pytest.mark.asyncio
async def test_output_handler_not_called_when_chain_yields_nothing(registry, stage, alist):
    """When the chain yields no events, the Output handler is skipped (no result to wrap)."""
    called = False

    def output_handler(result):
        nonlocal called
        called = True
        return result

    async def empty_terminal(context):
        return
        yield  # noqa: B901 — makes this an async generator that yields nothing

    registry.add_middleware(stage.Output, output_handler)
    events = await alist(registry.invoke(stage, {}, empty_terminal))
    assert events == []
    assert not called


@pytest.mark.asyncio
async def test_output_handler_skipped_when_chain_yields_no_result_event(registry, stage, alist):
    """Events that are not the stage's result event flow through and never reach the handler."""
    received: list[Any] = []

    def output_handler(result):
        received.append(result)
        return result

    async def terminal(context):
        yield "stream_chunk"
        yield "halted"

    registry.add_middleware(stage.Output, output_handler)
    events = await alist(registry.invoke(stage, {}, terminal))

    assert events == ["stream_chunk", "halted"]
    assert received == []


@pytest.mark.asyncio
async def test_output_transforms_result_event_wherever_it_appears(registry, stage, alist):
    """The result event is selected by type, so events after it are forwarded untransformed."""

    def output_handler(result):
        return _DoneResult(result=_Done(result.result + "_out"))

    async def terminal(context):
        yield "before"
        yield _Done("result")
        yield "after"

    registry.add_middleware(stage.Output, output_handler)
    events = await alist(registry.invoke(stage, {}, terminal))

    assert events == ["before", "result_out", "after"]


# --- error propagation ---


@pytest.mark.asyncio
async def test_terminal_error_propagates_through_middleware(registry, stage, alist):
    async def terminal(context):
        raise ValueError("terminal_error")
        yield  # noqa: B901 — makes it a generator

    async def passthrough(context, next_fn):
        async for event in next_fn(context):
            yield event

    registry.add_middleware(stage, passthrough)
    with pytest.raises(ValueError, match="terminal_error"):
        await alist(registry.invoke(stage, {}, terminal))


@pytest.mark.asyncio
async def test_middleware_error_propagates_to_caller(registry, stage, alist):
    async def broken_middleware(context, next_fn):
        raise RuntimeError("middleware_error")
        yield  # noqa: B901

    registry.add_middleware(stage, broken_middleware)
    terminal = _make_terminal(result="done")
    with pytest.raises(RuntimeError, match="middleware_error"):
        await alist(registry.invoke(stage, {}, terminal))


@pytest.mark.asyncio
async def test_try_finally_in_middleware_runs_on_error(registry, stage, alist):
    finally_ran = False

    async def terminal(context):
        raise ValueError("boom")
        yield  # noqa: B901

    async def guarded(context, next_fn):
        nonlocal finally_ran
        try:
            async for event in next_fn(context):
                yield event
        finally:
            finally_ran = True

    registry.add_middleware(stage, guarded)
    with pytest.raises(ValueError, match="boom"):
        await alist(registry.invoke(stage, {}, terminal))
    assert finally_ran


@pytest.mark.asyncio
async def test_try_finally_runs_on_generator_close(registry, stage):
    finally_ran = False

    async def guarded(context, next_fn):
        nonlocal finally_ran
        try:
            async for event in next_fn(context):
                yield event
        finally:
            finally_ran = True

    registry.add_middleware(stage, guarded)
    terminal = _make_terminal("e1", "e2", "e3", result="done")
    gen = registry.invoke(stage, {}, terminal)
    await gen.__anext__()
    await gen.aclose()
    assert finally_ran


# --- additional coverage ---


@pytest.mark.asyncio
async def test_chained_context_modification_across_wrap_handlers(registry, stage, alist):
    """Multiple Wrap handlers each modify context; terminal sees accumulated changes."""
    received_context = {}

    async def terminal(context):
        received_context.update(context)
        yield _Done("done")

    async def add_a(context, next_fn):
        async for event in next_fn({**context, "a": True}):
            yield event

    async def add_b(context, next_fn):
        async for event in next_fn({**context, "b": True}):
            yield event

    registry.add_middleware(stage, add_a)
    registry.add_middleware(stage, add_b)
    await alist(registry.invoke(stage, {"original": True}, terminal))
    assert received_context == {"original": True, "a": True, "b": True}


@pytest.mark.asyncio
async def test_error_transformation_by_middleware(registry, stage, alist):
    """Middleware can catch and re-throw a different error."""

    async def terminal(context):
        raise ValueError("original")
        yield  # noqa: B901

    async def transformer(context, next_fn):
        try:
            async for event in next_fn(context):
                yield event
        except ValueError as e:
            raise RuntimeError(f"Wrapped: {e}") from e

    registry.add_middleware(stage, transformer)
    with pytest.raises(RuntimeError, match="Wrapped: original"):
        await alist(registry.invoke(stage, {}, terminal))


@pytest.mark.asyncio
async def test_interrupt_exception_propagates_through_passthrough(registry, stage, alist):
    """InterruptException propagates through passthrough middleware without being swallowed."""

    async def terminal(context):
        raise InterruptException(Interrupt(id="int-1", name="test"))
        yield  # noqa: B901

    async def passthrough(context, next_fn):
        async for event in next_fn(context):
            yield event

    registry.add_middleware(stage, passthrough)
    with pytest.raises(InterruptException):
        await alist(registry.invoke(stage, {}, terminal))


@pytest.mark.asyncio
async def test_multi_layer_finally_ordering_on_error(registry, stage, alist):
    """All finally blocks run in reverse order (inner first) when terminal throws."""
    order: list[str] = []

    async def terminal(context):
        raise ValueError("boom")
        yield  # noqa: B901

    async def outer(context, next_fn):
        try:
            async for event in next_fn(context):
                yield event
        finally:
            order.append("outer_finally")

    async def inner(context, next_fn):
        try:
            async for event in next_fn(context):
                yield event
        finally:
            order.append("inner_finally")

    registry.add_middleware(stage, outer)
    registry.add_middleware(stage, inner)
    with pytest.raises(ValueError, match="boom"):
        await alist(registry.invoke(stage, {}, terminal))
    assert order == ["inner_finally", "outer_finally"]


@pytest.mark.asyncio
async def test_two_layer_finally_on_generator_close(registry, stage):
    """Both middleware finally blocks run when consumer calls aclose."""
    order: list[str] = []

    async def outer(context, next_fn):
        try:
            async for event in next_fn(context):
                yield event
        finally:
            order.append("outer_finally")

    async def inner(context, next_fn):
        try:
            async for event in next_fn(context):
                yield event
        finally:
            order.append("inner_finally")

    registry.add_middleware(stage, outer)
    registry.add_middleware(stage, inner)
    terminal = _make_terminal("e1", "e2", "e3", result="done")
    gen = registry.invoke(stage, {}, terminal)
    await gen.__anext__()
    await gen.aclose()
    assert "inner_finally" in order
    assert "outer_finally" in order


@pytest.mark.asyncio
async def test_cancelled_error_propagates_through_middleware(registry, stage, alist):
    """asyncio.CancelledError propagates through middleware without being swallowed.

    CancelledError is a BaseException, so a middleware's `except Exception` must not catch it.
    """

    async def terminal(context):
        raise asyncio.CancelledError()
        yield  # noqa: B901

    async def swallow_exceptions(context, next_fn):
        try:
            async for event in next_fn(context):
                yield event
        except Exception:  # noqa: BLE001 — deliberately broad; must NOT catch CancelledError
            yield "swallowed"

    registry.add_middleware(stage, swallow_exceptions)
    with pytest.raises(asyncio.CancelledError):
        await alist(registry.invoke(stage, {}, terminal))


@pytest.mark.asyncio
async def test_cancelled_error_propagates_through_multiple_layers(registry, stage, alist):
    """CancelledError propagates through multiple middleware layers."""

    async def terminal(context):
        raise asyncio.CancelledError()
        yield  # noqa: B901

    async def passthrough(context, next_fn):
        async for event in next_fn(context):
            yield event

    registry.add_middleware(stage, passthrough)
    registry.add_middleware(stage, passthrough)
    with pytest.raises(asyncio.CancelledError):
        await alist(registry.invoke(stage, {}, terminal))


@pytest.mark.asyncio
async def test_interrupt_exception_propagates_through_multiple_layers(registry, stage, alist):
    """InterruptException propagates through multiple passthrough layers without being swallowed."""

    async def terminal(context):
        raise InterruptException(Interrupt(id="int-1", name="test"))
        yield  # noqa: B901

    async def passthrough(context, next_fn):
        async for event in next_fn(context):
            yield event

    registry.add_middleware(stage, passthrough)
    registry.add_middleware(stage, passthrough)
    with pytest.raises(InterruptException):
        await alist(registry.invoke(stage, {}, terminal))


@pytest.mark.asyncio
async def test_outer_finally_runs_when_inner_middleware_throws(registry, stage, alist):
    """Outer middleware's finally runs when an inner middleware (not the terminal) throws."""
    order: list[str] = []

    async def outer(context, next_fn):
        try:
            async for event in next_fn(context):
                yield event
        finally:
            order.append("outer_finally")

    async def inner(context, next_fn):
        raise ValueError("inner boom")
        yield  # noqa: B901

    registry.add_middleware(stage, outer)
    registry.add_middleware(stage, inner)
    terminal = _make_terminal(result="done")
    with pytest.raises(ValueError, match="inner boom"):
        await alist(registry.invoke(stage, {}, terminal))
    assert order == ["outer_finally"]
