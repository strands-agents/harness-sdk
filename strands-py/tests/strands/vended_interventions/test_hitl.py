"""Tests for the HumanInTheLoop vended intervention handler."""

from unittest.mock import MagicMock

import pytest

from strands import Agent
from strands.tools import tool
from strands.vended_interventions.hitl import HumanInTheLoop
from strands.vended_interventions.hitl.classifier import (
    ClassifierResult,
    LLMClassifierConfig,
    _create_llm_risk_classifier,
    _RiskDecision,
)
from tests.fixtures.mocked_model_provider import MockedModelProvider
from tests.fixtures.mocked_structured_output_model import MockedStructuredOutputModel


def tool_use_message(name: str, tool_use_id: str = "tool-1", tool_input: dict | None = None) -> dict:
    return {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": tool_use_id, "name": name, "input": tool_input or {}}}],
    }


def text_message(text: str) -> dict:
    return {"role": "assistant", "content": [{"text": text}]}


class TestDefaultInterruptResume:
    def test_pauses_agent_with_interrupt_on_any_tool_call(self):
        executed = []

        @tool(name="any_tool")
        def any_tool() -> str:
            executed.append(True)
            return "result"

        model = MockedModelProvider([tool_use_message("any_tool", tool_input={"x": 1}), text_message("Done")])
        agent = Agent(model=model, tools=[any_tool], interventions=[HumanInTheLoop()])

        result = agent("Do something")

        assert result.stop_reason == "interrupt"
        assert result.interrupts is not None
        assert len(result.interrupts) == 1
        assert result.interrupts[0].name == "strands:human-in-the-loop"
        assert "any_tool" in result.interrupts[0].reason
        assert executed == []

    def test_resume_with_approval_executes_tool(self):
        executed = []

        @tool(name="any_tool")
        def any_tool() -> str:
            executed.append(True)
            return "result"

        model = MockedModelProvider([tool_use_message("any_tool"), text_message("Done")])
        agent = Agent(model=model, tools=[any_tool], interventions=[HumanInTheLoop()])

        result = agent("Do something")
        assert result.stop_reason == "interrupt"

        interrupt_id = result.interrupts[0].id
        result = agent([{"interruptResponse": {"interruptId": interrupt_id, "response": "yes"}}])

        assert result.stop_reason == "end_turn"
        assert executed == [True]

    def test_resume_with_rejection_cancels_tool(self):
        executed = []

        @tool(name="any_tool")
        def any_tool() -> str:
            executed.append(True)
            return "result"

        model = MockedModelProvider([tool_use_message("any_tool"), text_message("Understood")])
        agent = Agent(model=model, tools=[any_tool], interventions=[HumanInTheLoop()])

        result = agent("Do something")
        assert result.stop_reason == "interrupt"

        interrupt_id = result.interrupts[0].id
        result = agent([{"interruptResponse": {"interruptId": interrupt_id, "response": "no"}}])

        assert result.stop_reason == "end_turn"
        assert executed == []


class TestInlineAskMode:
    def test_allows_tool_execution_when_approved(self):
        executed = []

        @tool(name="my_tool")
        def my_tool() -> str:
            executed.append(True)
            return "executed"

        model = MockedModelProvider([tool_use_message("my_tool"), text_message("Done")])
        agent = Agent(model=model, tools=[my_tool], interventions=[HumanInTheLoop(ask=lambda prompt: "yes")])

        result = agent("Run tool")

        assert result.stop_reason == "end_turn"
        assert executed == [True]

    def test_denies_tool_execution_when_rejected(self):
        executed = []

        @tool(name="my_tool")
        def my_tool() -> str:
            executed.append(True)
            return "executed"

        model = MockedModelProvider([tool_use_message("my_tool"), text_message("Understood")])
        agent = Agent(model=model, tools=[my_tool], interventions=[HumanInTheLoop(ask=lambda prompt: "no")])

        result = agent("Run tool")

        assert result.stop_reason == "end_turn"
        assert executed == []

    def test_ask_returning_none_denies_instead_of_pausing(self):
        # A configured inline ask returning None must fail closed (deny), not fall back to interrupt/resume.
        executed = []

        @tool(name="my_tool")
        def my_tool() -> str:
            executed.append(True)
            return "executed"

        model = MockedModelProvider([tool_use_message("my_tool"), text_message("Understood")])
        agent = Agent(model=model, tools=[my_tool], interventions=[HumanInTheLoop(ask=lambda prompt: None)])

        result = agent("Run tool")

        assert result.stop_reason == "end_turn"
        assert executed == []

    def test_async_ask_returning_none_denies_instead_of_pausing(self):
        # Same fail-closed contract as the sync case, on the awaited async-ask branch.
        executed = []

        @tool(name="my_tool")
        def my_tool() -> str:
            executed.append(True)
            return "executed"

        async def ask(prompt: str):
            return None

        model = MockedModelProvider([tool_use_message("my_tool"), text_message("Understood")])
        agent = Agent(model=model, tools=[my_tool], interventions=[HumanInTheLoop(ask=ask)])

        result = agent("Run tool")

        assert result.stop_reason == "end_turn"
        assert executed == []

    def test_supports_async_ask_function(self):
        executed = []

        @tool(name="my_tool")
        def my_tool() -> str:
            executed.append(True)
            return "executed"

        async def ask(prompt: str) -> str:
            return "yes"

        model = MockedModelProvider([tool_use_message("my_tool"), text_message("Done")])
        agent = Agent(model=model, tools=[my_tool], interventions=[HumanInTheLoop(ask=ask)])

        result = agent("Run tool")

        assert result.stop_reason == "end_turn"
        assert executed == [True]


class TestAllowedTools:
    def test_bare_string_allowed_tools_raises(self):
        # str is iterable, so a bare string would be shredded into a per-char set and mis-gate; reject it.
        with pytest.raises(ValueError, match="must be a list"):
            HumanInTheLoop(allowed_tools="read_file")

    def test_does_not_prompt_for_tools_in_allowed_tools(self):
        executed = []

        @tool(name="read_file")
        def read_file() -> str:
            executed.append(True)
            return "content"

        model = MockedModelProvider([tool_use_message("read_file"), text_message("Done")])
        agent = Agent(
            model=model,
            tools=[read_file],
            interventions=[HumanInTheLoop(allowed_tools=["read_file"], ask=lambda prompt: "no")],
        )

        result = agent("Read it")

        assert result.stop_reason == "end_turn"
        assert executed == [True]

    def test_prompts_for_tools_not_in_allowed_tools(self):
        executed = []

        @tool(name="delete_file")
        def delete_file() -> str:
            executed.append(True)
            return "deleted"

        model = MockedModelProvider([tool_use_message("delete_file"), text_message("Done")])
        agent = Agent(
            model=model,
            tools=[delete_file],
            interventions=[HumanInTheLoop(allowed_tools=["read_file"], ask=lambda prompt: "no")],
        )

        agent("Delete it")

        assert executed == []

    def test_allows_all_tools_except_negated_ones(self):
        exec_log = []

        @tool(name="read_file")
        def read_file() -> str:
            exec_log.append("read")
            return "content"

        @tool(name="delete_file")
        def delete_file() -> str:
            exec_log.append("delete")
            return "deleted"

        model = MockedModelProvider(
            [
                {
                    "role": "assistant",
                    "content": [
                        {"toolUse": {"toolUseId": "tool-1", "name": "read_file", "input": {}}},
                        {"toolUse": {"toolUseId": "tool-2", "name": "delete_file", "input": {}}},
                    ],
                },
                text_message("Done"),
            ]
        )
        agent = Agent(
            model=model,
            tools=[read_file, delete_file],
            interventions=[HumanInTheLoop(allowed_tools=["*", "!delete_file"], ask=lambda prompt: "no")],
        )

        agent("Do both")

        assert "read" in exec_log
        assert "delete" not in exec_log

    def test_allows_all_tools_with_wildcard(self):
        executed = []

        @tool(name="dangerous_tool")
        def dangerous_tool() -> str:
            executed.append(True)
            return "ran"

        model = MockedModelProvider([tool_use_message("dangerous_tool"), text_message("Done")])
        agent = Agent(
            model=model,
            tools=[dangerous_tool],
            interventions=[HumanInTheLoop(allowed_tools=["*"], ask=lambda prompt: "no")],
        )

        result = agent("Do it")

        assert result.stop_reason == "end_turn"
        assert executed == [True]


class TestAskCallback:
    def test_passes_tool_name_and_input_in_prompt(self):
        prompts = []

        @tool(name="send_email")
        def send_email(to: str) -> str:
            return "sent"

        def ask(prompt: str) -> str:
            prompts.append(prompt)
            return "yes"

        model = MockedModelProvider(
            [tool_use_message("send_email", tool_input={"to": "bob@example.com"}), text_message("Done")]
        )
        agent = Agent(model=model, tools=[send_email], interventions=[HumanInTheLoop(ask=ask)])

        agent("Send email")

        assert "send_email" in prompts[0]
        assert "bob@example.com" in prompts[0]

    def test_supports_custom_evaluate_function(self):
        executed = []

        @tool(name="my_tool")
        def my_tool() -> str:
            executed.append(True)
            return "executed"

        model = MockedModelProvider([tool_use_message("my_tool"), text_message("Done")])
        agent = Agent(
            model=model,
            tools=[my_tool],
            interventions=[
                HumanInTheLoop(
                    ask=lambda prompt: "magic-word",
                    evaluate=lambda response: response == "magic-word",
                )
            ],
        )

        result = agent("Go")

        assert result.stop_reason == "end_turn"
        assert executed == [True]


class TestTrustMode:
    def test_trusts_tool_for_session_when_response_is_t(self):
        ask_count = []

        @tool(name="my_tool")
        def my_tool() -> str:
            return "executed"

        def ask(prompt: str) -> str:
            ask_count.append(1)
            return "t"

        model = MockedModelProvider(
            [
                tool_use_message("my_tool", "tool-1"),
                tool_use_message("my_tool", "tool-2"),
                text_message("Done"),
            ]
        )
        agent = Agent(model=model, tools=[my_tool], interventions=[HumanInTheLoop(enable_trust=True, ask=ask)])

        agent("Run tool twice")

        assert len(ask_count) == 1

    def test_does_not_trust_when_enable_trust_is_false(self):
        ask_count = []

        @tool(name="my_tool")
        def my_tool() -> str:
            return "executed"

        def ask(prompt: str) -> str:
            ask_count.append(1)
            return "t"

        model = MockedModelProvider(
            [
                tool_use_message("my_tool", "tool-1"),
                tool_use_message("my_tool", "tool-2"),
                text_message("Done"),
            ]
        )
        agent = Agent(model=model, tools=[my_tool], interventions=[HumanInTheLoop(enable_trust=False, ask=ask)])

        agent("Run tool twice")

        # 't' isn't approval when trust is disabled: denied both times, ask called both times (no memory).
        assert len(ask_count) == 2

    def test_t_response_also_approves_current_tool_call(self):
        executed = []

        @tool(name="my_tool")
        def my_tool() -> str:
            executed.append(True)
            return "executed"

        model = MockedModelProvider([tool_use_message("my_tool"), text_message("Done")])
        agent = Agent(
            model=model,
            tools=[my_tool],
            interventions=[HumanInTheLoop(enable_trust=True, ask=lambda prompt: "t")],
        )

        result = agent("Run tool")

        assert result.stop_reason == "end_turn"
        assert executed == [True]

    @pytest.mark.parametrize("trust_response", ["trust", "T", "TRUST"])
    def test_trusts_with_alternate_trust_responses(self, trust_response):
        ask_count = []

        @tool(name="my_tool")
        def my_tool() -> str:
            return "executed"

        def ask(prompt: str) -> str:
            ask_count.append(1)
            return trust_response

        model = MockedModelProvider(
            [
                tool_use_message("my_tool", "tool-1"),
                tool_use_message("my_tool", "tool-2"),
                text_message("Done"),
            ]
        )
        agent = Agent(model=model, tools=[my_tool], interventions=[HumanInTheLoop(enable_trust=True, ask=ask)])

        agent("Run tool twice")

        assert len(ask_count) == 1

    def test_supports_custom_evaluate_trust_function(self):
        ask_count = []

        @tool(name="my_tool")
        def my_tool() -> str:
            return "executed"

        def ask(prompt: str) -> str:
            ask_count.append(1)
            return "approve-and-remember"

        model = MockedModelProvider(
            [
                tool_use_message("my_tool", "tool-1"),
                tool_use_message("my_tool", "tool-2"),
                text_message("Done"),
            ]
        )
        agent = Agent(
            model=model,
            tools=[my_tool],
            interventions=[
                HumanInTheLoop(
                    enable_trust=True,
                    evaluate_trust=lambda r: r == "approve-and-remember",
                    ask=ask,
                )
            ],
        )

        agent("Run tool twice")

        assert len(ask_count) == 1

    def test_negated_tools_cannot_be_trusted(self):
        ask_count = []
        executed = []

        @tool(name="danger_tool")
        def danger_tool() -> str:
            executed.append(True)
            return "ran"

        def ask(prompt: str) -> str:
            ask_count.append(1)
            return "t"

        model = MockedModelProvider(
            [
                tool_use_message("danger_tool", "tool-1"),
                tool_use_message("danger_tool", "tool-2"),
                text_message("Done"),
            ]
        )
        agent = Agent(
            model=model,
            tools=[danger_tool],
            interventions=[
                HumanInTheLoop(allowed_tools=["*", "!danger_tool"], enable_trust=True, ask=ask),
            ],
        )

        agent("Run danger twice")

        assert len(ask_count) == 2
        assert executed == []

    def test_trust_via_interrupt_resume_mode(self):
        """Trust responses work in interrupt/resume mode (no ask)."""
        executed = []

        @tool(name="my_tool")
        def my_tool() -> str:
            executed.append(True)
            return "executed"

        model = MockedModelProvider(
            [
                tool_use_message("my_tool", "tool-1"),
                tool_use_message("my_tool", "tool-2"),
                text_message("Done"),
            ]
        )
        agent = Agent(model=model, tools=[my_tool], interventions=[HumanInTheLoop(enable_trust=True)])

        result = agent("Run tool twice")
        assert result.stop_reason == "interrupt"
        # Resume with a trust response: approves the current call AND trusts the tool
        interrupt_id = result.interrupts[0].id
        result = agent([{"interruptResponse": {"interruptId": interrupt_id, "response": "t"}}])
        # Second call to my_tool is trusted: no new interrupt raised
        assert result.stop_reason == "end_turn"
        assert executed == [True, True]
        assert agent.state.get("hitl:trusted_tools") == ["my_tool"]


class TestStdioMode:
    def test_stdio_ask_prompts_via_input(self, monkeypatch):
        prompts = []
        executed = []

        @tool(name="my_tool")
        def my_tool() -> str:
            executed.append(True)
            return "executed"

        def fake_input(prompt: str) -> str:
            prompts.append(prompt)
            return "y"

        monkeypatch.setattr("builtins.input", fake_input)

        model = MockedModelProvider([tool_use_message("my_tool"), text_message("Done")])
        agent = Agent(model=model, tools=[my_tool], interventions=[HumanInTheLoop(ask="stdio")])

        result = agent("Run tool")

        assert result.stop_reason == "end_turn"
        assert executed == [True]
        assert len(prompts) == 1
        assert "my_tool" in prompts[0]
        assert "(y/n)" in prompts[0]

    def test_stdio_ask_includes_trust_option_when_enabled(self, monkeypatch):
        prompts = []
        executed = []

        @tool(name="my_tool")
        def my_tool() -> str:
            executed.append(True)
            return "executed"

        def fake_input(prompt: str) -> str:
            prompts.append(prompt)
            return "n"

        monkeypatch.setattr("builtins.input", fake_input)

        model = MockedModelProvider([tool_use_message("my_tool"), text_message("Done")])
        agent = Agent(model=model, tools=[my_tool], interventions=[HumanInTheLoop(enable_trust=True, ask="stdio")])

        agent("Run tool")

        assert "(y/n/t)" in prompts[0]
        # "n" must actually deny: the tool should never run in stdio mode.
        assert executed == []


class TestPublicExports:
    """Public API exports: HumanInTheLoop, HumanInTheLoopClassifier, LLMClassifierConfig."""

    def test_public_exports(self):
        import strands.vended_interventions as vended
        import strands.vended_interventions.hitl as hitl

        assert vended.__all__ == ["CedarAuthorization", "HumanInTheLoop"]
        assert hitl.__all__ == ["HumanInTheLoop", "HumanInTheLoopClassifier", "LLMClassifierConfig"]
        assert vended.HumanInTheLoop is hitl.HumanInTheLoop
        assert hitl.HumanInTheLoop.name == "strands:human-in-the-loop"

    def test_callback_protocols_are_defined_but_not_exported(self):
        """The typed callable contracts exist (for hints + runtime checks) but are not public API.

        Removing the *exports* (per review) is distinct from removing the *types*:
        the Protocols remain importable from the module and runtime-checkable, they
        are just absent from both ``__all__`` lists so customers don't import them.
        """
        import strands.vended_interventions as vended
        import strands.vended_interventions.hitl as hitl
        from strands.vended_interventions.hitl.hitl import AskCallback, EvaluateCallback

        # Defined and runtime-checkable (still usable as type hints / isinstance checks).
        assert isinstance(AskCallback, type)
        assert isinstance(EvaluateCallback, type)

        def ask(prompt, **kwargs):
            return "y"

        def evaluate(response, **kwargs):
            return True

        assert isinstance(ask, AskCallback)
        assert isinstance(evaluate, EvaluateCallback)

        # But NOT exported from either namespace.
        assert "AskCallback" not in vended.__all__
        assert "EvaluateCallback" not in vended.__all__
        assert "AskCallback" not in hitl.__all__
        assert "EvaluateCallback" not in hitl.__all__

    def test_custom_evaluate_accepting_kwargs_is_used(self):
        executed = []

        @tool(name="my_tool")
        def my_tool() -> str:
            executed.append(True)
            return "ok"

        # A custom evaluate callback may accept **kwargs for forward compatibility.
        def approve_on_emoji(response, **kwargs) -> bool:
            return response == "👍"

        model = MockedModelProvider([tool_use_message("my_tool"), text_message("Done")])
        agent = Agent(model=model, tools=[my_tool], interventions=[HumanInTheLoop(evaluate=approve_on_emoji)])

        result = agent("Run tool")
        assert result.stop_reason == "interrupt"

        interrupt_id = result.interrupts[0].id
        resumed = agent([{"interruptResponse": {"interruptId": interrupt_id, "response": "👍"}}])
        assert resumed.stop_reason == "end_turn"
        assert executed == [True]


class TestCustomInterventionHandler:
    """A custom handler may override before_tool_call as async and be awaited at runtime.

    The registry awaits coroutine overrides, so an ``async def`` handler runs
    end-to-end. Widening the base class so async overrides also type-check
    without a per-file ``# type: ignore`` is tracked in harness-sdk#2800.
    """

    def test_async_handler_returning_proceed(self):
        from strands.interventions.actions import Proceed
        from strands.interventions.handler import InterventionHandler

        executed = []

        @tool(name="ok_tool")
        def ok_tool() -> str:
            executed.append(True)
            return "ran"

        class AsyncAllow(InterventionHandler):
            name = "test:async-allow"

            async def before_tool_call(self, event, **kwargs):
                return Proceed()

        model = MockedModelProvider([tool_use_message("ok_tool"), text_message("Done")])
        agent = Agent(model=model, tools=[ok_tool], interventions=[AsyncAllow()])

        result = agent("Run tool")
        assert result.stop_reason == "end_turn"
        assert executed == [True]


class TestClassifierMode:
    """Tests for the classifier option that enables LLM-driven risk classification."""

    def test_classifier_true_interrupts_when_risky(self):
        from unittest.mock import MagicMock

        from strands.vended_interventions.hitl.classifier import ClassifierResult

        executed = []

        @tool(name="delete_file")
        def delete_file() -> str:
            executed.append(True)
            return "deleted"

        agent_model = MockedModelProvider(
            [tool_use_message("delete_file", tool_input={"path": "/data"}), text_message("Done")]
        )

        mock_classifier = MagicMock(
            return_value=ClassifierResult(requires_human_in_the_loop=True, reason="destructive operation")
        )

        agent = Agent(
            model=agent_model,
            tools=[delete_file],
            interventions=[HumanInTheLoop(classifier=mock_classifier)],
        )

        result = agent("Delete the file")

        assert result.stop_reason == "interrupt"
        assert executed == []
        assert "destructive operation" in result.interrupts[0].reason

    def test_classifier_allows_tool_when_not_risky(self):
        from unittest.mock import MagicMock

        from strands.vended_interventions.hitl.classifier import ClassifierResult

        executed = []

        @tool(name="read_file")
        def read_file() -> str:
            executed.append(True)
            return "content"

        agent_model = MockedModelProvider(
            [tool_use_message("read_file", tool_input={"path": "/tmp/x"}), text_message("Done")]
        )

        mock_classifier = MagicMock(
            return_value=ClassifierResult(requires_human_in_the_loop=False, reason="read-only operation")
        )

        agent = Agent(
            model=agent_model,
            tools=[read_file],
            interventions=[HumanInTheLoop(classifier=mock_classifier)],
        )

        result = agent("Read the file")

        assert result.stop_reason == "end_turn"
        assert executed == [True]

    def test_allowed_tools_bypasses_classifier(self):
        from unittest.mock import MagicMock

        from strands.vended_interventions.hitl.classifier import ClassifierResult

        executed = []

        @tool(name="read_file")
        def read_file() -> str:
            executed.append(True)
            return "content"

        agent_model = MockedModelProvider([tool_use_message("read_file"), text_message("Done")])

        mock_classifier = MagicMock(
            return_value=ClassifierResult(requires_human_in_the_loop=True, reason="should not be called")
        )

        agent = Agent(
            model=agent_model,
            tools=[read_file],
            interventions=[HumanInTheLoop(allowed_tools=["read_file"], classifier=mock_classifier)],
        )

        result = agent("Read")

        assert result.stop_reason == "end_turn"
        assert executed == [True]
        mock_classifier.assert_not_called()

    def test_custom_classifier_function(self):
        from strands.vended_interventions.hitl.classifier import ClassifierResult

        executed = []

        @tool(name="deploy")
        def deploy() -> str:
            executed.append(True)
            return "deployed"

        agent_model = MockedModelProvider(
            [tool_use_message("deploy", tool_input={"env": "prod"}), text_message("Done")]
        )

        def my_classifier(event, **kwargs):
            return ClassifierResult(
                requires_human_in_the_loop=event.tool_use["name"] == "deploy",
                reason="deployment requires approval",
            )

        agent = Agent(
            model=agent_model,
            tools=[deploy],
            interventions=[HumanInTheLoop(classifier=my_classifier)],
        )

        result = agent("Deploy")

        assert result.stop_reason == "interrupt"
        assert executed == []

    def test_classifier_reason_appears_in_prompt(self):
        from unittest.mock import MagicMock

        from strands.vended_interventions.hitl.classifier import ClassifierResult

        prompts = []

        @tool(name="send_email")
        def send_email() -> str:
            return "sent"

        agent_model = MockedModelProvider(
            [tool_use_message("send_email", tool_input={"to": "all@co.com"}), text_message("Done")]
        )

        mock_classifier = MagicMock(
            return_value=ClassifierResult(requires_human_in_the_loop=True, reason="external communication")
        )

        def capture_ask(prompt, **kwargs):
            prompts.append(prompt)
            return "no"

        agent = Agent(
            model=agent_model,
            tools=[send_email],
            interventions=[HumanInTheLoop(classifier=mock_classifier, ask=capture_ask)],
        )

        agent("Send email")

        assert "external communication" in prompts[0]
        assert "send_email" in prompts[0]

    def test_classifier_config_resolves_to_built_in(self):
        from unittest.mock import MagicMock, patch

        from strands.vended_interventions.hitl.classifier import ClassifierResult, LLMClassifierConfig

        mock_fn = MagicMock(return_value=ClassifierResult(requires_human_in_the_loop=False))

        with patch(
            "strands.vended_interventions.hitl.hitl._create_llm_risk_classifier", return_value=mock_fn
        ) as mock_create:
            config = LLMClassifierConfig(system_prompt="custom prompt")
            HumanInTheLoop(classifier=config)

            mock_create.assert_called_once_with(config)

    def test_async_custom_classifier(self):
        from strands.vended_interventions.hitl.classifier import ClassifierResult

        executed = []

        @tool(name="deploy")
        def deploy() -> str:
            executed.append(True)
            return "deployed"

        agent_model = MockedModelProvider(
            [tool_use_message("deploy", tool_input={"env": "prod"}), text_message("Done")]
        )

        async def my_classifier(event, **kwargs):
            return ClassifierResult(
                requires_human_in_the_loop=True,
                reason="async classifier says no",
            )

        agent = Agent(
            model=agent_model,
            tools=[deploy],
            interventions=[HumanInTheLoop(classifier=my_classifier)],
        )

        result = agent("Deploy")

        assert result.stop_reason == "interrupt"
        assert executed == []

    def test_classifier_error_fails_closed(self):
        executed = []

        @tool(name="my_tool")
        def my_tool() -> str:
            executed.append(True)
            return "ran"

        def broken_classifier(event, **kwargs):
            raise RuntimeError("model down")

        agent_model = MockedModelProvider([tool_use_message("my_tool"), text_message("Done")])
        agent = Agent(
            model=agent_model,
            tools=[my_tool],
            interventions=[HumanInTheLoop(classifier=broken_classifier)],
        )

        result = agent("Go")

        assert result.stop_reason == "interrupt"
        assert executed == []

    def test_malformed_classifier_result_fails_closed(self):
        from types import SimpleNamespace

        executed = []

        @tool(name="my_tool")
        def my_tool() -> str:
            executed.append(True)
            return "ran"

        def bad_classifier(event, **kwargs):
            return SimpleNamespace(requires_human_in_the_loop=None)

        agent_model = MockedModelProvider([tool_use_message("my_tool"), text_message("Done")])
        agent = Agent(
            model=agent_model,
            tools=[my_tool],
            interventions=[HumanInTheLoop(classifier=bad_classifier)],
        )

        result = agent("Go")

        assert result.stop_reason == "interrupt"
        assert executed == []

    def test_classifier_not_called_on_resume(self):

        from strands.vended_interventions.hitl.classifier import ClassifierResult

        executed = []
        call_count = []

        @tool(name="my_tool")
        def my_tool() -> str:
            executed.append(True)
            return "ran"

        def counting_classifier(event, **kwargs):
            call_count.append(1)
            return ClassifierResult(requires_human_in_the_loop=True, reason="risky")

        agent_model = MockedModelProvider([tool_use_message("my_tool"), text_message("Done")])
        agent = Agent(
            model=agent_model,
            tools=[my_tool],
            interventions=[HumanInTheLoop(classifier=counting_classifier)],
        )

        result = agent("Go")
        assert result.stop_reason == "interrupt"
        assert len(call_count) == 1

        interrupt_id = result.interrupts[0].id
        result = agent([{"interruptResponse": {"interruptId": interrupt_id, "response": "y"}}])
        assert result.stop_reason == "end_turn"
        assert executed == [True]
        # Classifier was only called once (not again on resume)
        assert len(call_count) == 1

    def test_wildcard_with_classifier_warns(self, caplog):
        import logging

        from strands.vended_interventions.hitl.classifier import ClassifierResult

        def my_classifier(event, **kwargs):
            return ClassifierResult(requires_human_in_the_loop=True)

        with caplog.at_level(logging.WARNING):
            HumanInTheLoop(allowed_tools=["*"], classifier=my_classifier)

        assert "classifier has no effect" in caplog.text


class TestBuiltInClassifier:
    """Tests for the _create_llm_risk_classifier function body."""

    @staticmethod
    def _tool_call_event(model, tool_use=None):
        """Build a tool call event whose agent is hosted on the given model."""
        event = MagicMock()
        event.tool_use = tool_use or {"name": "delete_file", "input": {"path": "/data"}}
        event.agent = Agent(model=model, load_tools_from_directory=False)
        event.invocation_state = {}
        return event

    @pytest.mark.asyncio
    async def test_asks_model_and_returns_decision(self):
        model = MockedStructuredOutputModel(_RiskDecision(requires_approval=True, reason="destructive"))
        classifier = _create_llm_risk_classifier()

        tru_result = await classifier(self._tool_call_event(model))
        exp_result = ClassifierResult(requires_human_in_the_loop=True, reason="destructive")

        assert tru_result == exp_result
        assert model.prompts == [
            [
                {
                    "role": "user",
                    "content": [
                        {
                            "text": (
                                "Should this tool call require human approval?\n\n"
                                'Tool: delete_file\nInput: {\n  "path": "/data"\n}'
                            )
                        }
                    ],
                }
            ]
        ]

    @pytest.mark.asyncio
    async def test_raises_when_no_model_available(self):
        classifier = _create_llm_risk_classifier()

        event = MagicMock()
        event.tool_use = {"name": "tool", "input": {}}
        event.agent.model = None

        with pytest.raises(ValueError, match="no model"):
            await classifier(event)

    @pytest.mark.asyncio
    async def test_raises_when_model_yields_no_risk_decision(self):
        model = MockedStructuredOutputModel(output="not a risk decision")
        classifier = _create_llm_risk_classifier()

        with pytest.raises(ValueError, match="produced no _RiskDecision"):
            await classifier(self._tool_call_event(model))

    @pytest.mark.asyncio
    async def test_uses_configured_model_over_agent_model(self):
        configured_model = MockedStructuredOutputModel(_RiskDecision(requires_approval=False, reason="safe"))
        agent_model = MockedStructuredOutputModel(_RiskDecision(requires_approval=True, reason="risky"))
        classifier = _create_llm_risk_classifier(LLMClassifierConfig(model=configured_model))

        tru_result = await classifier(self._tool_call_event(agent_model))

        assert tru_result == ClassifierResult(requires_human_in_the_loop=False, reason="safe")
        assert len(configured_model.prompts) == 1
        assert agent_model.prompts == []

    @pytest.mark.asyncio
    async def test_uses_custom_system_prompt(self):
        custom_prompt = "Only approve writes."
        model = MockedStructuredOutputModel(_RiskDecision(requires_approval=False, reason="ok"))
        classifier = _create_llm_risk_classifier(LLMClassifierConfig(system_prompt=custom_prompt))

        await classifier(self._tool_call_event(model))

        assert model.system_prompts == [custom_prompt]
