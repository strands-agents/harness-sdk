from unittest.mock import MagicMock

import pytest
from strands.middleware.stages import InvokeModelStage

from strands_harness import create_harness
from strands_harness.plugins import Todos
from strands_harness.plugins.todos import _DEPRECATION_MESSAGE
from strands_harness.plugins.todos import Todos as TodosClass


class _Ctx:
    def __init__(self, agent):
        self.agent = agent


class _InjCtx:
    def __init__(self, agent):
        self.agent = agent
        self.state = agent.state
        self.messages = []


def _todos():
    return [
        {"content": "Read code", "activeForm": "Reading code", "status": "completed"},
        {"content": "Write tests", "activeForm": "Writing tests", "status": "in_progress"},
        {"content": "Ship", "activeForm": "Shipping", "status": "pending"},
    ]


def test_todo_write_persists_to_state_and_reports_remaining():
    agent = create_harness()
    plugin = Todos()
    result = plugin.todo_write._tool_func(todos=_todos(), tool_context=_Ctx(agent))
    assert agent.state.get("todos") == _todos()
    assert result.startswith("2 todos remaining")
    assert "[in_progress] Writing tests" in result


def test_todo_write_empty_list_clears_state():
    agent = create_harness()
    plugin = Todos()
    plugin.todo_write._tool_func(todos=_todos(), tool_context=_Ctx(agent))
    result = plugin.todo_write._tool_func(todos=[], tool_context=_Ctx(agent))
    assert result == "Todo list cleared"
    assert agent.state.get("todos") is None


def test_todo_write_empty_list_is_safe_when_never_set():
    agent = create_harness()
    result = Todos().todo_write._tool_func(todos=[], tool_context=_Ctx(agent))
    assert result == "Todo list cleared"
    assert agent.state.get("todos") is None


def test_reminder_renders_list_when_todos_present():
    agent = create_harness()
    agent.state.set("todos", _todos())
    reminder = Todos()._render_reminder(_InjCtx(agent))
    assert reminder is not None
    assert "<system-reminder>" in reminder
    assert "[completed] Read code" in reminder
    assert "[in_progress] Writing tests" in reminder


def test_reminder_is_none_when_no_todos():
    agent = create_harness()
    assert Todos()._render_reminder(_InjCtx(agent)) is None


def test_todos_plugin_contributes_todo_write_when_selected():
    agent = create_harness(builtin_plugins=["todos"])
    assert any(isinstance(p, TodosClass) for p in agent._plugin_registry._plugins.values())
    assert "todo_write" in agent.tool_registry.registry


def test_todos_not_in_defaults():
    agent = create_harness()
    assert not any(isinstance(p, TodosClass) for p in agent._plugin_registry._plugins.values())
    assert "todo_write" not in agent.tool_registry.registry


def test_todos_disabled_when_not_selected():
    agent = create_harness(builtin_plugins=[])
    assert not any(isinstance(p, TodosClass) for p in agent._plugin_registry._plugins.values())
    assert "todo_write" not in agent.tool_registry.registry


def test_unknown_builtin_plugin_raises():
    with pytest.raises(ValueError, match="Unknown built-in plugin"):
        create_harness(builtin_plugins=["nope"])


def test_registers_a_context_injector_on_init_agent():
    agent = MagicMock()

    TodosClass().init_agent(agent)

    assert [call.args[0] for call in agent.add_middleware.call_args_list] == [InvokeModelStage.Input]


def test_selecting_the_todos_builtin_warns_that_it_is_moving_to_the_sdk():
    """The harness constructs the plugin, so the notice has to survive the default warning filter."""
    with pytest.warns(UserWarning, match="strands.vended_plugins.todos") as warnings_raised:
        create_harness(builtin_plugins=["todos"])

    notices = [warning for warning in warnings_raised if _DEPRECATION_MESSAGE in str(warning.message)]
    assert [warning.category for warning in notices] == [UserWarning]


def test_the_deprecation_message_matches_the_pep_702_literal():
    # The decorator takes a literal, so the constant is a second copy; keep them identical.
    assert TodosClass.__deprecated__ == _DEPRECATION_MESSAGE
