"""Resolve the harness's ``interventions`` sugar into SDK intervention handlers.

The harness's ``interventions`` option accepts a preset name, a natural-language policy, a Cedar policy
file, an SDK handler instance, or a list of these, and coerces them into the handlers that
``Agent(interventions=...)`` expects. A raw handler instance passes through untouched, so anything
the presets don't cover (a Slack ``ask`` callback, a Cedar principal resolver, custom trust rules)
stays reachable by constructing the SDK handler yourself.

The string grammar is deterministic — no content sniffing:

- a preset keyword (``off``/``ask``/``smart``) maps to a ``HumanInTheLoop`` config,
- a path ending in ``.cedar`` loads a ``CedarAuthorization`` policy,
- any other string is a natural-language risk policy: it becomes the LLM risk classifier's prompt.

Inline Cedar policy text is intentionally *not* auto-detected — it is indistinguishable from prose,
so pass ``CedarAuthorization(policies=...)`` directly for that.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal

from strands.interventions import InterventionHandler
from strands.vended_interventions.hitl import HumanInTheLoop, LLMClassifierConfig

InterventionValue = str | InterventionHandler
InterventionsOption = InterventionValue | list[InterventionValue] | None

# How a preset collects approval: the SDK's ``"stdio"``, a custom callback, or interrupt/resume.
InterventionAsk = Literal["stdio"] | Callable[..., Any] | None


def _cedar_handler(policies: str) -> InterventionHandler:
    try:
        from strands.vended_interventions.cedar import CedarAuthorization
    except ImportError as e:
        raise ValueError(
            f"Cedar policy {policies!r} needs the optional cedar dependency. "
            "Install it with: pip install 'strands-agents[cedar]'."
        ) from e
    return CedarAuthorization(policies=policies)


def _resolve_one(value: InterventionValue, ask: InterventionAsk) -> InterventionHandler | None:
    if isinstance(value, InterventionHandler):
        return value
    if not isinstance(value, str):
        raise ValueError(
            f"Invalid interventions value {value!r}; expected a preset name, a policy string, or a handler instance."
        )
    text = value.strip()
    if text == "off":
        return None
    if text == "ask":
        return HumanInTheLoop(ask=ask)
    if text == "smart":
        return HumanInTheLoop(classifier=True, ask=ask)
    # ``.cedar`` suffix only: the SDK loader treats a non-``.cedar`` string as inline policy, and
    # sniffing file existence would misroute a prose policy that happened to match a filename.
    if text.endswith(".cedar"):
        return _cedar_handler(text)
    # Natural-language policy: the LLM risk classifier judges each call against this prompt and
    # escalates a flagged one for approval — like ``smart``, but with your own rubric.
    return HumanInTheLoop(classifier=LLMClassifierConfig(system_prompt=value), ask=ask)


def _check_handler_collisions(handlers: list[InterventionHandler]) -> None:
    """Raise if two handlers share a name — the SDK registers at most one per ``name``, so a second
    would silently win or be dropped. Different kinds (a Cedar policy plus one human-approval preset)
    have different names and coexist; two of the same kind collide."""
    seen: set[str] = set()
    for handler in handlers:
        if handler.name in seen:
            raise ValueError(
                f"Two interventions share the handler name {handler.name!r}, but an agent registers at "
                "most one per name. Layer different kinds (e.g. a Cedar policy plus one human-approval "
                "preset), not two of the same kind."
            )
        seen.add(handler.name)


def resolve_interventions(
    value: InterventionsOption,
    *,
    ask: InterventionAsk = None,
) -> list[InterventionHandler]:
    """Coerce the ``interventions`` sugar into a list of SDK handlers. ``None``/``"off"`` yield ``[]``."""
    if value is None:
        return []
    values = value if isinstance(value, list) else [value]
    handlers = [handler for v in values if (handler := _resolve_one(v, ask)) is not None]
    _check_handler_collisions(handlers)
    return handlers
