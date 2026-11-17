"""Offload conditions: when a strategy fires, how large content must be to act on, and what it protects."""

from __future__ import annotations

import math
import re
import warnings
from collections.abc import Callable
from dataclasses import dataclass
from fractions import Fraction
from typing import TYPE_CHECKING, Any, TypeVar, cast

from typing_extensions import TypedDict

from ....models._defaults import DEFAULT_CONTEXT_WINDOW_LIMIT

if TYPE_CHECKING:
    from ....agent.agent import Agent
    from ...types import ContextState

T = TypeVar("T")


class OffloadConditions(TypedDict, total=False):
    """Conditions that determine when and how an offload strategy fires.

    Target ``"*"`` acts on whole messages, so ``block_threshold`` measures each message; any other target acts on each
    block. With no ``context_utilization``, the strategy runs before every model call, or on each message as it arrives
    when the target isn't ``"*"`` and ``preserve_recent`` is unset or 0.

    Attributes:
        context_utilization: Context usage at or above which the strategy fires: ``"80%"`` of the context window, or a
            whole number of 1,000 or more input tokens, at most the model's context window.
        block_threshold: Size above which a message (target ``"*"``) or block is offloaded: a whole number of tokens
            above 0, or ``"5%"`` of the context window. Unset, there is no size check. Media the token count measures
            as 0 always passes, except in a strategy acting on arrival, which leaves it alone.
        preserve_recent: Newest matching messages never touched: a count, or ``"70%"`` of the matches, rounded up so a
            share above 0 keeps at least one.
    """

    context_utilization: int | str
    block_threshold: int | str
    preserve_recent: int | str


@dataclass(frozen=True)
class ParsedCondition:
    """A condition's value: a count in the condition's unit, or, with ``is_share``, a percent of a whole."""

    value: float
    is_share: bool

    def of(self, whole: int) -> int:
        """Return the count this condition stands for out of ``whole``, rounded up."""
        if not self.is_share:
            return int(self.value)
        # Exact decimal arithmetic: a percent is inexact as a binary float, and the product lands just above the
        # answer often enough to matter, so "1.1%" of 200,000 would round up to 2,201.
        return math.ceil(Fraction(str(self.value)) * whole / 100)


@dataclass(frozen=True)
class _ConditionRule:
    """The accepted range for a ``"N%"`` value's N, the smallest whole count, and the accepted forms."""

    percent_in_range: Callable[[float], bool]
    min_count: int
    expected: str


# ``[0-9]`` keeps the digits ASCII, so what matches is what ``float`` below parses.
_PERCENT_PATTERN = re.compile(r"[0-9]+(\.[0-9]+)?%")

MIN_UTILIZATION_TOKENS = 1000
"""Smaller whole numbers are almost always a percent written without "%", like ``context_utilization=80``."""

CONDITION_RULES: dict[str, _ConditionRule] = {
    "context_utilization": _ConditionRule(
        lambda percent: 0 < percent <= 100,
        MIN_UTILIZATION_TOKENS,
        f'a "N%" string up to "100%" or a whole token count of at least {MIN_UTILIZATION_TOKENS}',
    ),
    "block_threshold": _ConditionRule(
        lambda percent: 0 < percent < 100, 1, 'a "N%" string below "100%" or a whole token count above 0'
    ),
    "preserve_recent": _ConditionRule(
        lambda percent: 0 <= percent < 100, 0, 'a "N%" string below "100%" or a whole message count'
    ),
}

CONDITION_NAMES = ", ".join(CONDITION_RULES)


def build_conditions(**supplied: int | str | None) -> OffloadConditions:
    """The supplied conditions, without the ones left unset."""
    return cast(OffloadConditions, {name: value for name, value in supplied.items() if value is not None})


def parse_condition(name: str, raw: Any) -> ParsedCondition | None:
    """Parse one condition value: a ``"N%"`` string is a share, a whole number a count, and None unset.

    Raises:
        ValueError: When the value is not accepted for the condition.
    """
    if raw is None:
        return None
    rule = CONDITION_RULES[name]
    if isinstance(raw, str) and _PERCENT_PATTERN.fullmatch(raw):
        percent = float(raw[:-1])
        if rule.percent_in_range(percent):
            return ParsedCondition(percent, True)
    if isinstance(raw, int) and not isinstance(raw, bool) and raw >= rule.min_count:
        return ParsedCondition(raw, False)
    shown = f'"{raw}"' if isinstance(raw, str) else raw
    raise ValueError(f"{name}={shown} is invalid: expected {rule.expected}{_percent_hint(raw)}")


def _percent_hint(raw: Any) -> str:
    """Suggest the ``"N%"`` spelling for a rejected number that reads as a share or a percent."""
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not 0 < raw <= 100:
        return ""
    percent = f"{raw * 100 if raw <= 1 else raw:g}"
    return f'; for {percent}%, write "{percent}%"'


def _effective_window_limit(agent: Agent) -> int:
    """The model's context window, falling back to the default ``estimate_utilization`` uses."""
    return agent.model.context_window_limit or DEFAULT_CONTEXT_WINDOW_LIMIT


class ResolvedConditions:
    """A strategy's parsed conditions, and what they resolve to on an agent."""

    context_utilization: ParsedCondition | None
    block_threshold: ParsedCondition | None
    preserve_recent: ParsedCondition | None

    def __init__(self, conditions: OffloadConditions | None = None) -> None:
        """Parse the conditions as supplied.

        Raises:
            ValueError: When a condition name is unknown or its value is invalid.
        """
        conditions = conditions or OffloadConditions()
        for name in conditions:
            if name not in CONDITION_RULES:
                raise ValueError(f'unknown condition "{name}": expected {CONDITION_NAMES}')
        self.context_utilization = parse_condition("context_utilization", conditions.get("context_utilization"))
        self.block_threshold = parse_condition("block_threshold", conditions.get("block_threshold"))
        preserve_recent = parse_condition("preserve_recent", conditions.get("preserve_recent"))
        self.preserve_recent = None if preserve_recent is not None and preserve_recent.value == 0 else preserve_recent

    @property
    def is_empty(self) -> bool:
        """Whether no condition narrows when or what the strategy acts on."""
        return self.context_utilization is None and self.block_threshold is None and self.preserve_recent is None

    @property
    def defers_arrival(self) -> bool:
        """Whether something other than size defers the strategy past a message's arrival."""
        return self.context_utilization is not None or self.preserve_recent is not None

    def reached(self, context: ContextState) -> bool:
        """Whether the utilization gate (if any) is open: on overflow, or at or above the configured share."""
        utilization = self.context_utilization
        if utilization is None or context.overflow:
            return True
        whole = 100 if utilization.is_share else _effective_window_limit(context.agent)
        return context.utilization >= utilization.value / whole

    def threshold_tokens(self, agent: Agent) -> int | None:
        """Tokens above which content is offloaded, or None when ``block_threshold`` is unset so nothing is checked."""
        threshold = self.block_threshold
        return None if threshold is None else threshold.of(_effective_window_limit(agent))

    def without_preserved(self, matching: list[T]) -> list[T]:
        """``matching`` without the newest ones ``preserve_recent`` protects."""
        keep = self.preserve_recent.of(len(matching)) if self.preserve_recent else 0
        return [] if keep >= len(matching) else matching[: len(matching) - keep]

    def check_fits(self, agent: Agent) -> None:
        """Check a token-count ``context_utilization`` fits the model's context window.

        Raises:
            ValueError: When it is larger than the model's context window.
        """
        utilization = self.context_utilization
        if utilization is None or utilization.is_share:
            return
        limit = agent.model.context_window_limit
        if not limit:
            # Caller depth varies, so stacklevel=1 pins dedup to this line (once per process).
            warnings.warn(
                f"context_utilization is {int(utilization.value)} tokens but context_window_limit is not set on the"
                " model, so it cannot be checked against the context window; set context_window_limit in your model"
                " config",
                stacklevel=1,
            )
            return
        if utilization.value <= limit:
            return
        raise ValueError(
            f"context_utilization ({int(utilization.value)}) is larger than the model's context window"
            f' ({limit} tokens); use a smaller token count or a "N%" share'
        )
