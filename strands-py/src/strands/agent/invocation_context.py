"""Handle to the request an agent call belongs to, carrying its limits and usage."""

from __future__ import annotations

import inspect
import threading
from collections.abc import Callable
from typing import Any

from typing_extensions import Required

from ..types.agent import _LIMITS_KEYS, Limits
from ..types.event_loop import StopReason, Usage


class InvocationContextUsage(Usage):
    """What the work in an :class:`InvocationContext` has used.

    Its turns and the token usage of every model call, including nested and auxiliary calls. The token keys
    keep the provider casing of :class:`~strands.types.event_loop.Usage`.

    Attributes:
        turns_taken: Turns taken in the context, including its nested calls.
    """

    turns_taken: Required[int]


# Contexts are shared across threads: sync tools, and the agents they call, run on worker threads.
_usage_lock = threading.Lock()


class InvocationContext:
    """Handle to the request an object belongs to.

    A top-level ``invoke_async()`` / ``stream_async()`` call starts a request, and the SDK
    attaches its handle to the hook events, tool contexts, and extension points it hands out
    and to the call's result. Pass it as ``invocation_context`` to a later call to run that
    call as a nested call in the same request, sharing its limits and usage, for example to
    continue a previous call's budget.

    Every nested call that joins the request shares one instance. A nested call that sets its
    own ``limits``, and an auxiliary call, get a child instance instead. A child adds its usage
    to its parent; a nested call's child is also bound by the parent's limits, while no limits
    apply to an auxiliary call.

    Note:
        Only the SDK creates instances; pass ``limits=`` to a top-level call to start a limited
        request. Treat ``usage`` as read-only: mutating it is unsupported.
    """

    _limits: Limits | None
    _parent: InvocationContext | None
    _auxiliary: bool
    _usage: InvocationContextUsage

    def __init__(self) -> None:
        """Reject direct construction.

        Raises:
            TypeError: Always; the SDK creates every instance.
        """
        raise TypeError("InvocationContext is created by the SDK; pass limits= to a top-level call instead")

    @property
    def usage(self) -> InvocationContextUsage:
        """What the work in this context has used so far.

        It keeps growing while that work runs, including background tasks the request started.
        """
        return self._usage

    @property
    def _limiting_parent(self) -> InvocationContext | None:
        """The parent whose limits also apply to this instance, if any."""
        return None if self._auxiliary else self._parent

    def _record_usage(self, usage: Usage) -> None:
        """Add one model call's usage to this instance and every parent."""
        with _usage_lock:
            context: InvocationContext | None = self
            while context is not None:
                _add_usage(context._usage, usage)
                context = context._parent

    def _take_turn(self) -> StopReason | None:
        """Count one turn here and in every parent whose limits apply, unless a limit is already reached.

        Checking and counting happen as one step, so concurrent nested calls can't both take the last turn.

        Returns:
            The stop reason for the first limit reached, or ``None`` once the turn is counted.
        """
        with _usage_lock:
            limit_stop_reason = _reached_limit(self)
            if limit_stop_reason is not None:
                return limit_stop_reason
            context: InvocationContext | None = self
            while context is not None:
                context._usage["turns_taken"] += 1
                context = context._limiting_parent
            return None


def _create_invocation_context(
    limits: Limits | None = None,
    parent: InvocationContext | None = None,
    *,
    auxiliary: bool = False,
) -> InvocationContext:
    """Create an :class:`InvocationContext`; the SDK's only way to build one.

    Args:
        limits: Limits checked against the instance's usage; ``None`` for none.
        parent: The parent instance, which also receives this one's usage, if any.
        auxiliary: Whether this is an auxiliary call: the parent's limits don't apply and its
            turns don't count toward the parent.

    Raises:
        TypeError: If ``limits`` contains an unrecognized key or a value that is not a positive int.
    """
    _validate_limits(limits)
    context = object.__new__(InvocationContext)
    context._limits = limits
    context._parent = parent
    context._auxiliary = auxiliary
    context._usage = InvocationContextUsage(turns_taken=0, inputTokens=0, outputTokens=0, totalTokens=0)
    return context


def _add_usage(total: InvocationContextUsage, usage: Usage) -> None:
    """Add one model call's usage to a context's running total."""
    total["inputTokens"] += usage["inputTokens"]
    total["outputTokens"] += usage["outputTokens"]
    total["totalTokens"] += usage["totalTokens"]
    for key in ("cacheReadInputTokens", "cacheWriteInputTokens"):
        if key in usage:
            total[key] = total.get(key, 0) + usage[key]


def _validate_limits(limits: Limits | None) -> None:
    """Reject limits that would be silently ignored or stop the call at once.

    Each limit, when set, must be a positive ``int``. Booleans are rejected because ``bool`` is a
    subclass of ``int``. An unrecognized key raises too, since a mistyped limit name would
    otherwise apply no limit at all.

    Raises:
        TypeError: If any key is not a recognized limit or any value is not a positive int.
    """
    if not limits:
        return
    unrecognized_keys = sorted(key for key in limits if key not in _LIMITS_KEYS)
    if unrecognized_keys:
        raise TypeError(
            f"limits keys {unrecognized_keys} are not recognized limits, "
            f"expected one of {', '.join(repr(key) for key in _LIMITS_KEYS)}"
        )
    for key, value in limits.items():
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise TypeError(f"limits[{key!r}] must be a positive int, got {value!r}")


def _unwrap_invocation_context(invocation_context: object | None) -> InvocationContext | None:
    """Return the handle the SDK passed out, or ``None`` when there is none.

    Raises:
        TypeError: If ``invocation_context`` is not an :class:`InvocationContext`.
    """
    if invocation_context is None:
        return None
    if not isinstance(invocation_context, InvocationContext):
        raise TypeError(
            f"invocation_context must be an InvocationContext created by the SDK, "
            f"got {type(invocation_context).__name__}"
        )
    return invocation_context


def _invocation_context_kwargs(
    method: Callable[..., Any], invocation_context: InvocationContext | None
) -> dict[str, Any]:
    """Return the keyword arguments that pass ``invocation_context`` to a user-overridable method.

    An override that neither declares ``invocation_context`` nor takes ``**kwargs`` is called without it.
    """
    try:
        parameters = inspect.signature(method).parameters
    except (TypeError, ValueError):
        return {}
    accepts_context = "invocation_context" in parameters or any(
        parameter.kind is inspect.Parameter.VAR_KEYWORD for parameter in parameters.values()
    )
    return {"invocation_context": invocation_context} if accepts_context else {}


def _create_auxiliary_invocation_context(parent: InvocationContext | None) -> InvocationContext | None:
    """Create the context for an auxiliary call.

    Auxiliary calls are the HITL classifier, steering, goal judge, web-fetch analyst, and the
    handle passed to extension points (context strategies, conversation managers, routing
    strategies, memory extractors). Its tokens add to the request's usage, but no limits apply
    to it and its turns don't count toward the request. Returns ``None`` outside a request, so
    the call runs standalone.
    """
    parent_context = _unwrap_invocation_context(parent)
    return None if parent_context is None else _create_invocation_context(None, parent_context, auxiliary=True)


def _reached_limit(invocation_context: InvocationContext) -> StopReason | None:
    """Return the stop reason for the first limit reached, or ``None`` if none is reached.

    Checks this instance's own limits first and then each parent's. Within one instance the
    order is turns, then total_tokens, then output_tokens.
    """
    own = _reached_own_limit(invocation_context)
    if own is not None:
        return own
    parent = invocation_context._limiting_parent
    return _reached_limit(parent) if parent is not None else None


def _reached_own_limit(invocation_context: InvocationContext) -> StopReason | None:
    limits = invocation_context._limits
    if not limits:
        return None
    turns = limits.get("turns")
    usage = invocation_context.usage
    if turns is not None and usage["turns_taken"] >= turns:
        return "limit_turns"
    total_tokens = limits.get("total_tokens")
    if total_tokens is not None and usage["totalTokens"] >= total_tokens:
        return "limit_total_tokens"
    output_tokens = limits.get("output_tokens")
    if output_tokens is not None and usage["outputTokens"] >= output_tokens:
        return "limit_output_tokens"
    return None
