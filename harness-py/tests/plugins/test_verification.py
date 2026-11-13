import json
import os
import sys

import pytest
from pydantic import BaseModel
from strands.hooks import AfterToolsEvent, BeforeToolCallEvent
from strands.models import Model
from strands.sandbox import ExecutionResult
from strands.sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment
from strands.types.exceptions import MaxTokensReachedException
from strands.vended_plugins.goal import GoalLoop

from strands_harness import create_harness
from strands_harness.plugins import Verification
from strands_harness.plugins.verification import detect_checks


class _ScriptedModel(Model):
    """Replays assistant turns in order: a text reply, a list of tool calls, or ``_stop(reason, text)``."""

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
        if isinstance(turn, (str, _Stop)):
            reason, text = (turn.reason, turn.text) if isinstance(turn, _Stop) else ("end_turn", turn)
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockDelta": {"delta": {"text": text}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": reason}}
            return
        for index, (name, tool_input) in enumerate(turn):
            yield {
                "contentBlockStart": {"start": {"toolUse": {"name": name, "toolUseId": f"t{len(self.turns)}{index}"}}}
            }
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(tool_input)}}}}
            yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "tool_use"}}


class _Stop:
    """A text turn that ends with ``reason`` instead of ``end_turn``."""

    def __init__(self, reason, text="partial"):
        self.reason, self.text = reason, text


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


def _plugin(agent):
    return next(p for p in agent._plugin_registry._plugins.values() if isinstance(p, Verification))


def _outcome(agent):
    result = _plugin(agent).last_result(agent)
    return None if result is None else (result.passed, result.stop_reason, [a.passed for a in result.attempts])


def _gate_read(event):
    if event.tool_use["name"] == "read":
        event.interrupt("approve-read", reason="read?")


def _approve(agent, result):
    return agent([{"interruptResponse": {"interruptId": result.interrupts[0].id, "response": "yes"}}])


def _read():
    return [("read", {"path": os.path.abspath("out.txt")})]


class _Out(BaseModel):
    summary: str


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


def test_exhausted_attempts_return_the_last_answer_unverified(caplog):
    model = _ScriptedModel([_write(), "Done.", _write(), "Done again."])
    sandbox = _ScriptedSandbox([1, 1])
    agent = _harness(model, sandbox, verify={"commands": ["pytest -q"], "max_attempts": 2})

    result = agent("make it")

    # GoalLoop stops after max_attempts failed checks; there is no extra report turn.
    assert str(result).strip() == "Done again."
    assert model.turns == []
    assert sandbox.commands == ["pytest -q", "pytest -q"]
    assert agent.state.get("verification") == {
        "status": "failed",
        "attempts": 2,
        "checks": [{"command": "pytest -q", "exit_code": 1}],
    }
    assert any("returning the answer unverified" in r.message for r in caplog.records)


def test_retry_without_new_changes_still_runs_the_checks():
    # The retry changes nothing; its "done" must still be checked against the failing workspace.
    model = _ScriptedModel([_write(), "Done.", "Fixed, trust me."])
    sandbox = _ScriptedSandbox([1, 1])
    agent = _harness(model, sandbox, verify={"commands": ["t"], "max_attempts": 2})

    agent("make it")

    assert sandbox.commands == ["t", "t"]
    assert agent.state.get("verification")["status"] == "failed"


def test_verification_is_a_goal_loop():
    model = _ScriptedModel([_write(), "Done.", _write(), "Done again.", _write(), "Fixed."])
    agent = _harness(model, _ScriptedSandbox([1, 1, 0]), verify={"commands": ["t"], "max_attempts": 2})
    plugin = next(p for p in agent._plugin_registry._plugins.values() if isinstance(p, Verification))

    assert isinstance(plugin, GoalLoop)
    agent("make it")
    assert plugin.last_result(agent).stop_reason == "max_attempts"
    agent("try again")  # a new request starts a new GoalLoop run
    result = plugin.last_result(agent)
    assert (result.passed, result.stop_reason, len(result.attempts)) == (True, "satisfied", 1)


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
    model = _ScriptedModel([_write(), "Done."])
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

    model = _ScriptedModel([_write(), "Done."])
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
            ("package.json", '{"description": "a \\"test\\" helper", "devDependencies": {"test": "1"}}', []),
            ("package.json", '{"scripts": {"test": ""}}', []),
            ("package.json", '{"scripts": {"test": "vitest"', []),
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

    def test_a_project_scaffolded_later_gets_its_checks(self, tmp_path, caplog):
        model = _ScriptedModel([_write("notes.md"), "Noted.", _write(), "Changed.", _write(), "Changed again."])
        sandbox = _ScriptedSandbox([0, 0])
        agent = _harness(model, sandbox, verify="auto")

        agent("write notes")
        assert agent.state.get("verification")["status"] == "no_checks"
        (tmp_path / "go.mod").write_text("module x\n")
        agent("add a feature")
        agent("add another")

        assert sandbox.commands == ["go test ./...", "go test ./..."]
        assert agent.state.get("verification")["status"] == "passed"
        assert sum("found no test command" in r.message for r in caplog.records) == 1

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

    def test_refuses_a_second_verification(self):
        with pytest.raises(ValueError, match="a Verification is one"):
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


class TestHowAnInvocationEnds:
    @pytest.mark.parametrize(
        "ending",
        [
            "stop_sequence",
            "after_tools_end_turn",
            "structured_output",
            "invalid_then_valid_output",
            "output_with_write",
        ],
    )
    def test_normal_endings_are_graded(self, ending):
        so = [("_Out", {"summary": "done"})]
        turns = {
            "stop_sequence": [_write(), _Stop("stop_sequence", "Done.")],
            "after_tools_end_turn": [_write()],
            "structured_output": [_write(), "Done.", so],
            "invalid_then_valid_output": [_write(), "Done.", [("_Out", {"wrong": 1})], so],
            "output_with_write": [_write() + so],
        }[ending]
        sandbox = _ScriptedSandbox([0])
        agent = _harness(_ScriptedModel(turns), sandbox, verify="t")
        if ending == "after_tools_end_turn":
            agent.add_hook(lambda event: setattr(event, "end_turn", "Done."), AfterToolsEvent)

        agent("make it", **({"structured_output_model": _Out} if "output" in ending else {}))

        assert sandbox.commands == ["t"]
        assert agent.state.get("verification")["status"] == "passed"
        assert _outcome(agent) == (True, "satisfied", [True])

    def test_read_only_structured_output_request_leaves_nothing_pending(self):
        sandbox = _ScriptedSandbox([])
        agent = _harness(_ScriptedModel(["Hi.", [("_Out", {"summary": "hi"})], "Just answering."]), sandbox, verify="t")

        agent("say hi", structured_output_model=_Out)
        agent("a question")

        assert sandbox.commands == []
        assert agent.state.get("verification") is None

    @pytest.mark.parametrize("early", ["interrupt", "max_tokens"])
    @pytest.mark.parametrize("before", ["nothing", "failed_check_then_write", "failed_check_no_write"])
    def test_early_stop_is_pending_and_checked_next_time(self, early, before):
        turns = {"nothing": [_write()], "failed_check_then_write": [_write(), "Done.", _write()]}.get(
            before, [_write(), "Done."]
        )
        turns += [_read() if early == "interrupt" else _Stop("max_tokens"), "Fixed."]
        checks_before = [] if before == "nothing" else ["t"]
        sandbox = _ScriptedSandbox([1, 0] if checks_before else [0])
        agent = _harness(_ScriptedModel(turns), sandbox, verify="t")
        agent.add_hook(_gate_read, BeforeToolCallEvent)

        if early == "max_tokens":
            with pytest.raises(MaxTokensReachedException):
                agent("make it")
        else:
            stopped = agent("make it")

        assert sandbox.commands == checks_before
        assert agent.state.get("verification")["status"] == "pending"
        assert _outcome(agent) is None

        result = _approve(agent, stopped) if early == "interrupt" else agent("go on")
        assert str(result).strip() == "Fixed."
        assert sandbox.commands == [*checks_before, "t"]
        assert agent.state.get("verification") == {
            "status": "passed",
            "attempts": len(sandbox.commands),
            "checks": [{"command": "t", "exit_code": 0}],
        }
        assert _outcome(agent) == (True, "satisfied", [False, True] if checks_before else [True])

    def test_a_pass_followed_by_an_interrupted_change_is_pending_not_passed(self):
        sandbox = _ScriptedSandbox([0])
        agent = _harness(_ScriptedModel([_write(), "Done.", _write(), _read()]), sandbox, verify="t")
        agent.add_hook(_gate_read, BeforeToolCallEvent)

        agent("make it")
        agent("change more")

        assert sandbox.commands == ["t"]
        assert agent.state.get("verification")["status"] == "pending"
        assert _outcome(agent) is None

    def test_a_turn_limit_after_a_failed_check_reports_only_what_the_last_check_said(self):
        sandbox = _ScriptedSandbox([1, 0])
        agent = _harness(_ScriptedModel([_write(), "Done.", _write(), _write(), "Fixed."]), sandbox, verify="t")

        agent("make it", limits={"turns": 3})

        # SDK versions differ on whether GoalLoop's retry may pass the limit; either way the outcome matches the
        # last check, and "pending" goes with no result.
        status = agent.state.get("verification")["status"]
        if sandbox.commands == ["t"]:
            assert (status, _outcome(agent)) in (("pending", None), ("failed", (False, "limit", [False])))
        else:
            assert (status, _outcome(agent)) == ("passed", (True, "satisfied", [False, True]))

    def test_interrupts_do_not_reset_the_attempt_budget(self):
        def gate_write(event):
            if event.tool_use["name"] == "write":
                event.interrupt("approve-write", reason="write?")

        model = _ScriptedModel([_write(), "Done."] * 4)
        sandbox = _ScriptedSandbox([1] * 4)
        agent = _harness(model, sandbox, verify={"commands": ["t"], "max_attempts": 2})
        agent.add_hook(gate_write, BeforeToolCallEvent)

        result = agent("make it")
        for _ in range(4):
            if result.stop_reason != "interrupt":
                break
            result = _approve(agent, result)

        assert result.stop_reason == "end_turn"
        assert sandbox.commands == ["t", "t"]
        headers = [p.split("\n")[1] for p in model.prompts if "<verification>" in p]
        assert headers == ["The project's checks failed after your changes (attempt 1 of 2)."]
        assert _outcome(agent) == (False, "max_attempts", [False, False])

    def test_last_result_is_none_mid_invocation_and_kept_per_agent(self):
        plugin = Verification(["t"])
        seen = []
        first = _harness(_ScriptedModel([]), _ScriptedSandbox([]), plugins=[plugin])
        second = _harness(_ScriptedModel([_write(), "Done."]), _ScriptedSandbox([0]), plugins=[plugin])
        second.add_hook(lambda event: seen.append(plugin.last_result(event.agent)), BeforeToolCallEvent)

        second("make it")

        assert seen == [None]
        assert plugin.last_result(second).passed is True
        assert plugin.last_result(first) is None

    def test_validator_error_is_recorded_as_a_failure(self):
        verify = {"commands": ["t"], "max_attempts": 1}
        agent = _harness(_ScriptedModel([_write(), "Done."]), _ScriptedSandbox([]), verify=verify)

        async def broken(_agent):
            raise RuntimeError("sandbox is gone")

        _plugin(agent)._resolve_commands = broken
        agent("make it")

        assert agent.state.get("verification")["checks"] == [{"command": "verify", "exit_code": -1}]
        assert _outcome(agent) == (False, "max_attempts", [False])
