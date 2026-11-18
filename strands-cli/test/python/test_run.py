import json
from pathlib import Path

from dev_evals_support import DIRECT_HARNESS, SeesTrace, run, write_experiment, write_harness
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


def test_should_name_a_file_that_is_not_an_agent_when_run_gets_one(tmp_path, capsys):
    experiment = write_experiment(tmp_path, cases=1, evaluators=[Contains(value="effort low")])
    notes = tmp_path / "notes.txt"
    notes.write_text("not an agent\n")

    code = run(experiment, notes, "-o", str(tmp_path / "report.json"))

    assert code == 2
    assert "is not a strands dev agent file; give a PATH.py" in capsys.readouterr().err
