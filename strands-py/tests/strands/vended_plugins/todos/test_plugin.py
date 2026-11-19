"""Tests for the Todos plugin."""

import copy
from unittest.mock import MagicMock

import pytest

from strands import Agent, tool
from strands.middleware.stages import InvokeModelStage
from strands.vended_plugins.todos import TodoItem, Todos
from strands.vended_plugins.todos.plugin import _DEFAULT_NAME
from tests.fixtures.mocked_model_provider import MockedModelProvider


@pytest.fixture
def agent():
    return Agent(model=MagicMock(), callback_handler=None)


@pytest.fixture
def todos() -> list[TodoItem]:
    return [
        {"content": "Read code", "activeForm": "Reading code", "status": "completed"},
        {"content": "Write tests", "activeForm": "Writing tests", "status": "in_progress"},
        {"content": "Ship", "activeForm": "Shipping", "status": "pending"},
    ]


def _tool_context(agent):
    context = MagicMock()
    context.agent = agent
    return context


def _injection_context(agent):
    context = MagicMock()
    context.agent = agent
    context.state = agent.state
    context.messages = []
    return context


def _capture_requests(model: MockedModelProvider) -> list[list[dict]]:
    """Record a copy of the messages each model call receives, as the provider receives them."""
    requests: list[list[dict]] = []
    original_stream = model.stream

    async def stream(messages, *args, **kwargs):
        requests.append(copy.deepcopy(messages))
        async for event in original_stream(messages, *args, **kwargs):
            yield event

    model.stream = stream
    return requests


def _has_reminder(request: list[dict]) -> bool:
    return any("Your current todo list" in block.get("text", "") for message in request for block in message["content"])


def test_todo_write_persists_the_list_and_reports_what_is_left(agent, todos):
    plugin = Todos()

    tru_result = plugin.todo_write._tool_func(todos=todos, tool_context=_tool_context(agent))

    assert agent.state.get("todos") == todos
    assert tru_result == "2 todos remaining\n  [completed] Read code\n  [in_progress] Writing tests\n  [pending] Ship"


def test_an_in_progress_item_without_an_active_form_falls_back_to_its_content(agent):
    todos = [{"content": "Ship", "activeForm": "", "status": "in_progress"}]

    tru_result = Todos().todo_write._tool_func(todos=todos, tool_context=_tool_context(agent))

    assert tru_result == "1 todos remaining\n  [in_progress] Ship"


def test_todo_write_with_an_empty_list_clears_the_state(agent, todos):
    plugin = Todos()
    plugin.todo_write._tool_func(todos=todos, tool_context=_tool_context(agent))

    tru_result = plugin.todo_write._tool_func(todos=[], tool_context=_tool_context(agent))

    assert tru_result == "Todo list cleared"
    assert agent.state.get("todos") is None


def test_todo_write_clears_safely_when_no_list_was_ever_set(agent):
    tru_result = Todos().todo_write._tool_func(todos=[], tool_context=_tool_context(agent))

    assert tru_result == "Todo list cleared"
    assert agent.state.get("todos") is None


def test_the_reminder_renders_the_current_list(agent, todos):
    agent.state.set("todos", todos)

    tru_reminder = Todos()._render_reminder(_injection_context(agent))

    exp_reminder = (
        "<system-reminder>\nYour current todo list:\n"
        "  [completed] Read code\n  [in_progress] Writing tests\n  [pending] Ship\n"
        "Keep it up to date with todo_write as you work.\n</system-reminder>"
    )
    assert tru_reminder == exp_reminder


def test_there_is_no_reminder_when_the_list_is_empty(agent):
    assert Todos()._render_reminder(_injection_context(agent)) is None
    assert Todos()._reminder_due(_injection_context(agent)) is False


def test_the_list_is_scoped_to_the_agent_not_the_plugin(todos):
    """One instance may be shared across agents, so the list must not live on the plugin."""
    plugin = Todos()
    first = Agent(model=MagicMock(), callback_handler=None)
    second = Agent(model=MagicMock(), callback_handler=None)

    plugin.todo_write._tool_func(todos=todos, tool_context=_tool_context(first))

    assert first.state.get("todos") == todos
    assert second.state.get("todos") is None
    assert plugin._render_reminder(_injection_context(second)) is None


def test_the_state_key_is_configurable(agent, todos):
    plugin = Todos(state_key="plan")

    plugin.todo_write._tool_func(todos=todos, tool_context=_tool_context(agent))

    assert agent.state.get("plan") == todos
    assert agent.state.get("todos") is None


def test_the_plugin_registers_its_tool():
    agent = Agent(model=MagicMock(), callback_handler=None, plugins=[Todos()])

    assert "todo_write" in agent.tool_registry.registry
    assert _DEFAULT_NAME in {plugin.name for plugin in agent._plugin_registry._plugins.values()}


def test_init_agent_registers_the_injector_as_model_input_middleware():
    agent = MagicMock()

    Todos().init_agent(agent)

    assert [call.args[0] for call in agent.add_middleware.call_args_list] == [InvokeModelStage.Input]


def test_the_plugin_name_is_configurable():
    assert Todos(name="plan").name == "plan"
    assert Todos().name == _DEFAULT_NAME


def test_a_second_instance_is_rejected_even_under_a_different_plugin_name():
    """The registry's duplicate check is on ``name``, so renaming must not get a second tool in."""
    plugins = [Todos(name="first"), Todos(name="second", state_key="other")]

    with pytest.raises(ValueError, match="tool_name=<todo_write>"):
        Agent(model=MagicMock(), callback_handler=None, plugins=plugins)


def test_the_tool_validates_the_model_facing_schema():
    """Calling ``_tool_func`` skips validation, so drive the registered tool to exercise the schema."""
    agent = Agent(model=MagicMock(), callback_handler=None, plugins=[Todos()])
    item = {"content": "Ship", "activeForm": "Shipping", "status": "pending"}

    accepted = agent.tool.todo_write(todos=[item], record_direct_tool_call=False)
    rejected = agent.tool.todo_write(todos=[{**item, "status": "nope"}], record_direct_tool_call=False)

    assert accepted["status"] == "success"
    assert rejected["status"] == "error"
    assert "todos.0.status" in rejected["content"][0]["text"]


@tool
def work() -> str:
    """Stand in for a step of the task."""
    return "ok"


def _reminded_calls(plugin: Todos, invocations: list[list[str]]) -> list[bool]:
    """Run invocations that each call the named tools in turn; report which model calls carried the reminder."""
    todos = [{"content": "Run tests", "activeForm": "Running tests", "status": "in_progress"}]
    responses = []
    for tool_names in invocations:
        for name in tool_names:
            tool_use = {
                "toolUseId": f"t{len(responses)}",
                "name": name,
                "input": {"todos": todos} if name == "todo_write" else {},
            }
            responses.append({"role": "assistant", "content": [{"toolUse": tool_use}]})
        responses.append({"role": "assistant", "content": [{"text": "Done"}]})
    model = MockedModelProvider(responses)
    requests = _capture_requests(model)
    agent = Agent(model=model, callback_handler=None, plugins=[plugin], tools=[work])

    for _ in invocations:
        agent("go")

    return [_has_reminder(request) for request in requests]


@pytest.mark.parametrize(
    ("plugin", "invocations", "exp_reminded"),
    [
        pytest.param(
            Todos(reminder_interval=1),
            [["todo_write", "work", "work"]],
            [False, False, True, True],
            id="an interval of 1 skips only the call that carries the todo_write result",
        ),
        pytest.param(
            Todos(reminder_interval=2),
            [["todo_write", "work", "work", "work", "work", "todo_write", "work", "work"]],
            [False, False, False, True, False, True, False, False, True],
            id="a todo_write result and a reminder both restart the count",
        ),
        pytest.param(
            Todos(),
            [["todo_write", *["work"] * 11]],
            [*[False] * 11, True, False],
            id="the default interval is 10",
        ),
        pytest.param(
            Todos(reminder_interval=3),
            [["todo_write", "work"], [], [], ["work"]],
            [False, False, False, False, True, False, False],
            id="a user turn neither brings the reminder forward nor restarts the count",
        ),
    ],
)
def test_the_reminder_waits_reminder_interval_model_calls_after_the_list_was_last_shown(
    plugin, invocations, exp_reminded
):
    tru_reminded = _reminded_calls(plugin, invocations)

    assert tru_reminded == exp_reminded


def test_a_list_the_conversation_does_not_show_is_reminded_at_once(todos):
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "Done"}]}])
    requests = _capture_requests(model)
    agent = Agent(model=model, callback_handler=None, plugins=[Todos()])
    agent.state.set("todos", todos)

    agent("go")

    assert [_has_reminder(request) for request in requests] == [True]


@pytest.mark.parametrize("reminder_interval", [0, -1, 2.5, True])
def test_a_reminder_interval_that_is_not_a_positive_integer_is_rejected(reminder_interval):
    with pytest.raises(ValueError, match=f"reminder_interval=<{reminder_interval}>"):
        Todos(reminder_interval=reminder_interval)
