"""Tests for the ContextManager plugin."""

import unittest.mock

import pytest

from strands._context_manager.context_manager import ContextManager
from strands._context_manager.strategies.offload import Offload
from strands._context_manager.strategies.offload.truncate import EmergencyTruncateStrategy
from strands.hooks import HookRegistry
from strands.hooks.events import AfterModelCallEvent, BeforeModelCallEvent, MessageAddedEvent
from strands.types.content import ContentBlock, Message
from strands.types.exceptions import ContextWindowOverflowException
from strands.types.tools import ToolResult, ToolUse


@pytest.fixture
def mock_agent():
    agent = unittest.mock.MagicMock()
    agent.agent_id = "test-agent"
    agent.model = unittest.mock.AsyncMock()
    agent.model.count_tokens = unittest.mock.AsyncMock(return_value=5000)
    agent.model.estimate_utilization = unittest.mock.MagicMock(return_value=0.5)
    agent.hooks = HookRegistry()
    agent.messages = [
        Message(role="user", content=[ContentBlock(text="hello")]),
        Message(role="assistant", content=[ContentBlock(text="hi")]),
    ]
    return agent


class TestContextManagerInit:
    """Tests for ContextManager initialization."""

    def test_name(self):
        cm = ContextManager()
        assert cm.name == "strands:context-manager"

    def test_default_strategies(self):
        cm = ContextManager()
        assert len(cm._strategies) == 3
        assert cm._strategies[0].name == "offload:truncate"
        assert cm._strategies[1].name == "offload:summarize"
        assert isinstance(cm._strategies[2], EmergencyTruncateStrategy)

    def test_custom_strategies(self):
        custom = [Offload.drop("*").when(threshold=500)]
        cm = ContextManager(strategies=custom)
        assert len(cm._strategies) == 2
        assert cm._strategies[0].name == "offload:drop"
        assert isinstance(cm._strategies[1], EmergencyTruncateStrategy)

    def test_init_agent_registers_hooks(self, mock_agent):
        cm = ContextManager()
        cm.init_agent(mock_agent)
        assert len(mock_agent.hooks._registered_callbacks[BeforeModelCallEvent]) >= 1
        assert len(mock_agent.hooks._registered_callbacks[AfterModelCallEvent]) >= 1


class TestContextManagerRunStrategies:
    """Tests for the strategy pipeline."""

    @pytest.mark.asyncio
    async def test_runs_strategies_on_before_model_call(self, mock_agent):
        strategy = unittest.mock.AsyncMock()
        strategy.name = "mock-strategy"
        strategy.init = unittest.mock.MagicMock()
        strategy.apply = unittest.mock.AsyncMock(return_value=False)
        cm = ContextManager(strategies=[strategy])
        cm.init_agent(mock_agent)

        event = BeforeModelCallEvent(agent=mock_agent, projected_input_tokens=5000)
        await mock_agent.hooks.invoke_callbacks_async(event)
        strategy.apply.assert_called_once()

    @pytest.mark.asyncio
    async def test_overflow_retry_triggers_strategies(self, mock_agent):
        strategy = unittest.mock.AsyncMock()
        strategy.name = "mock-strategy"
        strategy.init = unittest.mock.MagicMock()
        strategy.apply = unittest.mock.AsyncMock(return_value=True)
        cm = ContextManager(strategies=[strategy])
        cm.init_agent(mock_agent)

        event = AfterModelCallEvent(
            agent=mock_agent,
            exception=ContextWindowOverflowException("overflow"),
        )
        await mock_agent.hooks.invoke_callbacks_async(event)
        assert event.retry is True

    @pytest.mark.asyncio
    async def test_overflow_retry_cap_at_three(self, mock_agent):
        strategy = unittest.mock.AsyncMock()
        strategy.name = "mock-strategy"
        strategy.init = unittest.mock.MagicMock()
        strategy.apply = unittest.mock.AsyncMock(return_value=True)
        cm = ContextManager(strategies=[strategy])
        cm.init_agent(mock_agent)

        for _ in range(3):
            event = AfterModelCallEvent(
                agent=mock_agent,
                exception=ContextWindowOverflowException("overflow"),
            )
            await mock_agent.hooks.invoke_callbacks_async(event)
            assert event.retry is True

        event = AfterModelCallEvent(
            agent=mock_agent,
            exception=ContextWindowOverflowException("overflow"),
        )
        await mock_agent.hooks.invoke_callbacks_async(event)
        assert event.retry is not True

    @pytest.mark.asyncio
    async def test_retry_counter_resets_on_success(self, mock_agent):
        strategy = unittest.mock.AsyncMock()
        strategy.name = "mock-strategy"
        strategy.init = unittest.mock.MagicMock()
        strategy.apply = unittest.mock.AsyncMock(return_value=True)
        cm = ContextManager(strategies=[strategy])
        cm.init_agent(mock_agent)

        for _ in range(2):
            event = AfterModelCallEvent(
                agent=mock_agent,
                exception=ContextWindowOverflowException("overflow"),
            )
            await mock_agent.hooks.invoke_callbacks_async(event)

        event = AfterModelCallEvent(agent=mock_agent, exception=None)
        await mock_agent.hooks.invoke_callbacks_async(event)

        for _ in range(3):
            event = AfterModelCallEvent(
                agent=mock_agent,
                exception=ContextWindowOverflowException("overflow"),
            )
            await mock_agent.hooks.invoke_callbacks_async(event)
            assert event.retry is True

    @pytest.mark.asyncio
    async def test_no_retry_when_strategies_dont_act(self, mock_agent):
        strategy = unittest.mock.AsyncMock()
        strategy.name = "mock-strategy"
        strategy.init = unittest.mock.MagicMock()
        strategy.apply = unittest.mock.AsyncMock(return_value=False)
        cm = ContextManager(strategies=[strategy])
        cm.init_agent(mock_agent)

        event = AfterModelCallEvent(
            agent=mock_agent,
            exception=ContextWindowOverflowException("overflow"),
        )
        await mock_agent.hooks.invoke_callbacks_async(event)
        assert event.retry is not True

    @pytest.mark.asyncio
    async def test_strategy_exception_is_caught(self, mock_agent):
        strategy = unittest.mock.AsyncMock()
        strategy.name = "failing-strategy"
        strategy.init = unittest.mock.MagicMock()
        strategy.apply = unittest.mock.AsyncMock(side_effect=RuntimeError("oops"))
        cm = ContextManager(strategies=[strategy])
        cm.init_agent(mock_agent)

        event = BeforeModelCallEvent(agent=mock_agent, projected_input_tokens=5000)
        await mock_agent.hooks.invoke_callbacks_async(event)

    @pytest.mark.asyncio
    async def test_count_tokens_failure_skips_strategies(self, mock_agent):
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(side_effect=RuntimeError("counting failed"))
        strategy = unittest.mock.AsyncMock()
        strategy.name = "mock-strategy"
        strategy.init = unittest.mock.MagicMock()
        strategy.apply = unittest.mock.AsyncMock(return_value=False)
        cm = ContextManager(strategies=[strategy])
        cm.init_agent(mock_agent)

        event = AfterModelCallEvent(
            agent=mock_agent,
            exception=ContextWindowOverflowException("overflow"),
        )
        await mock_agent.hooks.invoke_callbacks_async(event)
        strategy.apply.assert_not_called()
        assert event.retry is not True

    @pytest.mark.asyncio
    async def test_recomputes_utilization_after_strategy_acts(self, mock_agent):
        mock_agent.model.estimate_utilization = unittest.mock.MagicMock(side_effect=[0.9, 0.4])
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(side_effect=[9000, 4000])

        strategy1 = unittest.mock.AsyncMock()
        strategy1.name = "s1"
        strategy1.init = unittest.mock.MagicMock()
        strategy1.apply = unittest.mock.AsyncMock(return_value=True)

        strategy2 = unittest.mock.AsyncMock()
        strategy2.name = "s2"
        strategy2.init = unittest.mock.MagicMock()
        strategy2.apply = unittest.mock.AsyncMock(return_value=False)

        cm = ContextManager(strategies=[strategy1, strategy2])
        cm.init_agent(mock_agent)

        event = BeforeModelCallEvent(agent=mock_agent, projected_input_tokens=9000)
        await mock_agent.hooks.invoke_callbacks_async(event)

        call_args = strategy2.apply.call_args[0][0]
        assert call_args.utilization == 0.4


class TestAgentIntegration:
    """Tests for ContextManager integration with the Agent._resolve_context_manager."""

    def test_context_manager_false_returns_null_conversation_manager(self):
        from strands.agent.agent import Agent
        from strands.agent.conversation_manager import NullConversationManager

        resolved_cm, resolved_plugins = Agent._resolve_context_manager(False, None, None)
        assert isinstance(resolved_cm, NullConversationManager)

    def test_context_manager_instance_appends_to_plugins(self):
        from strands.agent.agent import Agent
        from strands.agent.conversation_manager import NullConversationManager

        cm = ContextManager()
        resolved_cm, resolved_plugins = Agent._resolve_context_manager(cm, None, None)
        assert isinstance(resolved_cm, NullConversationManager)
        assert cm in resolved_plugins

    def test_context_manager_none_returns_none(self):
        from strands.agent.agent import Agent

        resolved_cm, resolved_plugins = Agent._resolve_context_manager(None, None, None)
        assert resolved_cm is None
        assert resolved_plugins is None


class TestContextManagerStashHook:
    """Tests for the stash MessageAddedEvent hook."""

    @pytest.mark.asyncio
    async def test_stash_hook_persists_tool_result(self, mock_agent):
        mock_agent.session_id = "test-session"
        mock_agent.storage = None
        cm = ContextManager(stash=True)
        cm.init_agent(mock_agent)

        block = ContentBlock(
            toolResult=ToolResult(toolUseId="tu-1", status="success", content=[{"text": "data"}])
        )
        message = Message(role="user", content=[block])
        event = MessageAddedEvent(agent=mock_agent, message=message)
        await mock_agent.hooks.invoke_callbacks_async(event)

        result = await cm._stash.retrieve("tu-1_0")
        assert result is not None
        assert result["text"] == "data"

    @pytest.mark.asyncio
    async def test_stash_hook_tracks_retrieval_tool_use_ids(self, mock_agent):
        mock_agent.session_id = "test-session"
        mock_agent.storage = None
        cm = ContextManager(stash=True)
        cm.init_agent(mock_agent)

        message = Message(
            role="assistant",
            content=[ContentBlock(toolUse=ToolUse(toolUseId="tu-ret", name="retrieve_context", input={}))],
        )
        event = MessageAddedEvent(agent=mock_agent, message=message)
        await mock_agent.hooks.invoke_callbacks_async(event)

        assert "tu-ret" in cm._retrieval_tool_use_ids


class TestStashBackfill:
    """Tests for backfilling the stash from pre-existing agent messages."""

    @pytest.mark.asyncio
    async def test_backfills_pre_existing_messages_on_first_strategy_run(self):
        agent = unittest.mock.MagicMock()
        agent.agent_id = "test-agent"
        agent.session_id = "test-session"
        agent.storage = None
        agent.model = unittest.mock.AsyncMock()
        agent.model.count_tokens = unittest.mock.AsyncMock(return_value=100)
        agent.model.estimate_utilization = unittest.mock.MagicMock(return_value=0.1)
        agent.hooks = HookRegistry()
        agent.messages = [
            Message(role="user", content=[ContentBlock(text="seed message")]),
            Message(
                role="user",
                content=[
                    ContentBlock(
                        toolResult=ToolResult(
                            toolUseId="pre-tu-1",
                            status="success",
                            content=[{"text": "pre-existing result"}],
                        )
                    )
                ],
            ),
        ]

        cm = ContextManager(strategies=[], stash=True)
        cm.init_agent(agent)

        event = BeforeModelCallEvent(agent=agent, projected_input_tokens=100)
        await agent.hooks.invoke_callbacks_async(event)

        result = await cm._stash.retrieve("pre-tu-1_0")
        assert result is not None
        assert result["text"] == "pre-existing result"

    @pytest.mark.asyncio
    async def test_backfill_runs_only_once(self):
        agent = unittest.mock.MagicMock()
        agent.agent_id = "test-agent"
        agent.session_id = "test-session"
        agent.storage = None
        agent.model = unittest.mock.AsyncMock()
        agent.model.count_tokens = unittest.mock.AsyncMock(return_value=100)
        agent.model.estimate_utilization = unittest.mock.MagicMock(return_value=0.1)
        agent.hooks = HookRegistry()
        agent.messages = [
            Message(role="user", content=[ContentBlock(text="hello")]),
        ]

        cm = ContextManager(strategies=[], stash=True)
        cm.init_agent(agent)

        event = BeforeModelCallEvent(agent=agent, projected_input_tokens=100)
        await agent.hooks.invoke_callbacks_async(event)
        assert cm._backfill_done is True

        with unittest.mock.patch.object(cm._stash, "store_message") as mock_store:
            event = BeforeModelCallEvent(agent=agent, projected_input_tokens=100)
            await agent.hooks.invoke_callbacks_async(event)
            mock_store.assert_not_called()

    @pytest.mark.asyncio
    async def test_no_backfill_when_stash_disabled(self):
        agent = unittest.mock.MagicMock()
        agent.agent_id = "test-agent"
        agent.session_id = "test-session"
        agent.storage = None
        agent.model = unittest.mock.AsyncMock()
        agent.model.count_tokens = unittest.mock.AsyncMock(return_value=100)
        agent.model.estimate_utilization = unittest.mock.MagicMock(return_value=0.1)
        agent.hooks = HookRegistry()
        agent.messages = [
            Message(role="user", content=[ContentBlock(text="hello")]),
        ]

        cm = ContextManager(strategies=[], stash=False)
        cm.init_agent(agent)

        event = BeforeModelCallEvent(agent=agent, projected_input_tokens=100)
        await agent.hooks.invoke_callbacks_async(event)
        assert cm._stash is None


class TestStrategyInitFallback:
    """Tests for strategy init() TypeError fallback."""

    def test_strategy_without_stash_kwarg_still_inits(self, mock_agent):
        class CustomStrategy:
            @property
            def name(self):
                return "custom"

            def init(self, agent):
                self.initialized = True

            async def apply(self, context):
                return False

        strategy = CustomStrategy()
        cm = ContextManager(strategies=[strategy])
        cm.init_agent(mock_agent)
        assert strategy.initialized is True
