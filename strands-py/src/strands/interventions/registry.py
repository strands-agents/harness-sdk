"""Bridges InterventionHandler instances to the Strands hook system.

Registers one hook callback per lifecycle event type, dispatches to all handlers
that override that method in registration order, with short-circuiting on Deny
(and denied Confirms) and accumulation for Guide.
"""

import inspect
import logging
from collections.abc import Callable

from ..hooks.events import (
    AfterModelCallEvent,
    AfterToolCallEvent,
    BeforeInvocationEvent,
    BeforeModelCallEvent,
    BeforeToolCallEvent,
)
from ..hooks.registry import HookOrder, HookRegistry
from ..interrupt import InterruptException
from ..types.content import _generate_tracking_id
from .actions import Confirm, Deny, Guide, InterventionAction, LifecycleEvent, Proceed, Transform, default_evaluate
from .handler import InterventionHandler

logger = logging.getLogger(__name__)


class InterventionRegistry:
    """Bridges InterventionHandler instances and the Strands hook system.

    Registers one hook callback per lifecycle event type, dispatches to all
    handlers that override that method in registration order.
    """

    def __init__(self, handlers: list[InterventionHandler], hook_registry: HookRegistry) -> None:
        """Initialize the registry and wire handlers into the hook system.

        Args:
            handlers: Intervention handlers in evaluation order.
            hook_registry: The agent's hook registry to attach callbacks to.

        Raises:
            ValueError: If two handlers share the same name.
        """
        seen: set[str] = set()
        for h in handlers:
            if h.name in seen:
                raise ValueError(f"Duplicate intervention handler name: '{h.name}'")
            seen.add(h.name)

        self._handlers = handlers
        self._register_hooks(hook_registry)

    @property
    def handlers(self) -> list[InterventionHandler]:
        """Registered handlers in registration order."""
        return list(self._handlers)

    def _is_overridden(self, handler: InterventionHandler, method: str) -> bool:
        """Check if a handler overrides a lifecycle method."""
        handler_method = getattr(type(handler), method, None)
        base_method = getattr(InterventionHandler, method, None)
        return handler_method is not base_method

    def _register_hooks(self, hook_registry: HookRegistry) -> None:
        if any(self._is_overridden(h, "before_invocation") for h in self._handlers):
            hook_registry.add_callback(
                BeforeInvocationEvent,
                self._on_before_invocation,
                order=HookOrder.INTERVENTION_INPUT,
            )
        if any(self._is_overridden(h, "before_tool_call") for h in self._handlers):
            hook_registry.add_callback(
                BeforeToolCallEvent,
                self._on_before_tool_call,
                order=HookOrder.INTERVENTION_INPUT,
            )
        if any(self._is_overridden(h, "after_tool_call") for h in self._handlers):
            hook_registry.add_callback(
                AfterToolCallEvent,
                self._on_after_tool_call,
                order=HookOrder.INTERVENTION_OUTPUT,
            )
        if any(self._is_overridden(h, "before_model_call") for h in self._handlers):
            hook_registry.add_callback(
                BeforeModelCallEvent,
                self._on_before_model_call,
                order=HookOrder.INTERVENTION_INPUT,
            )
        if any(self._is_overridden(h, "after_model_call") for h in self._handlers):
            hook_registry.add_callback(
                AfterModelCallEvent,
                self._on_after_model_call,
                order=HookOrder.INTERVENTION_OUTPUT,
            )

    async def _on_before_invocation(self, event: BeforeInvocationEvent) -> None:
        await self._dispatch(event, "before_invocation", self._apply_before_invocation)

    async def _on_before_tool_call(self, event: BeforeToolCallEvent) -> None:
        await self._dispatch(event, "before_tool_call", self._apply_before_tool_call)

    async def _on_after_tool_call(self, event: AfterToolCallEvent) -> None:
        await self._dispatch(event, "after_tool_call", self._apply_after_tool_call)

    async def _on_before_model_call(self, event: BeforeModelCallEvent) -> None:
        await self._dispatch(event, "before_model_call", self._apply_before_model_call)

    async def _on_after_model_call(self, event: AfterModelCallEvent) -> None:
        await self._dispatch(event, "after_model_call", self._apply_after_model_call)

    def _apply_before_invocation(self, event: LifecycleEvent, action: InterventionAction, handler_name: str) -> bool:
        if isinstance(action, Deny):
            event.cancel = f"DENIED: {action.reason}"
            return True
        elif isinstance(action, Guide):
            event.cancel = f"GUIDANCE: {action.feedback}"
            return False
        elif isinstance(action, Transform):
            action.apply(event)
            return False
        elif isinstance(action, Proceed):
            return False
        logger.warning("handler=<%s>, event=<before_invocation> | %s has no effect", handler_name, action.type)
        return False

    def _apply_before_tool_call(self, event: LifecycleEvent, action: InterventionAction, handler_name: str) -> bool:
        if isinstance(action, Deny):
            event.cancel_tool = f"DENIED: {action.reason}"
            return True
        elif isinstance(action, Confirm):
            result = event.interrupt(  # type: ignore[union-attr]
                handler_name,
                reason=action.prompt,
                **({"response": action.response} if action.response is not None else {}),
            )
            check = action.evaluate if action.evaluate is not None else default_evaluate
            if not check(result):
                event.cancel_tool = f"CONFIRMATION_FAILED: {action.prompt}"
                return True
            return False
        elif isinstance(action, Guide):
            event.cancel_tool = f"GUIDANCE: {action.feedback}"
            return False
        elif isinstance(action, Transform):
            action.apply(event)
            return False
        elif isinstance(action, Proceed):
            return False
        logger.warning("handler=<%s>, event=<before_tool_call> | %s has no effect", handler_name, action.type)  # type: ignore[unreachable]
        return False

    def _apply_after_tool_call(self, event: LifecycleEvent, action: InterventionAction, handler_name: str) -> bool:
        if isinstance(action, Transform):
            action.apply(event)
            return False
        elif isinstance(action, Proceed):
            return False
        logger.warning("handler=<%s>, event=<after_tool_call> | %s has no effect", handler_name, action.type)
        return False

    def _apply_before_model_call(self, event: LifecycleEvent, action: InterventionAction, handler_name: str) -> bool:
        if isinstance(action, Deny):
            event.cancel = f"DENIED: {action.reason}"
            return True
        elif isinstance(action, Guide):
            event.agent.messages.append(
                {"role": "user", "content": [{"text": action.feedback}], "tracking_id": _generate_tracking_id()}
            )
            return False
        elif isinstance(action, Transform):
            action.apply(event)
            return False
        elif isinstance(action, Proceed):
            return False
        logger.warning("handler=<%s>, event=<before_model_call> | %s has no effect", handler_name, action.type)
        return False

    def _apply_after_model_call(self, event: LifecycleEvent, action: InterventionAction, handler_name: str) -> bool:
        if isinstance(action, Guide):
            event.retry = True
            event.agent.messages.append(
                {"role": "user", "content": [{"text": action.feedback}], "tracking_id": _generate_tracking_id()}
            )
            return False
        elif isinstance(action, Transform):
            action.apply(event)
            return False
        elif isinstance(action, Proceed):
            return False
        logger.warning("handler=<%s>, event=<after_model_call> | %s has no effect", handler_name, action.type)
        return False

    async def _dispatch(
        self,
        event: LifecycleEvent,
        method: str,
        apply: Callable[[LifecycleEvent, InterventionAction, str], bool],
    ) -> None:
        """Iterate handlers in registration order and resolve the winning action."""
        logger.debug("event=<%s> | dispatching to %d handler(s)", method, len(self._handlers))
        guides: list[tuple[str, Guide]] = []

        for handler in self._handlers:
            if not self._is_overridden(handler, method):
                continue

            logger.debug("handler=<%s>, event=<%s> | evaluating", handler.name, method)

            action: InterventionAction | None = None
            try:
                method_fn = getattr(handler, method)
                result = method_fn(event)
                # Overrides may be sync or async, so branch on the returned value.
                action = await result if inspect.isawaitable(result) else result
            except InterruptException:
                # Intentional control flow (pauses the agent), not a handler failure.
                # Always propagate regardless of on_error.
                raise
            except Exception as error:
                action = self._handle_error(handler, method, error)
                if action is None:
                    continue

            if action is None:
                raise TypeError(f"handler '{handler.name}.{method}' returned None; expected an InterventionAction")

            logger.debug("handler=<%s>, event=<%s> | returned %s", handler.name, method, action.type)

            if isinstance(action, Guide):
                guides.append((handler.name, action))
            else:
                try:
                    if apply(event, action, handler.name):
                        logger.debug("handler=<%s>, event=<%s> | short-circuited", handler.name, method)
                        return
                except InterruptException:
                    raise
                except Exception as error:
                    error_action = self._handle_error(handler, method, error)
                    if error_action is not None:
                        if apply(event, error_action, handler.name):
                            return

        if guides:
            logger.debug("event=<%s> | applying accumulated guide from %d handler(s)", method, len(guides))
            feedback = "\n".join(f"[{name}] {g.feedback}" for name, g in guides)
            apply(event, Guide(feedback=feedback), "")

    def _handle_error(self, handler: InterventionHandler, method: str, error: Exception) -> InterventionAction | None:
        error_msg = str(error)

        if handler.on_error == "throw":
            raise error
        elif handler.on_error == "deny":
            logger.warning("handler=<%s>, event=<%s>, on_error=<deny> | %s", handler.name, method, error_msg)
            return Deny(reason=f"Handler threw: {error_msg}")
        elif handler.on_error == "proceed":
            logger.warning(
                "handler=<%s>, event=<%s>, on_error=<proceed> | handler error skipped (fail-open) | %s",
                handler.name,
                method,
                error_msg,
            )
            return None
        else:
            raise error
