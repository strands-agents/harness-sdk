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

        # The result event is recognized by type, so other events (stream chunks, interrupts, anything
        # a Wrap handler injects before or after it) flow through untouched and the handler runs only
        # when the stage actually produced a result.
        async def adapted(context: Any, next_fn: MiddlewareNext) -> AsyncGenerator[Any, None]:
            async for event in next_fn(context):
                if not isinstance(event, stage.result_event):
                    yield event
                    continue
                transformed = handler(stage.result_type(result=event))
                if inspect.isawaitable(transformed):
                    transformed = await transformed
                if not isinstance(transformed, stage.result_type):
                    raise TypeError(
                        f"Output handler must return {stage.result_type.__name__}, got {type(transformed).__name__}"
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
