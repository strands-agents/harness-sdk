import asyncio
import json
import logging
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
import strands_dev_evals.generate as generate
import strands_evals.generators.experiment_generator as experiment_generator
from strands_dev_evals.generate import GenerateProgress, ProgressGenerator, error_text, main
from strands_evals import Case, Experiment
from strands_evals.evaluators import OutputEvaluator
from strands_evals.generators import ExperimentGenerator
from strands_evals.generators.topic_planner import Topic, TopicPlan, TopicPlanner

CONTEXT = "A refund agent."
WRITTEN_RUBRIC = "Score answers that issue the refund."
CASE_VALUES = {
    "name": "refund",
    "input": "Refund order 2001",
    "expected_output": "Refund it",
    "expected_trajectory": ["lookup_order", "refund"],
    "metadata": {"topic": "refunds"},
}
GENERATOR_FLAGS = [
    "--max-parallel-num-cases",
    "3",
    "--no-expected-output",
    "--expected-trajectory",
    "--expected-interactions",
    "--metadata",
]


def fake_case_agent(*failures: BaseException) -> type:
    queued = list(failures)

    class FakeCaseAgent:
        def __init__(self, **_options):
            pass

        async def structured_output_async(self, output_model, _prompt):
            await asyncio.sleep(0)
            if queued:
                raise queued.pop(0)
            return output_model(**{field: CASE_VALUES[field] for field in output_model.model_fields})

    return FakeCaseAgent


def fake_rubric_agent(prompts: list[str]) -> type:
    class FakeRubricAgent:
        def __init__(self, **_options):
            pass

        async def invoke_async(self, prompt):
            prompts.append(prompt)
            return WRITTEN_RUBRIC

    return FakeRubricAgent


def agent_that_cannot_start(**_options):
    raise ValueError("unknown model id")


@pytest.fixture
def case_agent(monkeypatch):
    monkeypatch.setattr(generate, "Agent", fake_case_agent())


@pytest.fixture
def rubric_prompts(monkeypatch) -> list[str]:
    prompts: list[str] = []
    monkeypatch.setattr(experiment_generator, "Agent", fake_rubric_agent(prompts))
    return prompts


@pytest.fixture
def generators(monkeypatch) -> list[ExperimentGenerator]:
    created: list[ExperimentGenerator] = []

    async def from_context(self, **_options):
        created.append(self)
        return Experiment(cases=[Case[str, str](name="c0", input="q0")])

    monkeypatch.setattr(ExperimentGenerator, "from_context_async", from_context)
    return created


def command(tmp_path: Path, *flags: str, language: str = "python") -> list[str]:
    return [
        "--context",
        CONTEXT,
        "--agent-language",
        language,
        "--progress",
        str(tmp_path / "progress.jsonl"),
        "--output",
        str(tmp_path / "experiment.json"),
        *flags,
    ]


def evaluator_flags(*specs: str) -> list[str]:
    return [f"--evaluator={spec}" for spec in specs]


def written(tmp_path: Path) -> dict:
    return json.loads((tmp_path / "experiment.json").read_text())


def events(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines()]


def generator_settings(generator: ExperimentGenerator) -> dict:
    return {
        "include_expected_output": generator.include_expected_output,
        "include_expected_trajectory": generator.include_expected_trajectory,
        "include_expected_interactions": generator.include_expected_interactions,
        "include_metadata": generator.include_metadata,
        "max_parallel_num_cases": generator.max_parallel_num_cases,
    }


def progress_generator(path: Path) -> tuple[ProgressGenerator, GenerateProgress]:
    progress = GenerateProgress(str(path))
    return ProgressGenerator(progress, input_type=str, output_type=str), progress


class FullDisk:
    def write(self, _text):
        raise OSError(28, "No space left on device")

    def flush(self):
        pass

    def close(self):
        pass


def full_disk_generator(tmp_path: Path, monkeypatch) -> tuple[ProgressGenerator, GenerateProgress]:
    with monkeypatch.context() as patched:
        patched.setattr(Path, "open", lambda *_args, **_kwargs: FullDisk())
        progress = GenerateProgress(str(tmp_path / "progress.jsonl"))
    return ProgressGenerator(progress, input_type=str, output_type=str), progress


def test_should_attach_every_evaluator_when_several_are_given(tmp_path, case_agent, rubric_prompts):
    specs = evaluator_flags(
        "OutputEvaluator",
        "HelpfulnessEvaluator",
        '{"evaluator_type": "ToolCalled", "tool_name": "lookup_order"}',
        '{"evaluator_type": "Contains", "value": "refund", "case_sensitive": false}',
    )

    code = main(command(tmp_path, "--num-cases", "1", *specs))

    output, helpfulness, tool_called, contains = written(tmp_path)["evaluators"]
    assert code == 0
    assert [item["evaluator_type"] for item in written(tmp_path)["evaluators"]] == [
        "OutputEvaluator",
        "HelpfulnessEvaluator",
        "ToolCalled",
        "Contains",
    ]
    assert output["rubric"] == WRITTEN_RUBRIC
    assert "rubric" not in helpfulness
    assert tool_called["tool_name"] == "lookup_order"
    assert (contains["value"], contains["case_sensitive"]) == ("refund", False)
    assert len(written(tmp_path)["cases"]) == 1


def test_should_write_one_rubric_from_the_context_for_each_rubric_judge_when_several_are_given(
    tmp_path, case_agent, rubric_prompts
):
    code = main(command(tmp_path, "--num-cases", "1", *evaluator_flags("OutputEvaluator", "TrajectoryEvaluator")))

    assert code == 0
    assert [item["rubric"] for item in written(tmp_path)["evaluators"]] == [WRITTEN_RUBRIC, WRITTEN_RUBRIC]
    assert len(rubric_prompts) == 2
    assert all(CONTEXT in prompt for prompt in rubric_prompts)


def test_should_keep_the_given_rubric_when_the_evaluator_has_one(tmp_path, case_agent, rubric_prompts):
    spec = '{"evaluator_type": "OutputEvaluator", "rubric": "my rubric"}'

    code = main(command(tmp_path, "--num-cases", "1", *evaluator_flags(spec)))

    assert code == 0
    assert [(item["evaluator_type"], item["rubric"]) for item in written(tmp_path)["evaluators"]] == [
        ("OutputEvaluator", "my rubric")
    ]
    assert rubric_prompts == []


def test_should_keep_two_copies_of_an_evaluator_when_their_names_differ(tmp_path, case_agent):
    specs = evaluator_flags(
        '{"evaluator_type": "Contains", "value": "refund", "name": "says refund"}',
        '{"evaluator_type": "Contains", "value": "days", "name": "says days"}',
    )

    code = main(command(tmp_path, "--num-cases", "1", *specs))

    assert code == 0
    assert [evaluator["name"] for evaluator in written(tmp_path)["evaluators"]] == ["says refund", "says days"]


def test_should_reject_two_copies_of_an_evaluator_before_any_generation_when_they_have_the_same_name(tmp_path, capsys):
    with pytest.raises(SystemExit) as exited:
        main(command(tmp_path, *evaluator_flags("HelpfulnessEvaluator", "HelpfulnessEvaluator")))

    assert exited.value.code == 2
    assert 'different "name" setting' in capsys.readouterr().err
    assert not (tmp_path / "progress.jsonl").exists()


@pytest.mark.parametrize(
    ("spec", "message"),
    [
        ("ToolCalled", "strands-evals generate: error: argument --evaluator: ToolCalled needs tool_name."),
        (
            "FailureCommunicationEvaluator",
            "strands-evals generate: error: argument --evaluator: FailureCommunicationEvaluator is a chaos evaluator.",
        ),
    ],
)
def test_should_reject_the_evaluator_before_any_generation_when_its_spec_is_invalid(tmp_path, capsys, spec, message):
    with pytest.raises(SystemExit) as exited:
        main(command(tmp_path, *evaluator_flags(spec)))

    assert exited.value.code == 2
    assert message in capsys.readouterr().err
    assert not (tmp_path / "progress.jsonl").exists()


@pytest.mark.parametrize(
    ("language", "spec", "message"),
    [
        ("typescript", "HelpfulnessEvaluator", "HelpfulnessEvaluator cannot score a TypeScript agent in strands dev"),
        ("typescript", '{"evaluator_type": "ToolCalled", "tool_name": "search"}', "only for Python agents"),
        ("python", "InteractionsEvaluator", "InteractionsEvaluator cannot score a Python agent in strands dev"),
        ("python", '{"evaluator_type": "StateEquals", "name": "cart"}', "do not record it"),
    ],
)
def test_should_reject_the_evaluator_when_a_strands_dev_run_of_the_agent_cannot_give_it_data(
    tmp_path, capsys, language, spec, message
):
    with pytest.raises(SystemExit) as exited:
        main(command(tmp_path, *evaluator_flags(spec), language=language))

    assert exited.value.code == 2
    assert message in capsys.readouterr().err
    assert not (tmp_path / "progress.jsonl").exists()


@pytest.mark.parametrize(
    ("language", "spec"),
    [
        ("typescript", "OutputEvaluator"),
        ("typescript", '{"evaluator_type": "Contains", "value": "refund"}'),
        ("python", "HelpfulnessEvaluator"),
        ("python", '{"evaluator_type": "ToolCalled", "tool_name": "search"}'),
    ],
)
def test_should_accept_the_evaluator_when_a_strands_dev_run_of_the_agent_gives_it_data(
    tmp_path, case_agent, rubric_prompts, language, spec
):
    code = main(command(tmp_path, "--num-cases", "1", *evaluator_flags(spec), language=language))

    assert code == 0
    assert len(written(tmp_path)["evaluators"]) == 1


def test_should_pass_every_generator_setting_to_the_generator_when_the_flags_are_set(tmp_path, generators):
    code = main(command(tmp_path, *GENERATOR_FLAGS))

    assert code == 0
    assert generator_settings(generators[0]) == {
        "include_expected_output": False,
        "include_expected_trajectory": True,
        "include_expected_interactions": True,
        "include_metadata": True,
        "max_parallel_num_cases": 3,
    }


def test_should_keep_the_generator_defaults_when_no_generator_flag_is_set(tmp_path, generators):
    code = main(command(tmp_path))

    assert code == 0
    assert generator_settings(generators[0]) == {
        "include_expected_output": True,
        "include_expected_trajectory": False,
        "include_expected_interactions": False,
        "include_metadata": False,
        "max_parallel_num_cases": 10,
    }


def test_should_give_the_model_to_the_generator_when_a_model_is_set(tmp_path, generators):
    code = main(command(tmp_path, "--model", "us.anthropic.claude-test"))

    assert code == 0
    assert generators[0].model == "us.anthropic.claude-test"


@pytest.mark.parametrize("value", ["0", "-2", "many"])
def test_should_reject_the_parallel_limit_when_it_is_not_a_positive_whole_number(tmp_path, capsys, value):
    with pytest.raises(SystemExit) as exited:
        main(command(tmp_path, "--max-parallel-num-cases", value))

    assert exited.value.code == 2
    assert "argument --max-parallel-num-cases" in capsys.readouterr().err


def test_should_list_every_flag_that_strands_dev_passes_when_help_runs(capsys):
    with pytest.raises(SystemExit) as exited:
        main(["--help"])

    help_text = capsys.readouterr().out
    assert exited.value.code == 0
    for flag in [
        "--context",
        "--task-description",
        "--num-cases",
        "--num-topics",
        "--evaluator",
        "--agent-language",
        "--model",
        *[flag for flag in GENERATOR_FLAGS if flag.startswith("--")],
        "--progress",
        "--output",
    ]:
        assert flag in help_text


def test_should_write_cases_with_the_requested_fields_when_schema_flags_are_set(tmp_path, case_agent):
    flags = ["--num-cases", "2", "--no-expected-output", "--expected-trajectory", "--metadata"]

    code = main(command(tmp_path, *flags))

    cases = written(tmp_path)["cases"]
    assert code == 0
    assert [case["expected_trajectory"] for case in cases] == [["lookup_order", "refund"]] * 2
    assert [case["metadata"] for case in cases] == [{"topic": "refunds"}] * 2
    assert [case.get("expected_output") for case in cases] == [None, None]
    assert events(tmp_path / "progress.jsonl")[-1]["done"] == 2


def test_should_write_a_failed_event_and_the_error_when_the_generation_raises(tmp_path, capsys, monkeypatch):
    failure = PermissionError("AccessDeniedException: no access to the model")
    monkeypatch.setattr(ExperimentGenerator, "from_context_async", AsyncMock(side_effect=failure))

    code = main(command(tmp_path))

    assert code == 3
    assert events(tmp_path / "progress.jsonl") == [
        {"event": "failed", "error": "PermissionError: AccessDeniedException: no access to the model"}
    ]
    assert capsys.readouterr().err.splitlines()[-1] == (
        "strands-evals generate: error: PermissionError: AccessDeniedException: no access to the model"
    )
    assert not (tmp_path / "experiment.json").exists()


def test_should_report_each_written_case_when_generation_runs(tmp_path, monkeypatch):
    monkeypatch.setattr(generate, "Agent", fake_case_agent())
    path = tmp_path / "progress.jsonl"
    generator, progress = progress_generator(path)

    cases = asyncio.run(generator.generate_cases_async("Write refund cases.", num_cases=3))
    progress.close()

    assert len(cases) == 3
    assert events(path) == [
        {"event": "cases", "total": 3},
        {"event": "case", "ok": True, "done": 1, "failed": 0, "total": 3},
        {"event": "case", "ok": True, "done": 2, "failed": 0, "total": 3},
        {"event": "case", "ok": True, "done": 3, "failed": 0, "total": 3},
    ]


def test_should_report_the_error_of_a_failed_case_when_the_model_call_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(generate, "Agent", fake_case_agent(RuntimeError("Too many requests,\n  please wait")))
    path = tmp_path / "progress.jsonl"
    generator, progress = progress_generator(path)

    cases = asyncio.run(generator.generate_cases_async("Write refund cases.", num_cases=2))
    progress.close()

    failed = [event for event in events(path) if event.get("ok") is False]
    assert len(cases) == 1
    assert failed == [
        {
            "event": "case",
            "ok": False,
            "done": 0,
            "failed": 1,
            "total": 2,
            "error": "RuntimeError: Too many requests, please wait",
        }
    ]
    assert events(path)[-1]["done"] + events(path)[-1]["failed"] == 2


def test_should_fail_every_queued_case_instead_of_hanging_when_the_agent_cannot_start(tmp_path, monkeypatch):
    monkeypatch.setattr(generate, "Agent", agent_that_cannot_start)
    path = tmp_path / "progress.jsonl"
    generator, progress = progress_generator(path)

    cases = asyncio.run(asyncio.wait_for(generator.generate_cases_async("Write refund cases.", num_cases=4), 5))
    progress.close()

    assert cases == []
    assert events(path)[-1] == {
        "event": "case",
        "ok": False,
        "done": 0,
        "failed": 4,
        "total": 4,
        "error": "ValueError: unknown model id",
    }


def test_should_report_topic_and_rubric_phases_when_the_context_mode_uses_them(
    tmp_path, monkeypatch, case_agent, rubric_prompts
):
    plan = TopicPlan(
        topics=[
            Topic(title="refunds", description="refund rules", key_aspects=["window"]),
            Topic(title="exchanges", description="exchange rules", key_aspects=["size"]),
        ]
    )
    monkeypatch.setattr(TopicPlanner, "plan_topics_async", AsyncMock(return_value=plan))
    path = tmp_path / "progress.jsonl"
    generator, progress = progress_generator(path)

    experiment = asyncio.run(
        generator.from_context_async(
            context=CONTEXT,
            task_description="Answer refund questions",
            num_cases=3,
            evaluator=OutputEvaluator,
            num_topics=2,
        )
    )
    progress.close()

    phases = [event["event"] for event in events(path) if event["event"] != "case"]
    assert len(experiment.cases) == 3
    assert phases == ["topics", "cases", "rubric"]
    assert events(path)[1] == {"event": "cases", "total": 3}


def test_should_cut_long_error_text_when_it_passes_the_limit():
    text = error_text(RuntimeError("x" * 900))

    assert len(text) == 500
    assert text.endswith("…")


def test_should_write_every_case_once_when_the_progress_file_cannot_be_written(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(generate, "Agent", fake_case_agent())
    generator, progress = full_disk_generator(tmp_path, monkeypatch)

    with caplog.at_level(logging.WARNING):
        cases = asyncio.run(asyncio.wait_for(generator.generate_cases_async("Write refund cases.", num_cases=3), 5))
        progress.failed(RuntimeError("late failure"))
        progress.close()

    messages = [record.getMessage() for record in caplog.records]
    assert len(cases) == 3
    assert not any("case generation failed" in message for message in messages)
    assert [message for message in messages if "progress file" in message] == [
        "error=<OSError: [Errno 28] No space left on device> | stopped writing the progress file"
    ]


def test_should_not_hang_when_neither_the_agent_nor_the_progress_file_works(tmp_path, monkeypatch):
    monkeypatch.setattr(generate, "Agent", agent_that_cannot_start)
    generator, progress = full_disk_generator(tmp_path, monkeypatch)

    cases = asyncio.run(asyncio.wait_for(generator.generate_cases_async("Write refund cases.", num_cases=4), 5))
    progress.close()

    assert cases == []


def test_should_write_valid_json_when_an_error_holds_a_lone_surrogate(tmp_path):
    path = tmp_path / "progress.jsonl"
    progress = GenerateProgress(str(path))

    progress.case_failed(RuntimeError("bad byte \udc80"))
    progress.close()

    assert events(path)[0]["error"] == "RuntimeError: bad byte \udc80"
