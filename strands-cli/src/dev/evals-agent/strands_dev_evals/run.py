from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from strands_evals import Case
from strands_evals.cli._agent_task import synthesize_task_function

from .harness import Harness, answer_text, load_harness
from .temporary_typescript import TemporaryTypescriptHarness

RunTask = Callable[[Case], Any]


@dataclass(frozen=True)
class _ZeroArgumentFactory:
    obj: Callable[[], Any]
    spec: str
    kind: str = "callable_no_arg"


def run_task(
    agent_file: str,
    *,
    experiment_file: str,
    custom_evaluators: Sequence[str] = (),
    temporary_typescript_runner: str | None = None,
) -> RunTask:
    harness = load_harness(
        agent_file,
        experiment_file=experiment_file,
        custom_evaluators=custom_evaluators,
        temporary_typescript_runner=temporary_typescript_runner,
    )
    if isinstance(harness, TemporaryTypescriptHarness):
        return _temporary_typescript_task(harness)
    return _traced_task(harness, agent_file)


def _traced_task(harness: Harness, agent_file: str) -> RunTask:
    traced = synthesize_task_function(_ZeroArgumentFactory(lambda: harness.build({}), agent_file))

    def run_case(case: Case) -> dict[str, Any]:
        result = traced(case)
        return {**result, "output": answer_text(result["output"])}

    return run_case


def _temporary_typescript_task(harness: TemporaryTypescriptHarness) -> RunTask:
    async def run_case(case: Case) -> dict[str, Any]:
        return {"output": answer_text(await harness.build({}).invoke_async(case.input))}

    return run_case
