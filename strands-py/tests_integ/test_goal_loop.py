"""Integration tests for GoalLoop.

Design principle: assertions must be deterministic regardless of model output.
We never assert "the model produced X" — only structural properties we control
via the validator (it's user code, fully deterministic). The model's role here
is to produce *some* assistant turn so the plugin's machinery (validation,
resume, snapshot/restore) executes against a real agent loop end-to-end.
"""

from strands import Agent
from strands.vended_plugins.goal import GoalLoop


class TestStandardRefinementLoop:
    def test_runs_n_attempts_and_surfaces_last_result(self):
        """Force exactly 2 attempts: fail the first, pass the second."""
        calls = 0

        def validator(response, agent):
            nonlocal calls
            calls += 1
            if calls == 1:
                return {"passed": False, "feedback": "TRIGGER_RETRY_MARKER"}
            return True

        plugin = GoalLoop(
            goal=validator,
            max_attempts=5,
            name="integ-standard",
        )

        agent = Agent(plugins=[plugin], callback_handler=None)
        agent("Say hello.")

        result = plugin.last_result(agent)
        assert result is not None
        assert result.passed is True
        assert result.stop_reason == "satisfied"
        assert len(result.attempts) == 2
        assert result.attempts[0].passed is False
        assert result.attempts[0].feedback == "TRIGGER_RETRY_MARKER"
        assert result.attempts[1].passed is True

        # Standard mode keeps both assistant turns in the transcript and the
        # validator feedback is surfaced as a user message between them.
        roles = [m["role"] for m in agent.messages]
        assert roles == ["user", "assistant", "user", "assistant"]
        user_texts = [
            block["text"] for m in agent.messages if m["role"] == "user" for block in m["content"] if "text" in block
        ]
        assert any("TRIGGER_RETRY_MARKER" in t for t in user_texts)


class TestPreserveContextFalse:
    def test_restores_transcript_between_attempts(self):
        """Force 3 attempts: fail twice, pass third. Only the final assistant turn survives."""
        calls = 0

        def validator(response, agent):
            nonlocal calls
            calls += 1
            if calls < 3:
                return {"passed": False, "feedback": f"force-retry-{calls}"}
            return True

        plugin = GoalLoop(
            goal=validator,
            max_attempts=5,
            preserve_context=False,
            name="integ-fresh-context",
        )

        agent = Agent(plugins=[plugin], callback_handler=None)
        agent("Say hello.")

        result = plugin.last_result(agent)
        assert result is not None
        assert result.passed is True
        assert result.stop_reason == "satisfied"
        assert len(result.attempts) == 3
        assert result.attempts[0].feedback == "force-retry-1"
        assert result.attempts[1].feedback == "force-retry-2"
        assert result.attempts[2].passed is True

        # The defining property of fresh-context mode: every failed attempt's
        # assistant turn was popped on restart, so only the final successful
        # attempt's assistant turn remains.
        assistant_turns = [m for m in agent.messages if m["role"] == "assistant"]
        assert len(assistant_turns) == 1

        # Transcript shape: original input, latest feedback as user message,
        # then the successful reply.
        roles = [m["role"] for m in agent.messages]
        assert roles == ["user", "user", "assistant"]
