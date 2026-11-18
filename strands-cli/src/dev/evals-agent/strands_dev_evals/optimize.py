from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from strands_evals import Case
from strands_evals.optimization import OneOf, Schedule, ScheduleContext, Search, TextValue, TunableFactory, tunable

from .errors import StrandsDevEvalsError
from .harness import Harness, answer_text, load_harness
from .model_effort import EFFORT_LEVELS
from .space import SpaceFile, SpaceVariable, VariableKind, read_space_file

SETTINGS = ("instructions", "effort")
_DEFAULT_SETTINGS = ("instructions",)
_LEVELS_WITHOUT_REASONING = frozenset({"auto", "off"})
_TEXT_MIN_SIZE_CAP = 8000
_INSTRUCTIONS_ABOUT = "the agent's domain instructions, which the harness appends to its own system prompt"


@dataclass(frozen=True)
class OptimizeTask:
    agent: TunableFactory
    rollout: Callable[..., Any]
    search: Search | None


class _BaselineOnly(Schedule):
    name = "baseline_only"

    def next(self, ctx: ScheduleContext) -> None:
        return None


def optimize_task(
    agent_file: str,
    *,
    space_file: str | None = None,
    settings: Sequence[str] = _DEFAULT_SETTINGS,
    baseline_only: bool = False,
) -> OptimizeTask:
    space = read_space_file(space_file) if space_file is not None else None
    harness = load_harness(agent_file)
    factory = (
        _space_factory(harness, space)
        if space is not None
        else _settings_factory(harness, tuple(dict.fromkeys(settings)))
    )
    return OptimizeTask(
        agent=factory,
        rollout=rollout,
        search=Search([], schedule=_BaselineOnly()) if baseline_only else None,
    )


async def rollout(agent_factory: Callable[..., Any], case: Case) -> dict[str, Any]:
    agent = agent_factory()
    return {"output": answer_text(await agent.invoke_async(case.input))}


def _text_marker(default: str, about: str) -> TextValue:
    size_cap = max(_TEXT_MIN_SIZE_CAP, 2 * len(default))
    return TextValue(default=default, size_cap=size_cap, edit_instructions=about or None)


def _check_instructions(harness: Harness) -> None:
    if "system_prompt" in harness.options:
        raise StrandsDevEvalsError(
            "instructions cannot be tuned: the agent passes a full system prompt, which replaces its instructions. "
            "Move that text into instructions, or tune another setting such as effort."
        )


def _instructions_marker(harness: Harness) -> TextValue:
    _check_instructions(harness)
    return _text_marker(harness.options.get("instructions") or "", _INSTRUCTIONS_ABOUT)


def _effort_marker(harness: Harness) -> OneOf:
    reason = harness.effort_unavailable()
    if reason is not None:
        raise StrandsDevEvalsError(f"effort cannot be tuned: {reason}")
    baseline = harness.effort_baseline()
    candidates = [level for level in EFFORT_LEVELS if level != "auto" or baseline == "auto"]
    levels = [level for level in candidates if level == baseline or harness.builds_with(effort=level)]
    if len(levels) < 2 or all(level in _LEVELS_WITHOUT_REASONING for level in levels):
        raise StrandsDevEvalsError(
            f"effort cannot be tuned: the agent's model accepts no reasoning levels besides {levels}. "
            "Tune instructions instead."
        )
    return OneOf(*levels, default=baseline)


_SETTING_MARKERS: dict[str, Callable[[Harness], Any]] = {
    "instructions": _instructions_marker,
    "effort": _effort_marker,
}


def _settings_factory(harness: Harness, settings: tuple[str, ...]) -> TunableFactory:
    unknown = [setting for setting in settings if setting not in _SETTING_MARKERS]
    if unknown or not settings:
        raise StrandsDevEvalsError(f"settings must name one or more of {', '.join(SETTINGS)}, got {list(settings)}")
    markers = {name: _SETTING_MARKERS[name](harness) for name in settings}

    def create_agent(**values: Any) -> Any:
        return harness.build(values)

    return tunable(create_agent, inject=markers)


def _check_variable(harness: Harness, variable: SpaceVariable) -> None:
    if variable.option == "instructions":
        _check_instructions(harness)
    if variable.item is None:
        return
    problem = harness.switch_problem(variable.option, variable.item)
    if problem:
        raise StrandsDevEvalsError(
            f"the space variable {variable.key} cannot leave out {json.dumps(variable.item)} of {variable.option}: "
            f"{problem}. Make the space file again from the agent file as it is now, then try again."
        )


def _variable_marker(variable: SpaceVariable, options: dict[str, Any]) -> Any:
    if variable.kind is VariableKind.TEXT:
        return _text_marker(variable.text_default(options), variable.about)
    if variable.kind is VariableKind.CHOICE:
        return OneOf(*variable.values, default=variable.default)
    return OneOf(True, False, default=variable.default)


def _space_factory(harness: Harness, space: SpaceFile) -> TunableFactory:
    for variable in space.variables:
        _check_variable(harness, variable)
    markers = {variable.key: _variable_marker(variable, harness.options) for variable in space.variables}

    def create_agent(**values: Any) -> Any:
        settings, without = space.overrides(values)
        return harness.build(settings, without)

    return tunable(create_agent, inject=markers)
