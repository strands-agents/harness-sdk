import json
import shutil
import sys
import types
from pathlib import Path

import pytest
import strands_evals.optimization as optimization
import strands_evals.optimization.search.blocks as search_blocks
from dev_evals_support import (
    DIRECT_HARNESS,
    FakeHarness,
    SeesTrace,
    baseline_scores,
    baseline_values,
    config_of,
    forget_entry_modules,
    optimize,
    proposed_values,
    run_dir,
    space_of,
    write_experiment,
    write_harness,
    write_optimize_entry,
)
from strands_dev_evals.harness import load_python_harness
from strands_dev_evals.model_effort import ModelEffort
from strands_evals.cli import _optimize as cli_optimize
from strands_evals.cli.main import main
from strands_evals.evaluators.deterministic import Contains, Equals
from strands_evals.optimization import Patch, Proposer

FACTORY_HARNESS = """
from strands_harness import create_harness


def create_agent(**overrides):
    return create_harness(instructions="Answer briefly.", **overrides)


agent = create_agent()
"""

CLAUDE_ON_BEDROCK = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
CONTEXT_BETA = {"anthropic_beta": ["context-1m-2025-08-07"]}


def thinking(budget: int) -> dict:
    return {"thinking": {"type": "enabled", "budget_tokens": budget}}


BEDROCK_FIELDS = {
    "off": {},
    "low": thinking(2048),
    "medium": thinking(8192),
    "high": thinking(16384),
    "xhigh": thinking(32768),
    "max": thinking(49152),
}


def bedrock_harness(**model_config) -> str:
    return (
        "from strands.models import BedrockModel\n"
        "from strands_harness import create_harness\n"
        f"agent = create_harness(model=BedrockModel(**{model_config!r}), instructions='Answer briefly.')\n"
    )


SPACE_HARNESS = """
from strands_harness import create_harness


def lookup(query):
    return query


class Search:
    tool_name = "search"


agent = create_harness(
    model="bedrock/a",
    instructions="Answer briefly.",
    caching="auto",
    max_tokens=100,
    builtin_tools=["files", "shell", "web"],
    tools=[lookup, Search()],
    mcp_servers={"local": {"command": "local"}, "github": {"command": "gh"}},
)
"""

SPACE = [
    {
        "key": "instructions",
        "kind": "text",
        "option": "instructions",
        "default": "Answer briefly.",
        "about": "the agent's instructions",
    },
    {"key": "model", "kind": "choice", "option": "model", "values": ["bedrock/a", "bedrock/b"], "default": "bedrock/a"},
    {"key": "caching", "kind": "choice", "option": "caching", "values": ["auto", True, False], "default": "auto"},
    {"key": "builtinTools_0", "kind": "switch", "option": "builtin_tools", "item": {"index": 0}, "default": True},
    {"key": "mcpServers_1", "kind": "switch", "option": "mcp_servers", "item": {"key": "github"}, "default": True},
]


class FakeReflection(Proposer):
    kinds = frozenset({"text"})
    models: list = []

    def __init__(self, model=None):
        FakeReflection.models.append(model)

    async def propose(self, request):
        return [
            Patch(
                updates={key: f"{request.parent.values[key]} Be exact.".strip() for key in request.keys},
                rationale="ask for the exact answer",
            )
        ]

    def observe(self, observation):
        pass


@pytest.fixture(autouse=True)
def fake_reflection(monkeypatch):
    FakeReflection.models = []
    monkeypatch.setattr(optimization, "Reflection", FakeReflection)
    monkeypatch.setattr(search_blocks, "Reflection", FakeReflection)
    monkeypatch.setattr(cli_optimize, "Reflection", FakeReflection)
    return FakeReflection


@pytest.fixture
def harness_models(monkeypatch):
    models = pytest.importorskip("strands_harness.models")
    monkeypatch.setitem(sys.modules, "strands_harness.models", models)
    return models


@pytest.fixture
def model_harness(harness_models, monkeypatch):
    fake = FakeHarness()
    monkeypatch.setitem(sys.modules, "strands_harness", fake)
    monkeypatch.setattr(sys, "path", list(sys.path))
    return fake


@pytest.fixture
def fresh_modules():
    yield
    for name in [name for name in sys.modules if name == "desk" or name.startswith("desk.")]:
        del sys.modules[name]


def optimize_harness(tmp_path: Path, source: str, *flags: str, cases: int = 4, evaluators=None) -> int:
    experiment = write_experiment(tmp_path, cases=cases, evaluators=evaluators)
    agent = write_harness(tmp_path, source)
    return optimize(str(experiment), "--agent", str(agent), "--record", str(tmp_path / "record"), *flags)


def load_harness(tmp_path: Path, source: str):
    return load_python_harness(str(write_harness(tmp_path, source)))


def write_space(directory: Path, document) -> Path:
    path = directory / "space.json"
    path.write_text(document if isinstance(document, str) else json.dumps({"variables": document}))
    return path


def optimize_space(tmp_path: Path, document, *flags: str, source: str = SPACE_HARNESS) -> int:
    space = write_space(tmp_path, document)
    return optimize_harness(tmp_path, source, "--space", str(space), "--iterations", "0", *flags)


def test_should_tune_effort_over_the_levels_the_model_accepts_when_given_a_harness_file(harness, tmp_path, capsys):
    code = optimize_harness(tmp_path, DIRECT_HARNESS, "--tune", "effort", "--iterations", "1", "--json")

    assert code == 0
    assert json.loads(capsys.readouterr().out)["baseline_id"]
    effort = space_of(tmp_path)["effort"]
    assert (effort["kind"], effort["default"]) == ("one_of", "low")
    assert {"low", "high"} <= set(effort["options"])
    assert not {"max", "auto"} & set(effort["options"])


def test_should_ship_a_better_effort_and_write_its_values_when_the_search_finds_one(harness, tmp_path, capsys):
    code = optimize_harness(tmp_path, DIRECT_HARNESS, "--tune", "effort", "--iterations", "2", "--json", cases=8)

    assert code == 0
    result = json.loads(capsys.readouterr().out)
    assert result["candidates"][result["validation"]["champion_id"]]["values"] == {"effort": "high"}
    assert json.loads((run_dir(tmp_path) / "best.values.json").read_text()) == {"effort": {"old": "low", "new": "high"}}
    assert (run_dir(tmp_path) / "result.json").is_file()


def test_should_build_quiet_trial_agents_without_session_or_memory_when_given_a_harness_file(harness, tmp_path):
    code = optimize_harness(tmp_path, DIRECT_HARNESS, "--tune", "effort", "--iterations", "1", "--json")

    assert code == 0
    trial_calls = harness.calls[1:]
    assert trial_calls
    assert all(call["session"] is False and call["memory"] is False for call in trial_calls)
    assert all(call["callback_handler"] is None for call in trial_calls)
    assert all(call["model"] == "bedrock/test" for call in trial_calls)
    assert all(call["instructions"] == "Answer briefly." for call in trial_calls)


def test_should_start_from_the_file_instructions_when_tuning_instructions(harness, tmp_path):
    code = optimize_harness(tmp_path, DIRECT_HARNESS, "--iterations", "0", "--json")

    assert code == 0
    assert list(space_of(tmp_path)) == ["instructions"]
    assert space_of(tmp_path)["instructions"]["kind"] == "text"
    assert baseline_values(tmp_path) == {"instructions": "Answer briefly."}


def test_should_rewrite_the_instructions_when_the_search_runs(harness, tmp_path, fake_reflection):
    code = optimize_harness(tmp_path, DIRECT_HARNESS, "--iterations", "1", "--json")

    assert code == 0
    assert {"instructions": "Answer briefly. Be exact."} in proposed_values(tmp_path)
    assert fake_reflection.models == [None]


def test_should_build_agents_without_instructions_when_the_file_has_none(harness, tmp_path):
    source = "from strands_harness import create_harness\nagent = create_harness(model='bedrock/test')\n"

    code = optimize_harness(tmp_path, source, "--iterations", "0", "--json")

    assert code == 0
    assert baseline_values(tmp_path) == {"instructions": ""}
    assert all(call["instructions"] is None for call in harness.calls[1:])


def test_should_pass_tuned_settings_to_create_agent_when_the_file_defines_it(harness, tmp_path):
    code = optimize_harness(tmp_path, FACTORY_HARNESS, "--tune", "effort", "--iterations", "1", "--json")

    assert code == 0
    measured = {values["effort"] for values in proposed_values(tmp_path)}
    built = {call.get("effort") for call in harness.calls[1:]}
    assert measured <= built
    assert all(call["instructions"] == "Answer briefly." for call in harness.calls)


def test_should_import_the_file_as_a_package_module_when_it_uses_relative_imports(
    harness, fresh_modules, tmp_path, monkeypatch
):
    monkeypatch.chdir(tmp_path)
    write_harness(tmp_path, "", "desk/__init__.py")
    write_harness(tmp_path, "INSTRUCTIONS = 'Answer from the desk.'\n", "desk/prompts.py")
    agent = write_harness(
        tmp_path,
        "from strands_harness import create_harness\n"
        "from .prompts import INSTRUCTIONS\n"
        "agent = create_harness(model='bedrock/test', instructions=INSTRUCTIONS)\n",
        "desk/agent.py",
    )
    experiment = write_experiment(tmp_path)

    code = optimize(str(experiment), "--agent", str(agent), "--record", "record", "--iterations", "0", "--json")

    assert code == 0
    assert baseline_values(tmp_path) == {"instructions": "Answer from the desk."}


def test_should_test_the_pick_on_held_out_cases_when_the_split_is_default(harness, tmp_path, capsys):
    code = optimize_harness(tmp_path, DIRECT_HARNESS, "--tune", "effort", "--iterations", "1", "--json", cases=8)

    assert code == 0
    assert json.loads(capsys.readouterr().out)["test"] is not None
    assert config_of(tmp_path)["split"]["train"] == 0.5


def test_should_write_json_when_stdout_is_not_a_terminal(harness, tmp_path, capsys):
    code = optimize_harness(tmp_path, DIRECT_HARNESS, "--tune", "effort", "--iterations", "0")

    assert code == 0
    assert json.loads(capsys.readouterr().out)["run_dir"] == str(run_dir(tmp_path))


def test_should_print_a_summary_when_the_output_is_rich(harness, tmp_path, capsys):
    code = optimize_harness(tmp_path, DIRECT_HARNESS, "--tune", "effort", "--iterations", "1", "--rich")

    assert code == 0
    captured = capsys.readouterr()
    assert captured.out.startswith(f"Run {run_dir(tmp_path).name}")
    assert f"run folder {run_dir(tmp_path)}" in captured.err


def test_should_maximize_every_evaluator_when_no_metric_is_given(harness, tmp_path):
    evaluators = [Contains(value="effort high"), Equals(value="effort high")]

    code = optimize_harness(tmp_path, DIRECT_HARNESS, "--tune", "effort", "--iterations", "0", evaluators=evaluators)

    assert code == 0
    assert config_of(tmp_path)["objective"] == "WeightedSum(Maximize(Contains), Maximize(Equals))"


def test_should_use_the_given_goals_when_maximize_and_at_most_are_given(harness, tmp_path):
    evaluators = [Contains(value="effort high"), Equals(value="effort high")]

    code = optimize_harness(
        tmp_path,
        DIRECT_HARNESS,
        "--tune",
        "effort",
        "--maximize",
        "Equals",
        "--at-most",
        "tokens=500",
        "--iterations",
        "0",
        evaluators=evaluators,
    )

    assert code == 0
    config = config_of(tmp_path)
    assert config["objective"] == "Maximize(Equals)"
    assert config["constraints"] == ["tokens <= 500"]


def test_should_keep_every_constraint_in_order_when_at_least_and_at_most_are_given(harness, tmp_path):
    evaluators = [Contains(value="effort high"), Equals(value="effort high")]

    code = optimize_harness(
        tmp_path,
        DIRECT_HARNESS,
        "--tune",
        "effort",
        "--objective",
        "minimize:tokens",
        "--at-least",
        "Contains=0.8",
        "--at-most",
        "seconds=30",
        "--iterations",
        "0",
        evaluators=evaluators,
    )

    assert code == 0
    config = config_of(tmp_path)
    assert config["objective"] == "Minimize(tokens)"
    assert config["constraints"] == ["Contains >= 0.8", "seconds <= 30"]


def test_should_rewrite_instructions_with_the_given_model_when_rewriter_model_is_given(
    harness, tmp_path, fake_reflection
):
    code = optimize_harness(tmp_path, DIRECT_HARNESS, "--rewriter-model", "rewriter-x", "--iterations", "1")

    assert code == 0
    assert fake_reflection.models == ["rewriter-x"]
    blocks = config_of(tmp_path)["search"]["blocks"]
    assert [block["keys"] for block in blocks if block["proposer"] == "FakeReflection"] == [["instructions"]]


def test_should_refuse_the_rewriter_model_when_no_setting_is_text(harness, tmp_path, capsys, fake_reflection):
    code = optimize_harness(
        tmp_path, DIRECT_HARNESS, "--tune", "effort", "--rewriter-model", "rewriter-x", "--iterations", "1"
    )

    assert code == 2
    assert "nothing tuned is text" in capsys.readouterr().err
    assert fake_reflection.models == []


def test_should_exit_with_a_runtime_error_when_every_baseline_trial_fails(harness, tmp_path, capsys):
    source = """
    from strands_harness import create_harness


    def create_agent(**overrides):
        if overrides:
            raise RuntimeError("the agent cannot be built")
        return create_harness(instructions="Answer briefly.")


    agent = create_agent()
    """

    code = optimize_harness(tmp_path, source, "--iterations", "0")

    assert code == 3
    error = capsys.readouterr().err
    assert "the agent cannot be built" in error


@pytest.mark.parametrize(
    ("split", "message"),
    [
        ("0.1,0.45,0.45", "at least 1 is needed"),
        ("0.5,0.5,0.5", "sum"),
        ("0,0.5,0.5", "above 0"),
    ],
)
def test_should_name_the_split_problem_when_its_shares_do_not_work(harness, tmp_path, capsys, split, message):
    code = optimize_harness(tmp_path, DIRECT_HARNESS, "--tune", "effort", "--iterations", "0", "--split", split)

    assert code == 2
    assert message in capsys.readouterr().err


def test_should_name_the_budget_problem_when_the_baseline_and_the_end_phase_do_not_fit(harness, tmp_path, capsys):
    code = optimize_harness(tmp_path, DIRECT_HARNESS, "--tune", "effort", "--max-rollouts", "3")

    assert code == 2
    assert "can't cover the baseline" in capsys.readouterr().err


def test_should_point_to_strands_dev_when_the_agent_file_fails_to_import(
    harness, fresh_modules, tmp_path, monkeypatch, capsys
):
    monkeypatch.chdir(tmp_path)
    write_harness(tmp_path, "", "desk/__init__.py")
    agent = write_harness(tmp_path, "raise RuntimeError('the agent is broken')\n", "desk/agent.py")
    experiment = write_experiment(tmp_path)

    code = optimize(str(experiment), "--agent", str(agent), "--record", "record", "--tune", "effort")

    assert code == 2
    error = capsys.readouterr().err
    assert "the agent is broken" in error
    assert "strands dev shows the same error when it opens this agent" in error


@pytest.mark.parametrize(
    ("source", "tune", "message"),
    [
        (
            "from strands_harness import create_harness\nhelper = create_harness()\n",
            "effort",
            "Export one, for example agent = create_harness(...)",
        ),
        (
            "from strands_harness import create_harness\nbuilt = create_harness()\nagent = built\n",
            "effort",
            "changes its agent after create_harness",
        ),
        (
            "from strands_harness import create_harness\nfrom scripted_model import ScriptedModel\n"
            "agent = create_harness(model=ScriptedModel(['x']))\n",
            "effort",
            "effort cannot be tuned: the agent's model is a ScriptedModel object, and strands dev can set effort "
            "only on BedrockModel, AnthropicModel, and OpenAIResponsesModel objects. Tune instructions instead "
            "(the default).",
        ),
        (
            "from strands.models import BedrockModel\n"
            "from strands_harness import create_harness\n"
            "agent = create_harness(model=BedrockModel(model_id=None))\n",
            "effort",
            "effort cannot be tuned: the agent's BedrockModel has no model id, so strands dev cannot look up its "
            "reasoning settings. Tune instructions instead (the default).",
        ),
        (
            "from strands import Agent\nfrom scripted_model import ScriptedModel\n"
            "agent = Agent(model=ScriptedModel(['x']), callback_handler=None)\n",
            "instructions",
            "Build the agent with create_harness(...)",
        ),
        (
            "from strands_harness import create_harness\nagent = create_harness(session_manager=object())\n",
            "effort",
            "session_manager",
        ),
        (
            "from strands_harness import create_harness\nagent = create_harness(system_prompt='You are terse.')\n",
            "instructions",
            "Move that text into instructions",
        ),
        (
            "from strands_harness import create_harness\n"
            "async def create_agent(**overrides):\n"
            "    return create_harness(**overrides)\n"
            "agent = create_harness()\n",
            "effort",
            "Change it to def create_agent(**overrides)",
        ),
        (
            "from strands_harness import create_harness\nagent = create_harness(model='bedrock/nolevels')\n",
            "effort",
            "Tune instructions instead",
        ),
    ],
)
def test_should_reject_the_harness_file_when_it_cannot_build_fresh_agents(
    harness, tmp_path, capsys, source, tune, message
):
    code = optimize_harness(tmp_path, source, "--tune", tune)

    assert code == 2
    assert message in capsys.readouterr().err


def test_should_score_with_the_trace_of_each_trial_when_a_python_agent_meets_a_trace_evaluator(harness, tmp_path):
    code = optimize_harness(
        tmp_path,
        DIRECT_HARNESS,
        "--custom-evaluator",
        "dev_evals_support:SeesTrace",
        "--iterations",
        "0",
        evaluators=[SeesTrace()],
    )

    assert code == 0
    assert baseline_scores(tmp_path)
    assert set(baseline_scores(tmp_path)) == {1.0}


def test_should_score_the_answer_without_its_trailing_newline_when_a_trial_runs(harness, tmp_path):
    code = optimize_harness(
        tmp_path, DIRECT_HARNESS, "--tune", "effort", "--iterations", "0", evaluators=[Equals(value="effort low")]
    )

    assert code == 0
    assert baseline_scores(tmp_path)
    assert set(baseline_scores(tmp_path)) == {1.0}


def test_should_record_each_variable_under_its_key_when_given_a_space_file(harness, tmp_path):
    code = optimize_space(tmp_path, SPACE)

    assert code == 0
    space = space_of(tmp_path)
    assert {key: info["kind"] for key, info in space.items()} == {
        "instructions": "text",
        "model": "one_of",
        "caching": "one_of",
        "builtinTools_0": "one_of",
        "mcpServers_1": "one_of",
    }
    assert (space["instructions"]["edit_instructions"]["length"], space["instructions"]["size_cap"]) == (
        len("the agent's instructions"),
        8000,
    )
    assert space["caching"]["options"] == ["auto", True, False]
    assert (space["builtinTools_0"]["options"], space["builtinTools_0"]["default"]) == ([True, False], True)
    assert baseline_values(tmp_path) == {
        "instructions": "Answer briefly.",
        "model": "bedrock/a",
        "caching": "auto",
        "builtinTools_0": True,
        "mcpServers_1": True,
    }


def test_should_set_each_option_the_space_names_when_a_trial_is_built(harness, tmp_path):
    space = [
        {"key": "brief", "kind": "text", "option": "instructions", "default": "Answer in one line."},
        {
            "key": "chosen_model",
            "kind": "choice",
            "option": "model",
            "values": ["bedrock/a", "bedrock/b"],
            "default": "bedrock/b",
        },
        {"key": "tokens", "kind": "choice", "option": "max_tokens", "values": [100, 200], "default": 200},
    ]

    code = optimize_space(tmp_path, space)

    assert code == 0
    trial_calls = harness.calls[1:]
    assert trial_calls
    assert {(call["instructions"], call["model"], call["max_tokens"]) for call in trial_calls} == {
        ("Answer in one line.", "bedrock/b", 200)
    }
    assert all(call["builtin_tools"] == ["files", "shell", "web"] for call in trial_calls)
    assert all(call["session"] is False and call["callback_handler"] is None for call in trial_calls)


def test_should_leave_out_each_item_whose_switch_is_off_when_a_trial_is_built(harness, tmp_path):
    space = [
        {"key": "shell_tool", "kind": "switch", "option": "builtin_tools", "item": {"index": 1}, "default": False},
        {"key": "web_tool", "kind": "switch", "option": "builtin_tools", "item": {"name": "web"}, "default": False},
        {"key": "lookup_tool", "kind": "switch", "option": "tools", "item": {"name": "lookup"}, "default": False},
        {"key": "search_tool", "kind": "switch", "option": "tools", "item": {"name": "search"}, "default": True},
        {"key": "github", "kind": "switch", "option": "mcp_servers", "item": {"key": "github"}, "default": False},
    ]

    code = optimize_space(tmp_path, space)

    assert code == 0
    trial_calls = harness.calls[1:]
    assert trial_calls
    assert all(call["builtin_tools"] == ["files"] for call in trial_calls)
    assert all([tool.tool_name for tool in call["tools"]] == ["search"] for call in trial_calls)
    assert all(call["mcp_servers"] == {"local": {"command": "local"}} for call in trial_calls)
    assert harness.calls[0]["builtin_tools"] == ["files", "shell", "web"]


def test_should_start_from_the_harness_default_when_a_switched_option_is_left_out_of_the_agent(harness, tmp_path):
    source = 'from strands_harness import create_harness\n\nagent = create_harness(model="bedrock/a")\n'
    space = [
        {"key": "plugin", "kind": "switch", "option": "builtin_plugins", "item": {"name": "todos"}, "default": False},
        {"key": "shell", "kind": "switch", "option": "builtin_tools", "item": {"name": "shell"}, "default": False},
    ]

    code = optimize_space(tmp_path, space, source=source)

    assert code == 0
    trial_calls = harness.calls[1:]
    assert trial_calls
    assert all(call["builtin_plugins"] == ["environment"] for call in trial_calls)
    assert all(call["builtin_tools"] == {"shell": False} for call in trial_calls)
    assert "builtin_tools" not in harness.calls[0]


@pytest.mark.parametrize(
    ("variable", "default", "instructions"),
    [
        ({"key": "brief", "kind": "text", "option": "instructions"}, "Answer briefly.", "Answer briefly."),
        ({"key": "brief", "kind": "text", "option": "instructions", "default": ""}, "", None),
        ({"key": "label", "kind": "text", "option": "label"}, "", "Answer briefly."),
    ],
)
def test_should_start_a_text_variable_from_its_default_or_the_agent_value_when_given_a_space_file(
    harness, tmp_path, variable, default, instructions
):
    code = optimize_space(tmp_path, [variable])

    assert code == 0
    assert baseline_values(tmp_path) == {variable["key"]: default}
    assert {call["instructions"] for call in harness.calls[1:]} == {instructions}


def test_should_rewrite_every_text_variable_when_a_space_file_and_a_rewriter_model_are_given(harness, tmp_path):
    space = [
        {"key": "brief", "kind": "text", "option": "instructions"},
        {"key": "label", "kind": "text", "option": "label", "default": "desk agent"},
        {
            "key": "chosen_model",
            "kind": "choice",
            "option": "model",
            "values": ["bedrock/a", "bedrock/b"],
            "default": "bedrock/a",
        },
    ]

    code = optimize_space(tmp_path, space, "--rewriter-model", "rewriter-x", "--iterations", "1")

    assert code == 0
    blocks = config_of(tmp_path)["search"]["blocks"]
    assert [block["keys"] for block in blocks if block["proposer"] == "FakeReflection"] == [["brief", "label"]]


@pytest.mark.parametrize(
    ("document", "message"),
    [
        ("{not json", "is not a usable space file: it cannot be read as JSON"),
        ('{"variables": {}}', 'it must be a JSON object with a "variables" list'),
        (
            [{"key": "1model", "kind": "text", "option": "model"}],
            'variable 1 has the key "1model", but a key must match',
        ),
        ([{"key": "model.id", "kind": "text", "option": "model"}], 'variable 1 has the key "model.id"'),
        (
            [
                {"key": "brief", "kind": "text", "option": "instructions"},
                {"key": "brief", "kind": "text", "option": "label"},
            ],
            "two variables have the key brief",
        ),
        ([{"key": "brief", "kind": "slider", "option": "instructions"}], "a kind is text, choice or switch"),
        ([{"key": "brief", "kind": "text"}], "variable brief needs an option"),
        ([{"key": "brief", "kind": "text", "option": "instructions", "default": 3}], "text brief needs a default"),
        ([{"key": "m", "kind": "choice", "option": "model", "values": ["a", "a"], "default": "a"}], "at least two"),
        ([{"key": "m", "kind": "choice", "option": "model", "values": [0, 1], "default": False}], "a default that"),
        ([{"key": "m", "kind": "choice", "option": "model", "values": ["a", "b"], "default": "c"}], "a default that"),
        ([{"key": "m", "kind": "choice", "option": "model", "values": ["a", ["b"]], "default": "a"}], "a list of"),
        ([{"key": "s", "kind": "switch", "option": "tools", "item": {"index": 0}, "default": "yes"}], "true or false"),
        ([{"key": "s", "kind": "switch", "option": "tools", "item": {"index": -1}, "default": True}], "needs an item"),
        (
            [{"key": "s", "kind": "switch", "option": "tools", "item": {"index": True}, "default": True}],
            "needs an item",
        ),
        (
            [{"key": "s", "kind": "switch", "option": "tools", "item": {"index": 0, "name": "x"}, "default": True}],
            "needs an item",
        ),
        (
            [
                {"key": "a", "kind": "choice", "option": "model", "values": ["a", "b"], "default": "a"},
                {"key": "b", "kind": "text", "option": "model"},
            ],
            "variables a and b both change model",
        ),
        (
            [
                {"key": "a", "kind": "switch", "option": "tools", "item": {"index": 0}, "default": True},
                {"key": "b", "kind": "choice", "option": "tools", "values": [1, 2], "default": 1},
            ],
            "variables a and b both change tools",
        ),
    ],
)
def test_should_name_the_problem_before_loading_the_agent_when_the_space_file_is_not_usable(
    harness, tmp_path, capsys, document, message
):
    code = optimize_space(tmp_path, document)

    assert code == 2
    error = capsys.readouterr().err
    assert message in error
    assert "Fix the file, then try again." in error
    assert harness.calls == []


@pytest.mark.parametrize(
    ("variable", "message"),
    [
        (
            {"key": "s", "kind": "switch", "option": "skills", "item": {"name": "x"}, "default": True},
            'variable s cannot leave out {"name": "x"} of skills: the harness default skills is a bool, not a list',
        ),
        (
            {"key": "s", "kind": "switch", "option": "interventions", "item": {"name": "x"}, "default": True},
            "the agent passes no interventions, and the harness has none by default",
        ),
        (
            {"key": "s", "kind": "switch", "option": "builtin_plugins", "item": {"name": "x"}, "default": True},
            "the harness default builtin_plugins has no such item",
        ),
        (
            {"key": "s", "kind": "switch", "option": "mcp_servers", "item": {"index": 0}, "default": True},
            "the agent's mcp_servers is a dict, not a list",
        ),
        (
            {"key": "s", "kind": "switch", "option": "builtin_tools", "item": {"key": "shell"}, "default": True},
            "the agent's builtin_tools is a list, not a dict",
        ),
        (
            {"key": "s", "kind": "switch", "option": "builtin_tools", "item": {"index": 3}, "default": True},
            "the agent's builtin_tools has no such item",
        ),
        (
            {"key": "s", "kind": "switch", "option": "tools", "item": {"name": "fetch"}, "default": True},
            "the agent's tools has no such item",
        ),
        (
            {"key": "s", "kind": "switch", "option": "mcp_servers", "item": {"key": "slack"}, "default": True},
            "the agent's mcp_servers has no such item",
        ),
        (
            {"key": "tokens", "kind": "text", "option": "max_tokens"},
            "the space variable tokens is text, but the agent's max_tokens is not text (int)",
        ),
    ],
)
def test_should_stop_before_the_first_rollout_when_the_space_does_not_match_the_agent(
    harness, tmp_path, capsys, variable, message
):
    code = optimize_space(tmp_path, [variable])

    assert code == 2
    assert message in capsys.readouterr().err
    assert len(harness.calls) == 1


def test_should_refuse_to_tune_instructions_from_a_space_file_when_the_agent_passes_a_system_prompt(
    harness, tmp_path, capsys
):
    source = "from strands_harness import create_harness\nagent = create_harness(system_prompt='You are terse.')\n"
    space = [{"key": "brief", "kind": "text", "option": "instructions", "default": "Answer briefly."}]

    code = optimize_space(tmp_path, space, source=source)

    assert code == 2
    assert "instructions cannot be tuned: the agent passes a full system prompt" in capsys.readouterr().err
    assert len(harness.calls) == 1


def resume(target: Path, *flags: str) -> int:
    runs = (
        [target]
        if (target / "run.json").is_file()
        else sorted(path for path in target.iterdir() if (path / "run.json").is_file())
    )
    forget_entry_modules()
    return main(["optimize", "resume", str(runs[0] if runs else target), *flags])


def stop_after_the_first_step(run: Path, copy: Path) -> Path:
    lines = (run / "events.jsonl").read_text().splitlines()
    first_end = [json.loads(line)["event"] for line in lines].index("iteration_end")
    shutil.copytree(run, copy)
    (copy / "events.jsonl").write_text("\n".join(lines[: first_end + 1]) + "\n")
    for finished in ("result.json", "best.values.json", "best.diff"):
        (copy / finished).unlink(missing_ok=True)
    return copy


def trial_count(events_file: Path) -> int:
    return sum(json.loads(line)["event"] == "trial" for line in events_file.read_text().splitlines())


def test_should_continue_a_stopped_run_to_the_same_result_when_resume_is_given(harness, tmp_path, capsys):
    flags = ("--tune", "effort", "--iterations", "2", "--json")
    assert optimize_harness(tmp_path, DIRECT_HARNESS, *flags, cases=8) == 0
    finished = json.loads(capsys.readouterr().out)
    stopped = stop_after_the_first_step(run_dir(tmp_path), tmp_path / "stopped" / run_dir(tmp_path).name)

    code = resume(stopped, "--json")

    assert code == 0
    resumed = json.loads(capsys.readouterr().out)
    assert resumed["validation"]["champion_id"] == finished["validation"]["champion_id"]
    assert resumed["rollouts_spent"] == finished["rollouts_spent"]
    assert "resume" in [json.loads(line)["event"] for line in (stopped / "events.jsonl").read_text().splitlines()]


def test_should_return_the_result_without_new_trials_when_the_resumed_run_had_finished(harness, tmp_path, capsys):
    flags = ("--tune", "effort", "--iterations", "1", "--json")
    assert optimize_harness(tmp_path, DIRECT_HARNESS, *flags) == 0
    finished = json.loads(capsys.readouterr().out)
    trials = trial_count(run_dir(tmp_path) / "events.jsonl")

    code = resume(tmp_path / "record", "--json")

    assert code == 0
    assert json.loads(capsys.readouterr().out)["validation"] == finished["validation"]
    assert trial_count(run_dir(tmp_path) / "events.jsonl") == trials


def test_should_ask_for_a_new_run_when_the_resume_folder_holds_no_run(harness, tmp_path, capsys):
    write_experiment(tmp_path)
    write_harness(tmp_path, DIRECT_HARNESS)
    (tmp_path / "record").mkdir()

    code = resume(tmp_path / "record")

    assert code == 2
    assert "is not a run folder" in capsys.readouterr().err
    assert harness.calls == []


def test_should_refuse_to_resume_when_the_tuned_settings_changed(harness, tmp_path, capsys):
    assert optimize_harness(tmp_path, DIRECT_HARNESS, "--tune", "effort", "--iterations", "2", "--json", cases=8) == 0
    capsys.readouterr()
    stopped = stop_after_the_first_step(run_dir(tmp_path), tmp_path / "stopped" / run_dir(tmp_path).name)
    write_optimize_entry(
        tmp_path,
        str(tmp_path / "agent.py"),
        str(tmp_path / "experiment.json"),
        settings=("instructions",),
        space=None,
        runner=None,
        custom=(),
        baseline=False,
    )

    code = resume(stopped)

    assert code == 2
    assert "changed" in capsys.readouterr().err


def test_should_tune_effort_on_copies_of_the_model_when_the_agent_builds_a_bedrock_model(model_harness, tmp_path):
    code = optimize_harness(
        tmp_path, bedrock_harness(model_id=CLAUDE_ON_BEDROCK), "--tune", "effort", "--iterations", "1", "--json"
    )

    assert code == 0
    effort = space_of(tmp_path)["effort"]
    assert (effort["default"], effort["options"]) == ("off", ["off", "low", "medium", "high", "xhigh", "max"])
    original, *trials = [call["model"] for call in model_harness.calls]
    assert original.get_config().get("additional_request_fields") is None
    assert trials and all(trial is not original for trial in trials)
    assert all("effort" not in call for call in model_harness.calls)
    measured = {values["effort"] for values in proposed_values(tmp_path)}
    built = [trial.get_config()["additional_request_fields"] for trial in trials]
    assert all(BEDROCK_FIELDS[level] in built for level in measured)


def test_should_set_the_level_on_a_copy_and_leave_the_original_when_a_trial_tunes_effort(model_harness, tmp_path):
    source = bedrock_harness(model_id=CLAUDE_ON_BEDROCK, additional_request_fields={**CONTEXT_BETA, **thinking(2048)})
    harness_file = load_harness(tmp_path, source)

    harness_file.build({"effort": "high"})
    original, trial = model_harness.calls[0]["model"], model_harness.calls[-1]["model"]
    trial.update_config(temperature=0.5)

    assert trial.get_config()["additional_request_fields"] == {**CONTEXT_BETA, **thinking(16384)}
    assert original.get_config()["additional_request_fields"] == {**CONTEXT_BETA, **thinking(2048)}
    assert "temperature" not in original.get_config()
    assert "effort" not in model_harness.calls[-1]


def test_should_pass_the_model_as_configured_when_a_trial_runs_at_auto(model_harness, tmp_path):
    harness_file = load_harness(tmp_path, bedrock_harness(model_id=CLAUDE_ON_BEDROCK))

    harness_file.build({"effort": "auto"})

    assert model_harness.calls[-1]["model"] is model_harness.calls[0]["model"]
    assert "effort" not in model_harness.calls[-1]


@pytest.mark.parametrize(
    ("request_fields", "baseline"),
    [
        (thinking(2048), "low"),
        ({**CONTEXT_BETA, **thinking(16384)}, "high"),
        (thinking(1000), "auto"),
    ],
)
def test_should_start_from_the_level_of_the_model_object_when_tuning_its_effort(
    model_harness, tmp_path, request_fields, baseline
):
    source = bedrock_harness(model_id=CLAUDE_ON_BEDROCK, additional_request_fields=request_fields)

    code = optimize_harness(tmp_path, source, "--tune", "effort", "--iterations", "0")

    assert code == 0
    assert space_of(tmp_path)["effort"]["default"] == baseline


def test_should_start_from_the_model_as_configured_when_it_has_no_reasoning_fields_and_off_sends_some():
    model = types.SimpleNamespace(get_config=lambda: {"params": {"temperature": 0.2}})
    effort = ModelEffort(
        model=model,
        config_key="params",
        fields_by_level={
            "auto": {"reasoning": {"effort": "medium"}},
            "off": {"reasoning": {"effort": "none"}},
            "low": {"reasoning": {"effort": "low"}},
        },
    )

    assert effort.baseline == "auto"


@pytest.mark.parametrize(("level", "budget"), [("low", 2048), ("high", 4095)])
def test_should_keep_the_thinking_budget_under_max_tokens_when_the_model_object_sets_max_tokens(
    model_harness, tmp_path, level, budget
):
    harness_file = load_harness(tmp_path, bedrock_harness(model_id=CLAUDE_ON_BEDROCK, max_tokens=4096))

    harness_file.build({"effort": level})

    assert model_harness.calls[-1]["model"].get_config()["additional_request_fields"] == thinking(budget)


def test_should_name_the_first_error_when_no_reasoning_level_of_the_model_object_can_be_read(
    model_harness, harness_models, tmp_path, monkeypatch, capsys
):
    def unreadable(*args, **kwargs):
        raise RuntimeError("the credentials expired")

    monkeypatch.setattr(harness_models, "resolve_model", unreadable)

    code = optimize_harness(tmp_path, bedrock_harness(model_id=CLAUDE_ON_BEDROCK), "--tune", "effort")

    assert code == 2
    assert (
        "effort cannot be tuned: strands dev could not read the reasoning settings for "
        f"bedrock/{CLAUDE_ON_BEDROCK}: the credentials expired"
    ) in capsys.readouterr().err


def test_should_set_the_reasoning_params_on_a_copy_when_the_agent_builds_an_openai_responses_model(
    model_harness, tmp_path
):
    pytest.importorskip("openai")
    source = (
        "from strands.models.openai_responses import OpenAIResponsesModel\n"
        "from strands_harness import create_harness\n"
        "agent = create_harness(model=OpenAIResponsesModel(model_id='gpt-5.4', params={'max_output_tokens': 500}))\n"
    )
    harness_file = load_harness(tmp_path, source)

    harness_file.build({"effort": "low"})

    assert model_harness.calls[-1]["model"].get_config()["params"] == {
        "max_output_tokens": 500,
        "reasoning": {"effort": "low"},
    }
    assert model_harness.calls[0]["model"].get_config()["params"] == {"max_output_tokens": 500}


def test_should_reject_effort_when_the_agent_builds_a_chat_completions_openai_model(harness, tmp_path, capsys):
    pytest.importorskip("openai")
    source = (
        "from strands.models.openai import OpenAIModel\n"
        "from strands_harness import create_harness\n"
        "agent = create_harness(model=OpenAIModel(model_id='gpt-5.4'))\n"
    )

    code = optimize_harness(tmp_path, source, "--tune", "effort")

    assert code == 2
    assert "the agent's model is a OpenAIModel object, and strands dev can set effort only" in capsys.readouterr().err
