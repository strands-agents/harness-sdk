import json
from pathlib import Path

import pytest
from dev_evals_support import (
    DESCRIPTION,
    DIRECT_HARNESS,
    RUNNER_COMMAND,
    SeesTrace,
    run,
    write_evaluators,
    write_experiment,
    write_harness,
    write_typescript_agent,
)
from strands_evals.evaluators.deterministic import Contains, Equals

REPORT_FLAGS = ("--fail-on", "none")


def report_of(path: Path) -> dict:
    return json.loads(path.read_text())


def report_rows(path: Path) -> list[dict]:
    report = report_of(path)
    return [
        {"output": case["actual_output"], "passed": passed}
        for case, passed in zip(report["cases"], report["test_passes"], strict=True)
    ]


def test_should_run_each_case_on_a_fresh_agent_when_given_a_python_harness_file(harness, tmp_path):
    report = tmp_path / "report.json"
    experiment = write_experiment(tmp_path, cases=2, evaluators=[Contains(value="effort low")])

    code = run(experiment, write_harness(tmp_path, DIRECT_HARNESS), "-o", str(report), *REPORT_FLAGS)

    assert code == 0
    assert report_rows(report) == [{"output": "effort low", "passed": True}] * 2
    trial_calls = harness.calls[1:]
    assert len(trial_calls) == 2
    assert all(call["session"] is False and call["memory"] is False for call in trial_calls)


def test_should_score_the_answer_without_its_trailing_newline_when_given_a_python_harness_file(harness, tmp_path):
    report = tmp_path / "report.json"
    experiment = write_experiment(tmp_path, cases=1, evaluators=[Equals(value="effort low")])

    code = run(experiment, write_harness(tmp_path, DIRECT_HARNESS), "-o", str(report), *REPORT_FLAGS)

    assert code == 0
    assert report_rows(report) == [{"output": "effort low", "passed": True}]


def test_should_give_the_trace_to_a_trace_evaluator_when_given_a_python_harness_file(harness, tmp_path):
    report = tmp_path / "report.json"
    experiment = write_experiment(tmp_path, cases=2, evaluators=[SeesTrace()])
    flags = ("--custom-evaluator", "dev_evals_support:SeesTrace", "-o", str(report), *REPORT_FLAGS)

    code = run(experiment, write_harness(tmp_path, DIRECT_HARNESS), *flags)

    assert code == 0
    assert report_of(report)["test_passes"] == [True, True]


def test_should_run_each_case_through_the_runner_when_given_a_typescript_harness_file(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_RUNNER_DESCRIPTION", json.dumps(DESCRIPTION))
    report = tmp_path / "report.json"
    experiment = write_experiment(tmp_path, cases=2, evaluators=[Contains(value="effort low")])

    code = run(experiment, write_typescript_agent(tmp_path), "-o", str(report), *REPORT_FLAGS, runner=RUNNER_COMMAND)

    assert code == 0
    assert report_rows(report) == [{"output": "effort low", "passed": True}] * 2


@pytest.mark.parametrize(
    ("evaluators", "custom", "named"),
    [
        ([{"evaluator_type": "GoalSuccessRateEvaluator"}], (), "GoalSuccessRateEvaluator"),
        ([{"evaluator_type": "SeesTrace"}], ("dev_evals_support:SeesTrace",), "SeesTrace"),
    ],
)
def test_should_refuse_a_trace_evaluator_before_the_runner_starts_when_run_gets_a_typescript_agent(
    tmp_path, monkeypatch, runner_log, capsys, evaluators, custom, named
):
    experiment = write_evaluators(tmp_path, evaluators)
    flags = [flag for spec in custom for flag in ("--custom-evaluator", spec)]

    code = run(
        experiment,
        write_typescript_agent(tmp_path),
        *flags,
        "-o",
        str(tmp_path / "report.json"),
        runner=RUNNER_COMMAND,
        custom=custom,
    )

    assert code == 2
    assert f"scores with {named}, which read the agent trace" in capsys.readouterr().err
    assert not runner_log.exists()


def test_should_ask_for_the_runner_when_run_gets_a_typescript_agent_without_one(tmp_path, capsys):
    experiment = write_experiment(tmp_path, cases=1, evaluators=[Contains(value="effort low")])

    code = run(experiment, write_typescript_agent(tmp_path), "-o", str(tmp_path / "report.json"))

    assert code == 2
    assert "give temporary_typescript_runner" in capsys.readouterr().err


def test_should_name_a_file_that_is_not_an_agent_when_run_gets_one(tmp_path, capsys):
    experiment = write_experiment(tmp_path, cases=1, evaluators=[Contains(value="effort low")])
    notes = tmp_path / "notes.txt"
    notes.write_text("not an agent\n")

    code = run(experiment, notes, "-o", str(tmp_path / "report.json"))

    assert code == 2
    assert "is not a strands dev agent file; give a PATH.py or a PATH.ts" in capsys.readouterr().err
