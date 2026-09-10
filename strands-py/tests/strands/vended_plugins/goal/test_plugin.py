"""Tests for the GoalLoop plugin."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from strands.hooks.events import AfterInvocationEvent, BeforeInvocationEvent, BeforeModelCallEvent
from strands.types._snapshot import Snapshot
from strands.vended_plugins.goal import GoalAttempt, GoalLoop, GoalResult, JudgeConfig, ValidationOutcome
from strands.vended_plugins.goal.judge import JUDGE_SYSTEM_PROMPT, JudgeOutcome, build_judge_prompt
from tests.fixtures.mocked_structured_output_model import MockedStructuredOutputModel

# --- Helpers ---


def _make_mock_agent():
    """Create a mock agent with minimal interface for GoalLoop."""
    agent = MagicMock()
    agent.messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
        {"role": "assistant", "content": [{"text": "World"}]},
    ]
    agent.model = MagicMock()
    agent.hooks.invoke_callbacks_async = AsyncMock()
    agent.take_snapshot = MagicMock(return_value=Snapshot(scope="agent", schema_version="1.0", data={}, app_data={}))
    agent.load_snapshot = MagicMock()
    agent.__hash__ = MagicMock(return_value=id(agent))
    agent.__eq__ = MagicMock(side_effect=lambda other: agent is other)
    return agent


def _setup_plugin_with_hooks(plugin, agent):
    """Init the plugin on the agent, capturing registered hook callbacks."""
    hooks: dict[str, list] = {"before": [], "after": [], "before_model": []}

    def capture_hook(callback, event_type=None, **kwargs):
        if event_type == BeforeInvocationEvent:
            hooks["before"].append(callback)
        elif event_type == AfterInvocationEvent:
            hooks["after"].append(callback)
        elif event_type == BeforeModelCallEvent:
            hooks["before_model"].append(callback)

    agent.add_hook = capture_hook
    plugin.init_agent(agent)
    return hooks


@pytest.fixture(autouse=True)
def clear_global_state():
    """Clear the global _agents_with_goal_loop WeakSet between tests."""
    from strands.vended_plugins.goal.plugin import _agents_with_goal_loop

    _agents_with_goal_loop.clear()
    yield
    _agents_with_goal_loop.clear()


# --- Constructor validation ---


class TestConstructorValidation:
    def test_goal_required(self):
        with pytest.raises(ValueError, match="`goal` is required"):
            GoalLoop(goal=None)

    def test_max_attempts_must_be_at_least_1(self):
        with pytest.raises(ValueError, match="must be at least 1"):
            GoalLoop(goal="test goal", max_attempts=0)

    def test_negative_max_attempts_rejected(self):
        with pytest.raises(ValueError, match="must be at least 1"):
            GoalLoop(goal="test goal", max_attempts=-1)

    def test_non_positive_timeout_rejected(self):
        with pytest.raises(ValueError, match="must be positive"):
            GoalLoop(goal="test goal", timeout=-1)
        with pytest.raises(ValueError, match="must be positive"):
            GoalLoop(goal="test goal", timeout=0)

    def test_unbounded_warns(self):
        with pytest.warns(UserWarning, match="unbounded"):
            GoalLoop(goal="test goal")

    def test_max_attempts_set_no_warning(self):
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("error")
            GoalLoop(goal="test goal", max_attempts=3)

    def test_timeout_set_no_warning(self):
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("error")
            GoalLoop(goal="test goal", timeout=10.0)

    def test_custom_name(self):
        plugin = GoalLoop(goal="test", max_attempts=1)
        assert plugin.name == "strands:goal-loop"

        plugin = GoalLoop(goal="test", max_attempts=1, name="my-goal")
        assert plugin.name == "my-goal"


# --- Plugin registration ---


class TestPluginRegistration:
    def test_init_agent_registers_hooks(self):
        agent = _make_mock_agent()
        plugin = GoalLoop(goal=lambda r, a: True, max_attempts=1)
        hooks = _setup_plugin_with_hooks(plugin, agent)
        assert len(hooks["before"]) == 1
        assert len(hooks["after"]) == 1

    def test_duplicate_goal_loop_raises(self):
        agent = _make_mock_agent()
        plugin1 = GoalLoop(goal=lambda r, a: True, max_attempts=1)
        plugin2 = GoalLoop(goal=lambda r, a: True, max_attempts=1)

        _setup_plugin_with_hooks(plugin1, agent)
        with pytest.raises(RuntimeError, match="another GoalLoop is already attached"):
            plugin2.init_agent(agent)

    def test_preserve_context_false_registers_before_model_hook(self):
        agent = _make_mock_agent()
        plugin = GoalLoop(goal=lambda r, a: True, max_attempts=3, preserve_context=False)
        hooks = _setup_plugin_with_hooks(plugin, agent)
        assert len(hooks["before_model"]) == 1


# --- Function validator scenarios ---


class TestFunctionValidator:
    @pytest.mark.asyncio
    async def test_passes_immediately(self):
        agent = _make_mock_agent()
        plugin = GoalLoop(goal=lambda r, a: True, max_attempts=5)
        hooks = _setup_plugin_with_hooks(plugin, agent)

        hooks["before"][0](BeforeInvocationEvent(agent=agent))
        after_event = AfterInvocationEvent(agent=agent)
        await hooks["after"][0](after_event)

        assert plugin.last_result(agent) == GoalResult(
            passed=True,
            stop_reason="satisfied",
            attempts=[GoalAttempt(attempt=1, passed=True, feedback=None)],
        )

    @pytest.mark.asyncio
    async def test_fails_then_passes(self):
        agent = _make_mock_agent()
        call_count = [0]

        def validator(response, ag):
            call_count[0] += 1
            if call_count[0] == 1:
                return {"passed": False, "feedback": "Not good enough"}
            return True

        plugin = GoalLoop(goal=validator, max_attempts=5)
        hooks = _setup_plugin_with_hooks(plugin, agent)

        # Attempt 1 - fails
        hooks["before"][0](BeforeInvocationEvent(agent=agent))
        after_event = AfterInvocationEvent(agent=agent)
        await hooks["after"][0](after_event)

        assert after_event.resume is not None
        assert "Not good enough" in after_event.resume

        # Attempt 2 - simulate resume (before hook sees resumed=True)
        hooks["before"][0](BeforeInvocationEvent(agent=agent))
        after_event2 = AfterInvocationEvent(agent=agent)
        await hooks["after"][0](after_event2)

        assert plugin.last_result(agent) == GoalResult(
            passed=True,
            stop_reason="satisfied",
            attempts=[
                GoalAttempt(attempt=1, passed=False, feedback="Not good enough"),
                GoalAttempt(attempt=2, passed=True, feedback=None),
            ],
        )

    @pytest.mark.asyncio
    async def test_max_attempts_reached(self):
        agent = _make_mock_agent()
        plugin = GoalLoop(goal=lambda r, a: False, max_attempts=3)
        hooks = _setup_plugin_with_hooks(plugin, agent)

        # Attempt 1
        hooks["before"][0](BeforeInvocationEvent(agent=agent))
        event1 = AfterInvocationEvent(agent=agent)
        await hooks["after"][0](event1)
        assert event1.resume is not None

        # Attempt 2 (resumed)
        hooks["before"][0](BeforeInvocationEvent(agent=agent))
        event2 = AfterInvocationEvent(agent=agent)
        await hooks["after"][0](event2)
        assert event2.resume is not None

        # Attempt 3 - final
        hooks["before"][0](BeforeInvocationEvent(agent=agent))
        event3 = AfterInvocationEvent(agent=agent)
        await hooks["after"][0](event3)
        assert event3.resume is None  # No more retries

        result = plugin.last_result(agent)
        assert result is not None
        assert result.passed is False
        assert result.stop_reason == "max_attempts"
        assert len(result.attempts) == 3  # each attempt is non-deterministic feedback

    @pytest.mark.asyncio
    async def test_timeout(self):
        agent = _make_mock_agent()
        plugin = GoalLoop(goal=lambda r, a: False, max_attempts=100, timeout=0.01)
        hooks = _setup_plugin_with_hooks(plugin, agent)

        hooks["before"][0](BeforeInvocationEvent(agent=agent))

        # Sleep to exceed timeout
        await asyncio.sleep(0.02)

        after_event = AfterInvocationEvent(agent=agent)
        await hooks["after"][0](after_event)

        result = plugin.last_result(agent)
        assert result is not None
        assert result.passed is False
        assert result.stop_reason == "timeout"

    @pytest.mark.asyncio
    async def test_async_validator(self):
        agent = _make_mock_agent()

        async def async_validator(response, ag):
            await asyncio.sleep(0)
            return ValidationOutcome(passed=True)

        plugin = GoalLoop(goal=async_validator, max_attempts=5)
        hooks = _setup_plugin_with_hooks(plugin, agent)

        hooks["before"][0](BeforeInvocationEvent(agent=agent))
        after_event = AfterInvocationEvent(agent=agent)
        await hooks["after"][0](after_event)

        result = plugin.last_result(agent)
        assert result is not None
        assert result.passed is True

    @pytest.mark.asyncio
    async def test_validator_exception_handled(self):
        agent = _make_mock_agent()

        def bad_validator(response, ag):
            raise ValueError("Validator broke")

        plugin = GoalLoop(goal=bad_validator, max_attempts=2)
        hooks = _setup_plugin_with_hooks(plugin, agent)

        hooks["before"][0](BeforeInvocationEvent(agent=agent))
        after_event = AfterInvocationEvent(agent=agent)
        await hooks["after"][0](after_event)

        # Should not crash; treats as failed attempt with error feedback
        assert after_event.resume is not None
        assert "Validator error" in after_event.resume

    @pytest.mark.asyncio
    async def test_no_assistant_message_no_op(self):
        agent = _make_mock_agent()
        agent.messages = [{"role": "user", "content": [{"text": "Hello"}]}]

        plugin = GoalLoop(goal=lambda r, a: False, max_attempts=5)
        hooks = _setup_plugin_with_hooks(plugin, agent)

        hooks["before"][0](BeforeInvocationEvent(agent=agent))
        after_event = AfterInvocationEvent(agent=agent)
        await hooks["after"][0](after_event)

        # No assistant message means no validation attempted
        assert after_event.resume is None
        result = plugin.last_result(agent)
        assert result is None

    @pytest.mark.asyncio
    async def test_dict_return_from_validator(self):
        agent = _make_mock_agent()
        plugin = GoalLoop(
            goal=lambda r, a: {"passed": False, "feedback": "Fix it"},
            max_attempts=2,
        )
        hooks = _setup_plugin_with_hooks(plugin, agent)

        hooks["before"][0](BeforeInvocationEvent(agent=agent))
        after_event = AfterInvocationEvent(agent=agent)
        await hooks["after"][0](after_event)

        assert after_event.resume is not None
        assert "Fix it" in after_event.resume

    @pytest.mark.asyncio
    async def test_validation_outcome_return(self):
        agent = _make_mock_agent()
        plugin = GoalLoop(
            goal=lambda r, a: ValidationOutcome(passed=False, feedback="Use outcome obj"),
            max_attempts=2,
        )
        hooks = _setup_plugin_with_hooks(plugin, agent)

        hooks["before"][0](BeforeInvocationEvent(agent=agent))
        after_event = AfterInvocationEvent(agent=agent)
        await hooks["after"][0](after_event)

        assert after_event.resume is not None
        assert "Use outcome obj" in after_event.resume


# --- last_result lifecycle ---


class TestLastResult:
    def test_undefined_before_run(self):
        agent = _make_mock_agent()
        plugin = GoalLoop(goal=lambda r, a: True, max_attempts=1)
        assert plugin.last_result(agent) is None

    @pytest.mark.asyncio
    async def test_updated_after_completion(self):
        agent = _make_mock_agent()
        plugin = GoalLoop(goal=lambda r, a: True, max_attempts=1)
        hooks = _setup_plugin_with_hooks(plugin, agent)

        hooks["before"][0](BeforeInvocationEvent(agent=agent))
        await hooks["after"][0](AfterInvocationEvent(agent=agent))

        result = plugin.last_result(agent)
        assert result is not None
        assert result.passed is True

    @pytest.mark.asyncio
    async def test_cleared_on_new_invocation(self):
        agent = _make_mock_agent()
        plugin = GoalLoop(goal=lambda r, a: True, max_attempts=1)
        hooks = _setup_plugin_with_hooks(plugin, agent)

        # First run
        hooks["before"][0](BeforeInvocationEvent(agent=agent))
        await hooks["after"][0](AfterInvocationEvent(agent=agent))
        assert plugin.last_result(agent) is not None

        # New invocation clears the result (resumed=False, so new RunState is created)
        hooks["before"][0](BeforeInvocationEvent(agent=agent))
        assert plugin.last_result(agent) is None


# --- preserve_context=False (Ralph-Wiggum mode) ---


class TestPreserveContextFalse:
    @pytest.mark.asyncio
    async def test_snapshot_taken_on_first_model_call(self):
        agent = _make_mock_agent()
        plugin = GoalLoop(goal=lambda r, a: False, max_attempts=3, preserve_context=False)
        hooks = _setup_plugin_with_hooks(plugin, agent)

        hooks["before"][0](BeforeInvocationEvent(agent=agent))
        hooks["before_model"][0](BeforeModelCallEvent(agent=agent))

        agent.take_snapshot.assert_called_once_with(preset="session", include=["system_prompt"], exclude=["state"])

    @pytest.mark.asyncio
    async def test_snapshot_restored_on_retry(self):
        agent = _make_mock_agent()
        plugin = GoalLoop(goal=lambda r, a: False, max_attempts=3, preserve_context=False)
        hooks = _setup_plugin_with_hooks(plugin, agent)

        hooks["before"][0](BeforeInvocationEvent(agent=agent))
        hooks["before_model"][0](BeforeModelCallEvent(agent=agent))

        after_event = AfterInvocationEvent(agent=agent)
        await hooks["after"][0](after_event)

        agent.load_snapshot.assert_called_once()

    @pytest.mark.asyncio
    async def test_snapshot_not_taken_on_subsequent_model_calls(self):
        agent = _make_mock_agent()
        plugin = GoalLoop(goal=lambda r, a: False, max_attempts=3, preserve_context=False)
        hooks = _setup_plugin_with_hooks(plugin, agent)

        hooks["before"][0](BeforeInvocationEvent(agent=agent))
        hooks["before_model"][0](BeforeModelCallEvent(agent=agent))
        hooks["before_model"][0](BeforeModelCallEvent(agent=agent))

        # Should only snapshot once
        assert agent.take_snapshot.call_count == 1


# --- Custom resume prompt template ---


class TestResumePromptTemplate:
    @pytest.mark.asyncio
    async def test_custom_template_used(self):
        agent = _make_mock_agent()

        def custom_prompt(feedback):
            return f"CUSTOM: {feedback}"

        plugin = GoalLoop(
            goal=lambda r, a: {"passed": False, "feedback": "try again"},
            max_attempts=3,
            resume_prompt_template=custom_prompt,
        )
        hooks = _setup_plugin_with_hooks(plugin, agent)

        hooks["before"][0](BeforeInvocationEvent(agent=agent))
        after_event = AfterInvocationEvent(agent=agent)
        await hooks["after"][0](after_event)

        assert after_event.resume == "CUSTOM: try again"

    @pytest.mark.asyncio
    async def test_default_prompt_with_feedback(self):
        agent = _make_mock_agent()
        plugin = GoalLoop(
            goal=lambda r, a: {"passed": False, "feedback": "Too verbose"},
            max_attempts=3,
        )
        hooks = _setup_plugin_with_hooks(plugin, agent)

        hooks["before"][0](BeforeInvocationEvent(agent=agent))
        after_event = AfterInvocationEvent(agent=agent)
        await hooks["after"][0](after_event)

        assert "Too verbose" in after_event.resume
        assert "Feedback on what was wrong" in after_event.resume

    @pytest.mark.asyncio
    async def test_default_prompt_without_feedback(self):
        agent = _make_mock_agent()
        plugin = GoalLoop(goal=lambda r, a: False, max_attempts=3)
        hooks = _setup_plugin_with_hooks(plugin, agent)

        hooks["before"][0](BeforeInvocationEvent(agent=agent))
        after_event = AfterInvocationEvent(agent=agent)
        await hooks["after"][0](after_event)

        assert "did not satisfy the goal" in after_event.resume


# --- Judge helpers ---


class TestJudgeHelpers:
    def test_judge_outcome_schema(self):
        outcome = JudgeOutcome(passed=True)
        assert outcome.passed is True
        assert outcome.feedback is None

        outcome = JudgeOutcome(passed=False, feedback="Fix this")
        assert outcome.passed is False
        assert outcome.feedback == "Fix this"

    def test_build_judge_prompt_basic(self):
        messages = [
            {"role": "user", "content": [{"text": "Hello"}]},
            {"role": "assistant", "content": [{"text": "Hi there"}]},
        ]
        prompt = build_judge_prompt("Be friendly", messages)
        assert "Goal:\nBe friendly" in prompt
        assert "[user]" in prompt
        assert "[assistant]" in prompt
        assert "Hello" in prompt
        assert "Hi there" in prompt

    def test_build_judge_prompt_with_tools(self):
        messages = [
            {"role": "user", "content": [{"text": "Run tests"}]},
            {
                "role": "assistant",
                "content": [
                    {"toolUse": {"name": "bash", "input": {"cmd": "npm test"}, "toolUseId": "t1"}},
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": "t1",
                            "status": "success",
                            "content": [{"text": "All tests passed"}],
                        }
                    },
                ],
            },
        ]
        prompt = build_judge_prompt("Tests must pass", messages)
        assert "[tool-call: bash]" in prompt
        assert "[tool-result: success]" in prompt
        assert "All tests passed" in prompt

    def test_build_judge_prompt_truncates_long_tool_input(self):
        long_input = "x" * 1000
        messages = [
            {
                "role": "assistant",
                "content": [
                    {"toolUse": {"name": "write", "input": long_input, "toolUseId": "t1"}},
                ],
            },
        ]
        prompt = build_judge_prompt("goal", messages)
        assert "more chars" in prompt

    def test_judge_system_prompt_exists(self):
        assert "Goal Evaluation" in JUDGE_SYSTEM_PROMPT
        assert "strict, impartial evaluator" in JUDGE_SYSTEM_PROMPT


# --- Multiple agents ---


class TestMultipleAgents:
    @pytest.mark.asyncio
    async def test_shared_plugin_different_agents(self):
        agent1 = _make_mock_agent()
        agent2 = _make_mock_agent()

        plugin = GoalLoop(goal=lambda r, a: True, max_attempts=3)
        hooks1 = _setup_plugin_with_hooks(plugin, agent1)

        # agent2 is a different agent, so it should work
        hooks2 = _setup_plugin_with_hooks(plugin, agent2)

        # Run on agent1
        hooks1["before"][0](BeforeInvocationEvent(agent=agent1))
        await hooks1["after"][0](AfterInvocationEvent(agent=agent1))

        # Run on agent2
        hooks2["before"][0](BeforeInvocationEvent(agent=agent2))
        await hooks2["after"][0](AfterInvocationEvent(agent=agent2))

        # Both should have independent results
        assert plugin.last_result(agent1).passed is True
        assert plugin.last_result(agent2).passed is True


# --- NL judge validator path ---


async def _run_validation(hooks, agent):
    """Run one goal-loop attempt: invocation start through validation."""
    hooks["before"][0](BeforeInvocationEvent(agent=agent))
    await hooks["after"][0](AfterInvocationEvent(agent=agent))


@pytest.mark.asyncio
async def test_nl_judge_passes_on_first_attempt():
    agent = _make_mock_agent()
    agent.model = MockedStructuredOutputModel(JudgeOutcome(passed=True))

    plugin = GoalLoop(goal="be concise", max_attempts=3)
    hooks = _setup_plugin_with_hooks(plugin, agent)

    await _run_validation(hooks, agent)

    assert plugin.last_result(agent) == GoalResult(
        passed=True,
        stop_reason="satisfied",
        attempts=[GoalAttempt(attempt=1, passed=True, feedback=None)],
    )
    assert agent.model.system_prompts == [JUDGE_SYSTEM_PROMPT]
    assert agent.model.prompts == [
        [{"role": "user", "content": [{"text": build_judge_prompt("be concise", agent.messages)}]}]
    ]


@pytest.mark.asyncio
async def test_nl_judge_feeds_feedback_back():
    agent = _make_mock_agent()
    agent.model = MockedStructuredOutputModel(JudgeOutcome(passed=False, feedback="too verbose"))

    plugin = GoalLoop(goal="be concise", max_attempts=3)
    hooks = _setup_plugin_with_hooks(plugin, agent)

    await _run_validation(hooks, agent)

    # Simulate the resumed invocation, which the judge now passes
    agent.model.output = JudgeOutcome(passed=True)
    await _run_validation(hooks, agent)

    assert plugin.last_result(agent) == GoalResult(
        passed=True,
        stop_reason="satisfied",
        attempts=[
            GoalAttempt(attempt=1, passed=False, feedback="too verbose"),
            GoalAttempt(attempt=2, passed=True, feedback=None),
        ],
    )


@pytest.mark.asyncio
async def test_nl_judge_model_override():
    agent = _make_mock_agent()
    agent.model = MockedStructuredOutputModel(JudgeOutcome(passed=False, feedback="host model was used"))
    custom_model = MockedStructuredOutputModel(JudgeOutcome(passed=True))

    plugin = GoalLoop(goal="be concise", max_attempts=1, judge=JudgeConfig(model=custom_model))
    hooks = _setup_plugin_with_hooks(plugin, agent)

    await _run_validation(hooks, agent)

    assert plugin.last_result(agent).passed is True
    assert custom_model.system_prompts == [JUDGE_SYSTEM_PROMPT]
    assert agent.model.prompts == []


@pytest.mark.asyncio
async def test_nl_judge_system_prompt_override():
    agent = _make_mock_agent()
    agent.model = MockedStructuredOutputModel(JudgeOutcome(passed=True))

    plugin = GoalLoop(
        goal="be concise",
        max_attempts=1,
        judge=JudgeConfig(system_prompt="CUSTOM_RUBRIC"),
    )
    hooks = _setup_plugin_with_hooks(plugin, agent)

    await _run_validation(hooks, agent)

    assert agent.model.system_prompts == ["CUSTOM_RUBRIC"]


@pytest.mark.asyncio
async def test_nl_judge_no_structured_output_fallback():
    agent = _make_mock_agent()
    agent.model = MockedStructuredOutputModel(output="not a judge outcome")

    plugin = GoalLoop(goal="be concise", max_attempts=1)
    hooks = _setup_plugin_with_hooks(plugin, agent)

    await _run_validation(hooks, agent)

    assert plugin.last_result(agent) == GoalResult(
        passed=False,
        stop_reason="max_attempts",
        attempts=[GoalAttempt(attempt=1, passed=False, feedback="Judge produced no structured outcome.")],
    )


@pytest.mark.asyncio
async def test_nl_judge_one_model_call_per_validation():
    """Each validation is its own single-message call (no prompt leakage between attempts)."""
    agent = _make_mock_agent()
    agent.model = MockedStructuredOutputModel(JudgeOutcome(passed=False, feedback="retry"))

    plugin = GoalLoop(goal="be concise", max_attempts=3)
    hooks = _setup_plugin_with_hooks(plugin, agent)

    await _run_validation(hooks, agent)
    agent.model.output = JudgeOutcome(passed=True)
    await _run_validation(hooks, agent)

    assert [len(prompt) for prompt in agent.model.prompts] == [1, 1]
