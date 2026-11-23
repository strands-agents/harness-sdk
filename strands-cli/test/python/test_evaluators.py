import argparse
import importlib.util
import inspect
import json
import re

import pytest
import strands_evals.evaluators as evaluators_package
import strands_evals.evaluators.chaos as chaos_package
from strands_dev_evals.evaluators import (
    EVALUATOR_CATALOG,
    EvaluatorEntry,
    EvaluatorKind,
    RunData,
    evaluator_choice,
    main,
)
from strands_evals import Case, Experiment
from strands_evals.evaluators import Evaluator

SAMPLE_SETTINGS = {
    "value": "refund",
    "tool_name": "lookup_order",
    "skill_name": "refund-policy",
    "model_cls": "strands_evals.types.evaluation.EvaluationOutput",
    "name": "cart",
    "rubric": "Score the answer.",
    "model": "us.anthropic.claude-test",
    "case_sensitive": False,
}
HAS_STICKLER = importlib.util.find_spec("stickler") is not None


def exported_evaluator_names() -> set[str]:
    exported = {
        name
        for name in evaluators_package.__all__
        if name != "Evaluator"
        and isinstance(getattr(evaluators_package, name), type)
        and issubclass(getattr(evaluators_package, name), Evaluator)
    }
    return exported | set(chaos_package.__all__)


def required_constructor_settings(evaluator: type) -> set[str]:
    parameters = list(inspect.signature(evaluator.__init__).parameters.values())[1:]
    return {parameter.name for parameter in parameters if parameter.default is inspect.Parameter.empty}


def storable(entry: EvaluatorEntry) -> bool:
    return entry.kind is not EvaluatorKind.CHAOS and entry.reads is not RunData.DECISION_MODEL


def storable_param(entry: EvaluatorEntry):
    needs_stickler = entry.reads is RunData.STRUCTURED_OUTPUT and not HAS_STICKLER
    marks = [pytest.mark.skip(reason="StructuredOutputSimilarity needs the stickler extra")] if needs_stickler else []
    return pytest.param(entry, id=entry.name, marks=marks)


def listed_catalog(capsys) -> list[dict]:
    assert main([]) == 0
    return json.loads(capsys.readouterr().out)


def test_should_list_every_exported_evaluator_when_the_catalog_is_built():
    assert {entry.name for entry in EVALUATOR_CATALOG} == exported_evaluator_names()


def test_should_list_each_evaluator_once_when_the_catalog_is_built():
    names = [entry.name for entry in EVALUATOR_CATALOG]

    assert len(names) == len(set(names))


@pytest.mark.parametrize("entry", EVALUATOR_CATALOG, ids=lambda entry: entry.name)
def test_should_name_only_constructor_parameters_when_an_entry_lists_settings(entry):
    parameters = set(inspect.signature(entry.evaluator.__init__).parameters)

    assert {setting.name for setting in entry.settings} <= parameters


@pytest.mark.parametrize("entry", EVALUATOR_CATALOG, ids=lambda entry: entry.name)
def test_should_mark_every_constructor_argument_without_a_default_as_required_when_generate_cannot_write_it(entry):
    written = {"rubric"} if entry.kind is EvaluatorKind.RUBRIC else set()

    assert set(entry.required_settings) == required_constructor_settings(entry.evaluator) - written


@pytest.mark.parametrize("entry", [storable_param(entry) for entry in EVALUATOR_CATALOG if storable(entry)])
def test_should_load_the_evaluator_with_every_setting_from_an_experiment_file_when_generate_accepts_it(entry):
    settings = {setting.name: SAMPLE_SETTINGS[setting.name] for setting in entry.settings}
    choice = evaluator_choice(json.dumps({"evaluator_type": entry.name, **settings}))
    written = Experiment(cases=[Case[str, str](name="c0", input="q0")], evaluators=[choice.build()])

    loaded = Experiment.from_dict(json.loads(json.dumps(written.to_dict())))

    assert [type(evaluator) for evaluator in loaded.evaluators] == [entry.evaluator]
    assert loaded.evaluators[0].get_name() == "cart"


@pytest.mark.parametrize(
    "entry",
    [entry for entry in EVALUATOR_CATALOG if entry.kind is EvaluatorKind.CHAOS],
    ids=lambda entry: entry.name,
)
def test_should_refuse_a_chaos_evaluator_when_an_experiment_file_cannot_load_it(entry):
    stored = {"cases": [], "evaluators": [entry.evaluator().to_dict()]}

    with pytest.raises(Exception, match="Cannot find"):
        Experiment.from_dict(stored)
    with pytest.raises(argparse.ArgumentTypeError, match="chaos evaluator"):
        evaluator_choice(entry.name)


@pytest.mark.parametrize(
    "entry",
    [entry for entry in EVALUATOR_CATALOG if entry.reads is RunData.DECISION_MODEL],
    ids=lambda entry: entry.name,
)
def test_should_refuse_an_evaluator_when_an_experiment_file_cannot_store_its_decision_model(entry):
    with pytest.raises(argparse.ArgumentTypeError, match="needs a decision model object"):
        evaluator_choice(entry.name)


@pytest.mark.parametrize(
    ("spec", "message"),
    [
        ("Helpfulness", "Helpfulness is not a strands-evals evaluator"),
        ("FailureCommunicationEvaluator", "is a chaos evaluator"),
        ("ToolCalled", 'ToolCalled needs tool_name. Pass it as JSON: {"evaluator_type": "ToolCalled"'),
        ('{"evaluator_type": "Contains", "value": "x", "tool": "y"}', "Contains does not take tool"),
        ('{"evaluator_type": "Contains", "value": "x", "case_sensitive": "no"}', "case_sensitive must be a boolean"),
        ('{"evaluator_type": "ToolCalled", "tool_name": 3}', "tool_name must be a string"),
        ('{"evaluator_type": "Equals", "value": 42}', "value must be a string"),
        (
            '{"evaluator_type": "HelpfulnessEvaluator", "version": "v9"}',
            "HelpfulnessEvaluator rejected its settings: KeyError",
        ),
        ('{"tool_name": "search"}', 'an "evaluator_type" name'),
        ("{not json", "the evaluator JSON is not valid"),
    ],
)
def test_should_reject_the_evaluator_when_its_spec_is_invalid(spec, message):
    with pytest.raises(argparse.ArgumentTypeError, match=re.escape(message)):
        evaluator_choice(spec)


def test_should_keep_the_settings_and_the_label_when_the_spec_is_json():
    choice = evaluator_choice('{"evaluator_type": "Contains", "value": "refund", "name": "says refund"}')

    assert (choice.entry.name, dict(choice.settings), choice.label) == (
        "Contains",
        {"value": "refund", "name": "says refund"},
        "says refund",
    )


def test_should_print_every_evaluator_as_json_when_the_catalog_command_runs(capsys):
    listed = listed_catalog(capsys)

    assert [item["name"] for item in listed] == [entry.name for entry in EVALUATOR_CATALOG]
    assert all(item["description"] and item["kind"] and item["reads"] for item in listed)


@pytest.mark.parametrize(
    ("name", "agents", "limit"),
    [
        ("OutputEvaluator", ["python", "typescript"], None),
        ("HelpfulnessEvaluator", ["python"], "only for Python agents"),
        ("ToolCalled", ["python"], "only for Python agents"),
        ("InteractionsEvaluator", [], "do not record them"),
        ("StateEquals", [], "do not record it"),
        ("RecoveryStrategyEvaluator", [], "chaos experiment"),
        ("MultimodalCorrectnessEvaluator", [], "strands dev cases carry text only"),
        ("MultimodalOutputEvaluator", ["python", "typescript"], None),
        ("TypedRubricEvaluator", [], "decision model object"),
        ("Cascade", [], "decision model object"),
    ],
)
def test_should_say_which_strands_dev_agents_an_evaluator_can_score_when_the_catalog_command_runs(
    capsys, name, agents, limit
):
    item = next(item for item in listed_catalog(capsys) if item["name"] == name)

    assert item["agents"] == agents
    assert (limit is None and "limit" not in item) or limit in item["limit"]


def test_should_give_the_type_of_each_setting_when_the_catalog_command_runs(capsys):
    contains = next(item for item in listed_catalog(capsys) if item["name"] == "Contains")

    assert {setting["name"]: (setting["type"], setting["required"]) for setting in contains["settings"]} == {
        "value": ("string", True),
        "case_sensitive": ("boolean", False),
        "name": ("string", False),
    }


def test_should_use_only_kinds_and_setting_types_that_strands_dev_reads_when_the_catalog_command_runs(capsys):
    listed = listed_catalog(capsys)

    assert {item["kind"] for item in listed} <= {"rubric", "judge", "multimodal", "check", "chaos"}
    assert {setting["type"] for item in listed for setting in item["settings"]} <= {"string", "boolean", "any"}
