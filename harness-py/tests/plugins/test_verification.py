import json
import os
import sys

import pytest
from strands.hooks import BeforeToolCallEvent
from strands.models import Model
from strands.sandbox import ExecutionResult
from strands.sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment
from strands.vended_plugins.goal import GoalLoop

from strands_harness import create_harness
from strands_harness.plugins import Verification
from strands_harness.plugins.verification import detect_checks


class _ScriptedModel(Model):
    """Replays assistant turns in order; each turn is a text reply or a list of tool calls."""

    def __init__(self, turns):
        self.turns = list(turns)
        self.prompts = []

    def get_config(self):
        return {}

    def update_config(self, **_):
        pass

    async def structured_output(self, *args, **kwargs):
        raise NotImplementedError
        yield

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        last = messages[-1]["content"]
        self.prompts.extend(block["text"] for block in last if "text" in block)
        turn = self.turns.pop(0)
        yield {"messageStart": {"role": "assistant"}}
        if isinstance(turn, str):
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockDelta": {"delta": {"text": turn}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}
            return
        for index, (name, tool_input) in enumerate(turn):
            yield {
                "contentBlockStart": {"start": {"toolUse": {"name": name, "toolUseId": f"t{len(self.turns)}{index}"}}}
            }
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(tool_input)}}}}
            yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "tool_use"}}


class _ScriptedSandbox(NotASandboxLocalEnvironment):
    """Local sandbox whose ``execute`` returns scripted exit codes and records the commands it ran."""

    def __init__(self, exit_codes):
        super().__init__()
        self.exit_codes = list(exit_codes)
        self.commands = []

    async def execute(self, command, *, timeout=None, **kwargs):
        self.commands.append(command)
        code = self.exit_codes.pop(0)
        return ExecutionResult(exit_code=code, stdout=f"ran {command}", stderr="" if code == 0 else "1 failed")


def _write(name="out.txt"):
    # Called inside a test, after ``_in_tmp`` has moved the working directory into ``tmp_path``.
    return [("write", {"path": os.path.abspath(name), "content": "x"})]


def _harness(model, sandbox=None, **kwargs):
    return create_harness(
        model=model,
        builtin_tools=["read", "write"],
        builtin_plugins=[],
        session=False,
        memory=False,
        skills=False,
        context_manager=None,
        caching=None,
        callback_handler=None,
        sandbox=sandbox,
        **kwargs,
    )


@pytest.fixture(autouse=True)
def _in_tmp(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)


def test_off_by_default():
    agent = _harness(_ScriptedModel([]))
    assert not any(isinstance(p, Verification) for p in agent._plugin_registry._plugins.values())


def test_passing_checks_return_the_answer_and_record_state():
    model = _ScriptedModel([_write(), "Done."])
    sandbox = _ScriptedSandbox([0, 0])
    agent = _harness(model, sandbox, verify=["lint", "test"])

    result = agent("make it")

    assert str(result).strip() == "Done."
    assert sandbox.commands == ["lint", "test"]
    assert agent.state.get("verification") == {
        "status": "passed",
        "attempts": 1,
        "checks": [{"command": "lint", "exit_code": 0}, {"command": "test", "exit_code": 0}],
    }


def test_failing_check_feeds_output_back_until_it_passes():
    model = _ScriptedModel([_write(), "Done.", _write(), "Fixed."])
    sandbox = _ScriptedSandbox([1, 0])
    agent = _harness(model, sandbox, verify="pytest -q")

    result = agent("make it")

    assert str(result).strip() == "Fixed."
    feedback = next(p for p in model.prompts if "<verification>" in p)
    assert "attempt 1 of 3" in feedback
    assert "$ pytest -q\nexit code 1" in feedback
    assert "1 failed" in feedback
    assert agent.state.get("verification")["status"] == "passed"
    assert agent.state.get("verification")["attempts"] == 2


def test_exhausted_attempts_force_a_final_report_turn():
    model = _ScriptedModel([_write(), "Done.", _write(), "Done again.", "The tests still fail."])
    sandbox = _ScriptedSandbox([1, 1])
    agent = _harness(model, sandbox, verify={"commands": ["pytest -q"], "max_attempts": 2})

    result = agent("make it")

    assert str(result).strip() == "The tests still fail."
    assert "Stop changing files" in model.prompts[-1]
    assert sandbox.commands == ["pytest -q", "pytest -q"]
    assert agent.state.get("verification") == {
        "status": "failed",
        "attempts": 2,
        "checks": [{"command": "pytest -q", "exit_code": 1}],
    }


def test_read_only_invocation_runs_no_checks():
    model = _ScriptedModel([[("read", {"path": "missing.txt"})], "It is empty."])
    sandbox = _ScriptedSandbox([])
    agent = _harness(model, sandbox, verify="pytest -q")

    agent("what is in it?")

    assert sandbox.commands == []
    assert agent.state.get("verification") is None


def test_each_invocation_starts_a_fresh_run():
    model = _ScriptedModel([_write(), "Done.", "Just answering."])
    sandbox = _ScriptedSandbox([0])
    agent = _harness(model, sandbox, verify="pytest -q")

    agent("make it")
    agent("a question")

    assert sandbox.commands == ["pytest -q"]


def test_changes_before_an_interrupt_are_verified_after_it():
    def gate_read(event):
        if event.tool_use["name"] == "read":
            event.interrupt("approve-read", reason="read?")

    model = _ScriptedModel([_write(), [("read", {"path": os.path.abspath("out.txt")})], "Done."])
    sandbox = _ScriptedSandbox([0])
    agent = _harness(model, sandbox, verify="pytest -q")
    agent.add_hook(gate_read, BeforeToolCallEvent)

    first = agent("make it")
    assert first.stop_reason == "interrupt"
    assert sandbox.commands == []

    # Only the read-only ``read`` runs after the interrupt; the checks still run for the earlier write.
    agent([{"interruptResponse": {"interruptId": first.interrupts[0].id, "response": "yes"}}])
    assert sandbox.commands == ["pytest -q"]
    assert agent.state.get("verification")["status"] == "passed"


def test_timeout_counts_as_failure(tmp_path):
    model = _ScriptedModel([_write(), "Done.", "It hangs."])
    command = f'"{sys.executable}" -c "import time; time.sleep(5)"'
    agent = _harness(model, verify={"commands": [command], "max_attempts": 1, "timeout": 0.5})

    agent("make it")

    state = agent.state.get("verification")
    assert state["status"] == "failed"
    assert state["checks"] == [{"command": command, "exit_code": None}]


def test_real_command_runs_in_the_sandbox_working_directory(tmp_path):
    model = _ScriptedModel([_write(), "Done."])
    command = f"\"{sys.executable}\" -c \"import pathlib; assert pathlib.Path('out.txt').read_text() == 'x'\""
    agent = _harness(model, verify=command)

    agent("make it")

    assert agent.state.get("verification")["status"] == "passed"


def test_failure_prompt_keeps_the_tail_of_long_output():
    class _Noisy(_ScriptedSandbox):
        async def execute(self, command, *, timeout=None, **kwargs):
            self.commands.append(command)
            return ExecutionResult(exit_code=self.exit_codes.pop(0), stdout="a" * 10_000 + "SUMMARY", stderr="")

    model = _ScriptedModel([_write(), "Done.", _write(), "Fixed."])
    agent = _harness(model, _Noisy([1, 0]), verify="t")

    agent("make it")

    feedback = next(p for p in model.prompts if "<verification>" in p)
    assert "a" * 3_993 + "SUMMARY\n\nFix the cause" in feedback
    assert "earlier characters omitted" in feedback
    assert len(feedback) < 5_000


def test_sandbox_error_counts_as_failure():
    class _Broken(NotASandboxLocalEnvironment):
        async def execute(self, command, *, timeout=None, **kwargs):
            raise RuntimeError("container is gone")

    model = _ScriptedModel([_write(), "Done.", "Report."])
    agent = _harness(model, _Broken(), verify={"commands": ["t"], "max_attempts": 1})

    agent("make it")

    assert agent.state.get("verification")["checks"] == [{"command": "t", "exit_code": -1}]


class TestAuto:
    @pytest.mark.parametrize(
        ("path", "content", "expected"),
        [
            ("package.json", '{"scripts": {"test": "vitest"}}', ["npm test"]),
            ("pyproject.toml", "[project]\n", ["python -m pytest -q"]),
            ("Cargo.toml", "[package]\n", ["cargo test"]),
            ("go.mod", "module x\n", ["go test ./..."]),
            ("Makefile", "build:\n\ttrue\ntest:\n\ttrue\n", ["make test"]),
            ("package.json", '{"scripts": {"build": "tsc"}}', []),
            ("Makefile", "build:\n\ttrue\n", []),
        ],
    )
    async def test_detection(self, tmp_path, path, content, expected):
        (tmp_path / path).write_text(content)
        agent = _harness(_ScriptedModel([]))
        assert await detect_checks(agent) == expected

    async def test_nothing_detected(self):
        assert await detect_checks(_harness(_ScriptedModel([]))) == []

    def test_no_detection_warns_and_records_no_checks(self, caplog):
        model = _ScriptedModel([_write(), "Done."])
        sandbox = _ScriptedSandbox([])
        agent = _harness(model, sandbox, verify="auto")

        agent("make it")

        assert sandbox.commands == []
        assert agent.state.get("verification") == {"status": "no_checks", "attempts": 0, "checks": []}
        assert any("found no test command" in r.message for r in caplog.records)

    def test_detected_command_runs(self, tmp_path):
        (tmp_path / "go.mod").write_text("module x\n")
        model = _ScriptedModel([_write(), "Done."])
        sandbox = _ScriptedSandbox([0])
        agent = _harness(model, sandbox, verify="auto")

        agent("make it")

        assert sandbox.commands == ["go test ./..."]

    def test_auto_refuses_interventions(self):
        with pytest.raises(ValueError, match="cannot be combined with interventions"):
            _harness(_ScriptedModel([]), verify="auto", interventions="ask")

    def test_explicit_commands_allow_interventions(self):
        agent = _harness(_ScriptedModel([]), verify="pytest -q", interventions="ask")
        assert any(isinstance(p, Verification) for p in agent._plugin_registry._plugins.values())


class TestOptionValidation:
    @pytest.mark.parametrize(
        ("verify", "match"),
        [
            ([], "non-empty list"),
            ([""], "non-empty list"),
            ({"commands": ["t"], "max_attempts": 0}, "max_attempts"),
            ({"commands": ["t"], "timeout": 0}, "timeout"),
            ({"commands": ["t"], "retries": 2}, "Unknown verify key"),
            ({"max_attempts": 2}, "needs 'commands'"),
            (42, "verify must be"),
        ],
    )
    def test_rejects(self, verify, match):
        with pytest.raises(ValueError, match=match):
            _harness(_ScriptedModel([]), verify=verify)

    @pytest.mark.parametrize("verify", [None, False])
    def test_off(self, verify):
        agent = _harness(_ScriptedModel([]), verify=verify)
        assert not any(isinstance(p, Verification) for p in agent._plugin_registry._plugins.values())

    def test_single_command_in_config(self):
        agent = _harness(_ScriptedModel([]), verify={"commands": "pytest -q"})
        plugin = next(p for p in agent._plugin_registry._plugins.values() if isinstance(p, Verification))
        assert plugin.commands == ["pytest -q"]

    def test_refuses_goal_loop(self):
        with pytest.raises(ValueError, match="GoalLoop"):
            _harness(_ScriptedModel([]), verify="t", plugins=[GoalLoop(goal=lambda r, a: True, max_attempts=1)])

    def test_refuses_duplicate_plugin(self):
        with pytest.raises(ValueError, match="already contains a Verification"):
            _harness(_ScriptedModel([]), verify="t", plugins=[Verification(["t"])])

    def test_plugin_instance_alone_is_accepted(self):
        agent = _harness(_ScriptedModel([]), plugins=[Verification(["t"])])
        assert any(isinstance(p, Verification) for p in agent._plugin_registry._plugins.values())


def test_subagent_config_has_no_verify(monkeypatch):
    import strands_harness.agent as agent_module

    seen = {}
    real = agent_module.build_default_subagent

    def spy(factory, parent_config, **kwargs):
        seen.update(parent_config)
        return real(factory, parent_config, **kwargs)

    monkeypatch.setattr(agent_module, "build_default_subagent", spy)
    create_harness(model=_ScriptedModel([]), verify="pytest -q", session=False, memory=False, skills=False)
    assert seen and "verify" not in seen
