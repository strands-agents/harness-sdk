from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from strands_evals import Case
from strands_evals.cli._agent_task import synthesize_task_function

from .harness import Harness, answer_text, load_harness

RunTask = Callable[[Case], Any]


@dataclass(frozen=True)
class _ZeroArgumentFactory:
    obj: Callable[[], Any]
    spec: str
    kind: str = "callable_no_arg"


def run_task(agent_file: str) -> RunTask:
    return _traced_task(load_harness(agent_file), agent_file)


def _traced_task(harness: Harness, agent_file: str) -> RunTask:
    traced = synthesize_task_function(_ZeroArgumentFactory(lambda: harness.build({}), agent_file))

    def run_case(case: Case) -> dict[str, Any]:
        result = traced(case)
        return {**result, "output": answer_text(result["output"])}

    return run_case
