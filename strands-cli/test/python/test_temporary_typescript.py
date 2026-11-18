import asyncio
import json
import shlex
from pathlib import Path

import pytest
from dev_evals_support import (
    DESCRIPTION,
    RUNNER_COMMAND,
    baseline_values,
    optimize,
    space_of,
    trials_of,
    write_evaluators,
    write_experiment,
    write_typescript_agent,
)
from strands_dev_evals.temporary_typescript import TemporaryTypescriptRunner
from strands_evals.evaluators.deterministic import Contains

MODEL_OBJECT = {**DESCRIPTION, "model": None, "model_is_instance": True}
CASES = 4
RUNNER_TOKENS = 12


def requests_of(log: Path, kind: str) -> list[dict]:
    if not log.exists():
        return []
    return [request for line in log.read_text().splitlines() if (request := json.loads(line))["type"] == kind]


def optimize_typescript(tmp_path, monkeypatch, *flags, description=None, runner=RUNNER_COMMAND, experiment=None):
    monkeypatch.setenv("FAKE_RUNNER_DESCRIPTION", json.dumps(DESCRIPTION if description is None else description))
    experiment = experiment or write_experiment(tmp_path, cases=CASES, evaluators=[Contains(value="effort high")])
    agent = write_typescript_agent(tmp_path)
    runner_flags = ["--temporary-typescript-runner", runner] if runner else []
    return optimize(str(experiment), "--agent", str(agent), "--record", str(tmp_path / "record"), *runner_flags, *flags)


def test_should_tune_effort_through_the_runner_when_given_a_typescript_agent(tmp_path, monkeypatch, runner_log, capsys):
    code = optimize_typescript(tmp_path, monkeypatch, "--tune", "effort", "--iterations", "1", "--json")

    assert code == 0
    assert json.loads(capsys.readouterr().out)["baseline_id"]
    effort = space_of(tmp_path)["effort"]
    assert (effort["kind"], effort["default"]) == ("one_of", "low")
    assert {"low", "high"} <= set(effort["options"])
    assert not {"max", "auto"} & set(effort["options"])
    assert requests_of(runner_log, "run")


def test_should_tune_effort_through_the_runner_when_it_sets_effort_on_the_model_object(
    tmp_path, monkeypatch, runner_log
):
    description = {**MODEL_OBJECT, "effort_unavailable": None}

    code = optimize_typescript(tmp_path, monkeypatch, "--tune", "effort", "--iterations", "1", description=description)

    assert code == 0
    effort = space_of(tmp_path)["effort"]
    assert effort["default"] == "low"
    assert {"low", "high"} <= set(effort["options"])
    runs = requests_of(runner_log, "run")
    assert runs
    assert all(run["values"]["effort"] in effort["options"] for run in runs)


def test_should_send_the_file_instructions_to_each_trial_when_tuning_instructions(tmp_path, monkeypatch, runner_log):
    code = optimize_typescript(tmp_path, monkeypatch, "--iterations", "0")

    assert code == 0
    assert baseline_values(tmp_path) == {"instructions": "Answer briefly."}
    runs = requests_of(runner_log, "run")
    assert runs
    assert all(run["values"] == {"instructions": "Answer briefly."} for run in runs)


def test_should_count_the_runner_usage_when_trials_finish(tmp_path, monkeypatch, runner_log, capsys):
    code = optimize_typescript(tmp_path, monkeypatch, "--tune", "effort", "--iterations", "0", "--json")

    assert code == 0
    trials = trials_of(tmp_path)
    assert trials
    assert all(
        (trial["usage"]["tokens"], trial["usage"]["model_calls"], trial["usage"]["models"])
        == (RUNNER_TOKENS, 1, ["bedrock/test"])
        for trial in trials
    )
    agent_cost = json.loads(capsys.readouterr().out)["agent_cost"]
    assert sum(usage["tokens"] for usage in agent_cost.values()) == RUNNER_TOKENS * len(trials)


@pytest.mark.parametrize(
    ("evaluators", "flags", "named"),
    [
        ([{"evaluator_type": "HelpfulnessEvaluator"}], [], "HelpfulnessEvaluator"),
        (
            [{"evaluator_type": "Contains", "value": "effort"}, {"evaluator_type": "SeesTrace"}],
            ["--custom-evaluator", "dev_evals_support:SeesTrace"],
            "SeesTrace",
        ),
    ],
)
def test_should_refuse_a_trace_evaluator_before_the_runner_starts_when_the_agent_is_typescript(
    tmp_path, monkeypatch, runner_log, capsys, evaluators, flags, named
):
    experiment = write_evaluators(tmp_path, evaluators)

    code = optimize_typescript(tmp_path, monkeypatch, *flags, experiment=experiment)

    assert code == 2
    error = capsys.readouterr().err
    assert f"scores with {named}, which read the agent trace" in error
    assert "For now, strands dev runs a TypeScript agent in its own Node runner" in error
    assert not runner_log.exists()


def test_should_name_the_experiment_when_its_evaluators_cannot_be_read_for_a_typescript_agent(
    tmp_path, monkeypatch, runner_log, capsys
):
    experiment = write_evaluators(tmp_path, [{"evaluator_type": "Unknown"}])

    code = optimize_typescript(tmp_path, monkeypatch, experiment=experiment)

    assert code == 2
    assert f"cannot read the evaluators of {experiment}" in capsys.readouterr().err
    assert not runner_log.exists()


@pytest.mark.parametrize(
    ("description", "tune", "message"),
    [
        ({**DESCRIPTION, "shared_state": ["sessionManager"]}, "effort", "sessionManager"),
        ({**DESCRIPTION, "system_prompt": True}, "instructions", "Move that text into instructions"),
        (MODEL_OBJECT, "effort", "Pass the model as an id string"),
        (
            {**MODEL_OBJECT, "effort_unavailable": "the agent's model is a CustomModel object"},
            "effort",
            "effort cannot be tuned: the agent's model is a CustomModel object",
        ),
        (
            {"error": "Cannot find module '@strands-agents/harness'"},
            "effort",
            "check that strands dev can open this agent",
        ),
    ],
)
def test_should_reject_the_typescript_agent_when_the_runner_reports_it_cannot_be_tuned(
    tmp_path, monkeypatch, capsys, description, tune, message
):
    code = optimize_typescript(tmp_path, monkeypatch, "--tune", tune, description=description)

    assert code == 2
    assert message in capsys.readouterr().err


def test_should_ask_for_the_runner_when_a_typescript_agent_has_none(tmp_path, monkeypatch, capsys):
    code = optimize_typescript(tmp_path, monkeypatch, runner=None)

    assert code == 2
    assert "give temporary_typescript_runner, the command that starts its runner" in capsys.readouterr().err


def test_should_report_the_runner_command_when_it_cannot_start(tmp_path, monkeypatch, capsys):
    code = optimize_typescript(tmp_path, monkeypatch, runner=str(tmp_path / "missing-runner"))

    assert code == 2
    assert "cannot start the TypeScript runner" in capsys.readouterr().err


def test_should_match_each_reply_to_its_trial_when_the_runner_answers_out_of_order(tmp_path, monkeypatch, runner_log):
    monkeypatch.setenv("FAKE_RUNNER_MODE", "delayed")
    monkeypatch.setenv("FAKE_RUNNER_ECHO", "1")

    code = optimize_typescript(tmp_path, monkeypatch, "--tune", "effort", "--iterations", "0")

    assert code == 0
    trials = trials_of(tmp_path)
    assert len(trials) >= CASES
    assert all(trial["output"].endswith(f"for question {trial['case_name'][-1]}") for trial in trials)


def test_should_count_the_usage_of_a_failed_trial_when_the_typescript_agent_raises(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_RUNNER_MODE", "error")

    code = optimize_typescript(tmp_path, monkeypatch, "--tune", "effort", "--iterations", "0")

    assert code == 0
    trials = trials_of(tmp_path)
    assert {trial["status"] for trial in trials if trial["case_name"] == "case0"} == {"agent_failure"}
    assert {trial["status"] for trial in trials if trial["case_name"] != "case0"} == {"completed"}
    assert all(trial["usage"]["tokens"] == RUNNER_TOKENS for trial in trials)


def test_should_run_the_trial_again_when_the_runner_reports_a_retryable_failure(tmp_path, monkeypatch, runner_log):
    monkeypatch.setenv("FAKE_RUNNER_MODE", "retryable")

    code = optimize_typescript(tmp_path, monkeypatch, "--tune", "effort", "--iterations", "0")

    assert code == 0
    assert [run["input"] for run in requests_of(runner_log, "run")].count("question 0") >= 2
    assert {trial["status"] for trial in trials_of(tmp_path)} == {"completed"}


def test_should_stop_with_a_runtime_error_when_the_runner_exits_during_trials(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("FAKE_RUNNER_MODE", "exit")

    code = optimize_typescript(tmp_path, monkeypatch, "--tune", "effort", "--iterations", "0")

    assert code == 3
    error = capsys.readouterr().err
    assert "train cases unmeasured for the baseline" in error
    assert "the TypeScript runner has exited" in error


async def cancel_a_slow_run_then_ask_again(runner: TemporaryTypescriptRunner) -> tuple[dict, dict]:
    slow = asyncio.create_task(runner.call_async({"type": "run", "values": {}, "input": "question 0"}))
    await asyncio.sleep(0.05)
    slow.cancel()
    with pytest.raises(asyncio.CancelledError):
        await slow
    quick = await asyncio.wait_for(runner.call_async({"type": "run", "values": {}, "input": "question 1"}), 5)
    await asyncio.sleep(0.4)
    described = await asyncio.wait_for(runner.call_async({"type": "describe"}), 5)
    return quick, described


def test_should_keep_answering_requests_when_a_cancelled_run_replies_late(monkeypatch):
    monkeypatch.setenv("FAKE_RUNNER_MODE", "delayed")
    monkeypatch.setenv("FAKE_RUNNER_ECHO", "1")
    monkeypatch.setenv("FAKE_RUNNER_DESCRIPTION", json.dumps(DESCRIPTION))
    runner = TemporaryTypescriptRunner([*shlex.split(RUNNER_COMMAND), "agent.ts", "."])

    quick, described = asyncio.run(cancel_a_slow_run_then_ask_again(runner))
    runner.close()

    assert quick["output"] == "effort low for question 1"
    assert described["instructions"] == "Answer briefly."


def space_flags(tmp_path, variables) -> list[str]:
    space = tmp_path / "space.json"
    space.write_text(json.dumps({"variables": variables}))
    return ["--space", str(space), "--iterations", "0"]


def switches(default: bool) -> list[dict]:
    return [
        {"key": "builtinTools_0", "kind": "switch", "option": "builtinTools", "item": {"index": 0}, "default": default},
        {"key": "shell", "kind": "switch", "option": "builtinTools", "item": {"name": "shell"}, "default": default},
        {"key": "github", "kind": "switch", "option": "mcpServers", "item": {"key": "github"}, "default": True},
    ]


@pytest.mark.parametrize(
    ("default", "without"),
    [
        (False, {"$without": {"builtinTools": [{"index": 0}, {"name": "shell"}]}}),
        (True, {}),
    ],
)
def test_should_send_each_option_and_the_items_to_leave_out_when_given_a_space_file(
    tmp_path, monkeypatch, runner_log, default, without
):
    variables = [
        {"key": "brief", "kind": "text", "option": "instructions"},
        {"key": "level", "kind": "choice", "option": "effort", "values": ["low", "high"], "default": "low"},
        *switches(default),
    ]

    code = optimize_typescript(tmp_path, monkeypatch, *space_flags(tmp_path, variables))

    assert code == 0
    assert baseline_values(tmp_path)["brief"] == "Answer briefly."
    runs = requests_of(runner_log, "run")
    assert runs
    assert all(run["values"] == {"instructions": "Answer briefly.", "effort": "low", **without} for run in runs)


def test_should_record_the_space_keys_as_values_when_given_the_strands_dev_example_space(tmp_path, monkeypatch):
    variables = [
        {
            "key": "instructions",
            "kind": "text",
            "option": "instructions",
            "default": "Answer briefly.",
            "about": "the agent's instructions",
        },
        {
            "key": "model",
            "kind": "choice",
            "option": "model",
            "values": ["bedrock/a", "bedrock/b"],
            "default": "bedrock/a",
        },
        {"key": "caching", "kind": "choice", "option": "caching", "values": ["auto", True, False], "default": "auto"},
        {"key": "builtinTools_0", "kind": "switch", "option": "builtinTools", "item": {"index": 0}, "default": True},
        {"key": "mcpServers_1", "kind": "switch", "option": "mcpServers", "item": {"key": "github"}, "default": True},
    ]

    code = optimize_typescript(tmp_path, monkeypatch, *space_flags(tmp_path, variables))

    assert code == 0
    assert baseline_values(tmp_path) == {
        "instructions": "Answer briefly.",
        "model": "bedrock/a",
        "caching": "auto",
        "builtinTools_0": True,
        "mcpServers_1": True,
    }
    assert {trial["usage"]["models"][0] for trial in trials_of(tmp_path)} == {"bedrock/a"}


def test_should_refuse_to_tune_instructions_from_a_space_file_when_the_typescript_agent_has_a_system_prompt(
    tmp_path, monkeypatch, runner_log, capsys
):
    variables = [{"key": "brief", "kind": "text", "option": "instructions", "default": "Answer briefly."}]

    code = optimize_typescript(
        tmp_path, monkeypatch, *space_flags(tmp_path, variables), description={**DESCRIPTION, "system_prompt": True}
    )

    assert code == 2
    assert "Move that text into instructions" in capsys.readouterr().err
    assert requests_of(runner_log, "run") == []
