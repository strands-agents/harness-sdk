from __future__ import annotations

import json
import shlex
import sys
import textwrap
import types
from pathlib import Path
from typing import Any

from scripted_model import ScriptedModel
from strands import Agent
from strands_evals import Case, Experiment
from strands_evals.cli.main import main
from strands_evals.evaluators import Evaluator
from strands_evals.evaluators.deterministic import Contains
from strands_evals.types.evaluation import EvaluationData, EvaluationOutput
from strands_evals.types.trace import EvaluationLevel, Session

PACKAGE_FOLDER = Path(__file__).resolve().parents[2] / "src" / "dev" / "evals-agent"
FAKE_RUNNER = Path(__file__).resolve().parent / "fake_typescript_runner.py"
RUNNER_COMMAND = f"{shlex.quote(sys.executable)} {shlex.quote(str(FAKE_RUNNER))}"
DESCRIPTION = {"instructions": "Answer briefly.", "effort": "low", "model": "bedrock/test"}
TYPESCRIPT_AGENT = "export const agent = createHarness({})\n"

DIRECT_HARNESS = """
from strands_harness import create_harness

print("loading the agent")
agent = create_harness(model="bedrock/test", instructions="Answer briefly.", effort="low")
"""

OPTIMIZE_ENTRY = """import sys

sys.path.insert(0, {package!r})

from strands_dev_evals.optimize import optimize_task

_task = optimize_task(
    {agent!r},
    experiment_file={experiment!r},
    custom_evaluators={custom!r},
    temporary_typescript_runner={runner!r},
    space_file={space!r},
    settings={settings!r},
    baseline_only={baseline!r},
)
agent = _task.agent
rollout = _task.rollout
search = _task.search
"""

RUN_ENTRY = """import sys

sys.path.insert(0, {package!r})

from strands_dev_evals.run import run_task

task = run_task(
    {agent!r},
    experiment_file={experiment!r},
    custom_evaluators={custom!r},
    temporary_typescript_runner={runner!r},
)
"""

RENAMED_FLAGS = {
    "--record": "--base-dir",
    "--width": "--proposals-per-iteration",
    "--repetitions": "--runs-per-candidate",
    "--max-concurrency": "--max-workers",
    "--rewriter-model": "--reflection-model",
}
STRANDS_DEV_SETTINGS = {
    "--split": "0.5,0.25,0.25",
    "--proposals-per-iteration": "4",
    "--runs-per-candidate": "1",
    "--max-workers": "4",
    "--max-rollouts": "500",
    "--seed": "0",
}
SWITCHES = {"--json", "--rich"}


class FakeHarness(types.ModuleType):
    def __init__(self) -> None:
        super().__init__("strands_harness")
        self.calls: list[dict[str, Any]] = []

    def create_harness(self, **options: Any) -> Agent:
        self.calls.append(options)
        effort = options.get("effort", "auto")
        if options.get("model") == "bedrock/nolevels" and effort not in ("auto", "off"):
            raise ValueError(f"Effort {effort!r} is not supported by Bedrock model nolevels.")
        if effort == "max":
            raise ValueError("Effort 'max' is not supported by Bedrock model test.")
        return Agent(model=ScriptedModel([f"effort {effort}"]), callback_handler=None)


class SeesTrace(Evaluator[str, str]):
    evaluation_level = EvaluationLevel.TRACE_LEVEL

    def evaluate(self, evaluation_case: EvaluationData[str, str]) -> list[EvaluationOutput]:
        trajectory = evaluation_case.actual_trajectory
        seen = isinstance(trajectory, Session) and bool(trajectory.traces)
        return [EvaluationOutput(score=float(seen), test_pass=seen, reason="the trace" if seen else "no trace")]

    async def evaluate_async(self, evaluation_case: EvaluationData[str, str]) -> list[EvaluationOutput]:
        return self.evaluate(evaluation_case)


def write_harness(directory: Path, source: str, name: str = "agent.py") -> Path:
    path = directory / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(source))
    return path


def write_typescript_agent(directory: Path) -> Path:
    agent = directory / "agent.ts"
    agent.write_text(TYPESCRIPT_AGENT)
    return agent


def write_experiment(directory: Path, cases: int = 4, evaluators: list[Evaluator] | None = None) -> Path:
    path = directory / "experiment.json"
    experiment = Experiment(
        cases=[Case(name=f"case{index}", input=f"question {index}") for index in range(cases)],
        evaluators=evaluators or [Contains(value="effort high")],
    )
    experiment.to_file(str(path))
    return path


def write_evaluators(directory: Path, evaluators: list[dict[str, Any]], cases: int = 1) -> Path:
    path = directory / "experiment.json"
    document = {"cases": [{"name": f"c{index}", "input": f"q{index}"} for index in range(cases)]}
    path.write_text(json.dumps({**document, "evaluators": evaluators}))
    return path


def forget_entry_modules() -> None:
    for name in [name for name in sys.modules if name.startswith("_strands_evals_cli_task_")]:
        del sys.modules[name]


def write_optimize_entry(directory: Path, agent: str, experiment: str, **options: Any) -> Path:
    path = directory / "task.py"
    path.write_text(OPTIMIZE_ENTRY.format(package=str(PACKAGE_FOLDER), agent=agent, experiment=experiment, **options))
    forget_entry_modules()
    return path


def write_run_entry(directory: Path, agent: Path, experiment: Path, **options: Any) -> Path:
    path = directory / "task.py"
    entry = {"package": str(PACKAGE_FOLDER), "agent": str(agent), "experiment": str(experiment), "custom": ()}
    path.write_text(RUN_ENTRY.format(**{**entry, "runner": None, **options}))
    forget_entry_modules()
    return path


def run_arguments(arguments: tuple[str, ...]) -> list[str]:
    experiment, *rest = arguments
    options: dict[str, Any] = {"settings": ("instructions",), "space": None, "runner": None, "custom": ()}
    iterations, agent, flags = "4", None, []
    pairs = iter(rest)
    for flag in pairs:
        if flag in SWITCHES:
            flags.append(flag)
            continue
        value = next(pairs)
        if flag == "--agent":
            agent = value
        elif flag == "--tune":
            options["settings"] = tuple(value.split(","))
        elif flag == "--space":
            options["space"] = value
        elif flag == "--temporary-typescript-runner":
            options["runner"] = value
        elif flag == "--custom-evaluator":
            options["custom"] = (*options["custom"], value)
            flags += [flag, value]
        elif flag == "--iterations":
            iterations = value
        elif flag == "--maximize":
            flags += ["--objective", f"maximize:{value}"]
        elif flag in ("--at-most", "--at-least"):
            metric, limit = value.split("=")
            flags += ["--constraint", f"{metric}{'<=' if flag == '--at-most' else '>='}{limit}"]
        else:
            flags += [RENAMED_FLAGS.get(flag, flag), value]
    for flag, value in STRANDS_DEV_SETTINGS.items():
        if flag not in flags:
            flags += [flag, value]
    baseline = iterations == "0"
    record = Path(flags[flags.index("--base-dir") + 1])
    task = write_optimize_entry(record.parent, agent, experiment, baseline=baseline, **options)
    route = ["--agent", f"{task}:agent", "--rollout", f"{task}:rollout"]
    route += ["--search", f"{task}:search"] if baseline else ["--max-iterations", iterations]
    return ["run", experiment, *route, *flags]


def optimize(*arguments: str) -> int:
    return main(["optimize", *run_arguments(arguments)])


def run(experiment: Path, agent: Path, *flags: str, **options: Any) -> int:
    entry = write_run_entry(experiment.parent, agent, experiment, **options)
    return main(["run", str(experiment), "--task", f"{entry}:task", *flags])


def run_dir(tmp_path: Path) -> Path:
    (folder,) = (tmp_path / "record").iterdir()
    return folder


def events_of(tmp_path: Path) -> list[dict]:
    return [json.loads(line) for line in (run_dir(tmp_path) / "events.jsonl").read_text().splitlines()]


def config_of(tmp_path: Path) -> dict:
    return json.loads((run_dir(tmp_path) / "run.json").read_text())


def space_of(tmp_path: Path) -> dict[str, dict]:
    return {info["key"]: info for info in config_of(tmp_path)["space"]}


def proposed_values(tmp_path: Path) -> list[dict]:
    return [event["values"] for event in events_of(tmp_path) if event["event"] == "propose" and event.get("values")]


def baseline_values(tmp_path: Path) -> dict:
    return proposed_values(tmp_path)[0]


def baseline_scores(tmp_path: Path) -> list[float]:
    return [
        score
        for event in events_of(tmp_path)
        if event["event"] == "score"
        for scores in event["objective_by_run"].values()
        for score in scores
    ]


def trials_of(tmp_path: Path) -> list[dict]:
    latest = {}
    for event in events_of(tmp_path):
        if event["event"] == "trial":
            record = event["record"]
            latest[(record["candidate_id"], record["run_index"], record["case_name"])] = record
    return list(latest.values())
