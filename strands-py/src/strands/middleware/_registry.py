"""Middleware registry for composing handler chains."""

from __future__ import annotations

import inspect
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from typing import Any

from .types import (
    MiddlewareHandler,
    MiddlewareInputHandler,
    MiddlewareInputPhase,
    MiddlewareNext,
    MiddlewareOutputHandler,
    MiddlewareOutputPhase,
    MiddlewareStage,
    MiddlewareWrapPhase,
)

_PHASE_ORDER: dict[str, int] = {"input": 0, "output": 1, "wrap": 2}


@dataclass
class _TaggedHandler:
    phase: str
    handler: MiddlewareHandler


class MiddlewareRegistry:
    """Registry that stores middleware handlers keyed by stage tokens and composes them into chains."""

    def __init__(self) -> None:
        """Initialize an empty registry with no handlers."""
        self._handlers: dict[MiddlewareStage[Any, Any, Any], list[_TaggedHandler]] = {}

    def add_middleware(
        self,
        stage_or_phase: (
            MiddlewareStage[Any, Any, Any]
            | MiddlewareInputPhase[Any, Any, Any]
            | MiddlewareWrapPhase[Any, Any, Any]
            | MiddlewareOutputPhase[Any, Any, Any]
        ),
        handler: Any,
    ) -> None:
        """Register middleware for a stage or phase sub-token."""
        if isinstance(stage_or_phase, MiddlewareInputPhase):
            self._add_input(stage_or_phase, handler)
        elif isinstance(stage_or_phase, MiddlewareOutputPhase):
            self._add_output(stage_or_phase, handler)
        elif isinstance(stage_or_phase, MiddlewareWrapPhase):
            self._add_wrap(stage_or_phase._stage, handler)
        else:
            self._add_wrap(stage_or_phase, handler)

    def _add_wrap(self, stage: MiddlewareStage[Any, Any, Any], handler: MiddlewareHandler) -> None:
        handlers = self._handlers.setdefault(stage, [])
        handlers.append(_TaggedHandler(phase="wrap", handler=handler))

    def _add_input(self, phase: MiddlewareInputPhase[Any, Any, Any], handler: MiddlewareInputHandler) -> None:
        stage = phase._stage

        async def adapted(context: Any, next_fn: MiddlewareNext) -> AsyncGenerator[Any, None]:
            transformed = handler(context)
            if inspect.isawaitable(transformed):
                transformed = await transformed
            async for event in next_fn(transformed):
                yield event

        handlers = self._handlers.setdefault(stage, [])
        handlers.append(_TaggedHandler(phase="input", handler=adapted))

    def _add_output(self, phase: MiddlewareOutputPhase[Any, Any, Any], handler: MiddlewareOutputHandler) -> None:
        stage = phase._stage

        # Like TS (`return await handler(yield* next(context))`), the handler runs once, after the inner
        # chain completes, on the stage's final result. The result event is recognized by type: other
        # events (stream chunks, interrupts, anything a Wrap handler injects) stream through as they
        # arrive, the last result event wins, and the transformed result is yielded last. A chain that
        # raises or halts on an interrupt never reaches the handler; one that yields no result skips it.
        async def adapted(context: Any, next_fn: MiddlewareNext) -> AsyncGenerator[Any, None]:
            result_event = None
            async for event in next_fn(context):
                if isinstance(event, stage.result_event):
                    result_event = event
                else:
                    yield event
            if result_event is None:
                return
            transformed = handler(stage.result_type(result=result_event))
            if inspect.isawaitable(transformed):
                transformed = await transformed
            if not isinstance(transformed, stage.result_type) or not isinstance(transformed.result, stage.result_event):
                raise TypeError(
                    f"Output handler must return {stage.result_type.__name__} wrapping a "
                    f"{stage.result_event.__name__}, got {_describe_output(transformed)}"
                )
            yield transformed.result

        handlers = self._handlers.setdefault(stage, [])
        handlers.append(_TaggedHandler(phase="output", handler=adapted))

    def compose(self, stage: MiddlewareStage[Any, Any, Any], terminal: MiddlewareNext) -> MiddlewareNext:
        """Compose all registered handlers for a stage into a single chain.

        Returns the terminal directly if no handlers are registered (zero overhead fast path).
        """
        tagged = self._handlers.get(stage)
        if not tagged:
            return terminal

        sorted_handlers = sorted(tagged, key=lambda t: _PHASE_ORDER[t.phase])

        current: MiddlewareNext = terminal
        for i in range(len(sorted_handlers) - 1, -1, -1):
            handler = sorted_handlers[i].handler
            next_fn = current

            def _make_layer(h: MiddlewareHandler, nf: MiddlewareNext) -> MiddlewareNext:
                async def layer(ctx: Any) -> AsyncGenerator[Any, None]:
                    inner_gens: list[AsyncGenerator[Any, None]] = []

                    def tracking_next(c: Any) -> AsyncGenerator[Any, None]:
                        gen = nf(c)
                        inner_gens.append(gen)
                        return gen

                    handler_gen = h(ctx, tracking_next)
                    try:
                        async for event in handler_gen:
                            yield event
                    finally:
                        await handler_gen.aclose()
                        for gen in inner_gens:
                            await gen.aclose()

                return layer

            current = _make_layer(handler, next_fn)

        return current

    async def invoke(
        self,
        stage: MiddlewareStage[Any, Any, Any],
        context: Any,
        terminal: MiddlewareNext,
    ) -> AsyncGenerator[Any, None]:
        """Compose and invoke the middleware chain for a stage."""
        chain = self.compose(stage, terminal)
        gen = chain(context)
        try:
            async for event in gen:
                yield event
        finally:
            await gen.aclose()


def _describe_output(value: Any) -> str:
    """Name what an Output handler returned, including the wrapped payload when there is one."""
    payload = getattr(value, "result", None)
    if payload is None:
        return type(value).__name__
    return f"{type(value).__name__} wrapping a {type(payload).__name__}"
