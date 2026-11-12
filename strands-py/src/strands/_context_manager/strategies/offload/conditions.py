"""Offload conditions: when a strategy fires, how large content must be to act on, and what it protects."""

from __future__ import annotations

import logging
import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, TypeVar

from typing_extensions import TypedDict

from ....models._defaults import DEFAULT_CONTEXT_WINDOW_LIMIT

if TYPE_CHECKING:
    from ....agent.agent import Agent
    from ...types import ContextState

logger = logging.getLogger(__name__)

T = TypeVar("T")


class OffloadConditions(TypedDict, total=False):
    """Conditions that determine when and how an offload strategy fires.

    - ``context_utilization`` sets when the strategy fires. ``"80%"`` fires at 80% of the context window; a whole
      number of 1,000 or more fires at that many conversation tokens, and raises if it exceeds the model's context
      window.
    - ``block_threshold`` sets how large each block, or each message for target ``"*"``, must be to act on. A whole
      number selects content larger than that many tokens; ``"5%"`` selects content larger than 5% of the context
      window (10,000 tokens of a 200,000-token window).
    - ``preserve_recent`` sets which matching messages it never touches. A whole number keeps that many of the newest;
      ``"70%"`` keeps the newest 70% of them.

    With no ``context_utilization``, the strategy runs before every model call, or on each message as it arrives when
    the target isn't ``"*"`` and ``preserve_recent`` is unset or 0. ``block_threshold`` doesn't change when it runs.

    Granularity: target ``"*"`` acts on whole messages, and ``block_threshold`` measures each message. Drop removes
    them, summarize merges each contiguous run, and truncate elides the middle and doesn't take a ``block_threshold``.
    Any other target acts on each block, and ``block_threshold`` measures each block. ``context_utilization`` only
    gates when the strategy fires, and ``preserve_recent`` only protects the newest matching messages.

    Strategies run as an ordered pipeline, so once an earlier strategy shrinks a block, it falls below the next
    strategy's threshold and gets skipped.

    Attributes:
        context_utilization: Context usage at or above which the strategy fires: ``"80%"`` of the context window, or a
            whole number of 1,000 or more for conversation tokens, at most the model's context window.
        block_threshold: Size above which a message (target ``"*"``) or block is offloaded: a whole number of tokens
            above 0, or ``"5%"`` of the context window. Unset, there is no size check. Media the token count measures
            as 0, alone or in a tool result, always passes.
        preserve_recent: Newest matching messages never touched: a count, or ``"70%"`` of the matches, rounded up so a
            share above 0 keeps at least one.
    """

    context_utilization: int | str
    block_threshold: int | str
    preserve_recent: int | str


@dataclass(frozen=True)
class ParsedCondition:
    """A parsed condition: a count in the condition's unit, or a share of a whole.

    Attributes:
        value: The count, or a share's percent as written.
        is_share: Whether ``value`` is a percent of a whole rather than a count.
    """

    value: float
    is_share: bool

    def of(self, whole: int) -> int:
        """Return the count this condition stands for out of ``whole``, rounded up."""
        # Multiplies before dividing: `percent / 100` is inexact for most percents, and the product of that and
        # `whole` lands just above the answer, so "7%" of 100 would round up to 8.
        return math.ceil(self.value * whole / 100) if self.is_share else int(self.value)

    @property
    def share(self) -> float:
        """A share's fraction of the whole, for a condition compared against one directly."""
        return self.value / 100


@dataclass(frozen=True)
class _ConditionRule:
    """The accepted range for a ``"N%"`` value's N, the smallest whole count, and the accepted forms."""

    percent_in_range: Callable[[float], bool]
    min_count: int
    expected: str


_PERCENT_PATTERN = re.compile(r"^\d+(\.\d+)?%$")

MIN_UTILIZATION_TOKENS = 1000
"""Smaller whole numbers are almost always a percent written without "%", like ``context_utilization=80``."""

CONDITION_RULES: dict[str, _ConditionRule] = {
    "context_utilization": _ConditionRule(
        percent_in_range=lambda percent: 0 < percent <= 100,
        min_count=MIN_UTILIZATION_TOKENS,
        expected=f'a "N%" string up to "100%" or a whole token count of at least {MIN_UTILIZATION_TOKENS}',
    ),
    "block_threshold": _ConditionRule(
        percent_in_range=lambda percent: 0 < percent < 100,
        min_count=1,
        expected='a "N%" string below "100%" or a whole token count above 0',
    ),
    "preserve_recent": _ConditionRule(
        percent_in_range=lambda percent: 0 <= percent < 100,
        min_count=0,
        expected='a "N%" string below "100%" or a whole message count',
    ),
}

*_LEADING_NAMES, _FINAL_NAME = CONDITION_RULES
CONDITION_NAMES = f"{', '.join(_LEADING_NAMES)}, or {_FINAL_NAME}"


def build_conditions(
    *,
    context_utilization: int | str | None = None,
    block_threshold: int | str | None = None,
    preserve_recent: int | str | None = None,
) -> OffloadConditions:
    """Collect the conditions that were supplied into an :class:`OffloadConditions`."""
    conditions = OffloadConditions()
    if context_utilization is not None:
        conditions["context_utilization"] = context_utilization
    if block_threshold is not None:
        conditions["block_threshold"] = block_threshold
    if preserve_recent is not None:
        conditions["preserve_recent"] = preserve_recent
    return conditions


def parse_condition(name: str, raw: Any) -> ParsedCondition | None:
    """Parse one offload condition value: a ``"N%"`` string is a share, and a whole number is a count.

    Args:
        name: The condition name.
        raw: The value as supplied, or None when unset.

    Returns:
        The parsed condition, or None when unset.

    Raises:
        ValueError: When the value is not accepted for the condition.
    """
    if raw is None:
        return None
    rule = CONDITION_RULES[name]
    if isinstance(raw, str) and _PERCENT_PATTERN.match(raw):
        percent = float(raw[:-1])
        if rule.percent_in_range(percent):
            return ParsedCondition(percent, True)
    if isinstance(raw, int) and not isinstance(raw, bool) and raw >= rule.min_count:
        return ParsedCondition(raw, False)
    raise ValueError(f"{name}={_format_value(raw)} is invalid: expected {rule.expected}{_percent_hint(raw)}")


def _percent_hint(raw: Any) -> str:
    """Suggest the ``"N%"`` spelling for a rejected number that reads as a share or a percent."""
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not 0 < raw <= 100:
        return ""
    percent = f"{raw * 100 if raw <= 1 else raw:g}"
    return f'; for {percent}%, write "{percent}%"'


def _format_value(raw: Any) -> str:
    return f'"{raw}"' if isinstance(raw, str) else str(raw)


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

        Args:
            conditions: The conditions as supplied.

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
        limit = _effective_window_limit(context.agent)
        share = utilization.share if utilization.is_share else utilization.value / limit
        return context.utilization >= share

    def threshold_tokens(self, agent: Agent) -> int | None:
        """Tokens above which content is offloaded, or None when ``block_threshold`` is unset so nothing is checked."""
        threshold = self.block_threshold
        if threshold is None:
            return None
        return threshold.of(_effective_window_limit(agent)) if threshold.is_share else int(threshold.value)

    def without_preserved(self, matching: list[T]) -> list[T]:
        """``matching`` without the newest ones ``preserve_recent`` protects."""
        keep = self.preserve_recent.of(len(matching)) if self.preserve_recent else 0
        return [] if keep >= len(matching) else matching[: len(matching) - keep]

    def check_fits(self, agent: Agent) -> None:
        """Check a token-count ``context_utilization`` fits the model's context window.

        Args:
            agent: The agent the strategy is attached to.

        Raises:
            ValueError: When it is larger than the model's context window.
        """
        utilization = self.context_utilization
        if utilization is None or utilization.is_share:
            return
        limit = agent.model.context_window_limit
        if not limit:
            logger.warning(
                "context_utilization=<%s> | context_window_limit is not set on the model, skipping the context window"
                " check | set context_window_limit in your model config",
                int(utilization.value),
            )
            return
        if utilization.value <= limit:
            return
        raise ValueError(
            f"context_utilization ({int(utilization.value)}) is larger than the model's context window"
            f' ({limit} tokens); use a smaller token count or a "N%" share'
        )
