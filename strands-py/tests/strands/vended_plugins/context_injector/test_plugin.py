"""Tests for the ContextInjector plugin."""

import copy
import dataclasses
from typing import Any
from unittest.mock import MagicMock, PropertyMock, patch

import pytest

from strands import Agent, tool
from strands._context_manager.strategies.offload import Offload
from strands.agent._continuation import _ContinuationInput, add_input
from strands.hooks import AfterModelCallEvent, BeforeModelCallEvent, MessageAddedEvent
from strands.middleware.stages import InvokeModelStage
from strands.models import ModelCapabilities, ModelInfo
from strands.plugins import Plugin
from strands.vended_plugins.context_injector import ContextInjector
from strands.vended_plugins.context_injector.plugin import logger as plugin_logger
from tests.fixtures.mocked_model_provider import MockedModelProvider


def injected(text: str, source: str = "test") -> dict:
    return {"injected": {"text": text, "source": source}}


def text_turn(text: str) -> dict:
    return {"role": "assistant", "content": [{"text": text}]}


def tool_use_turn(name: str, tool_use_id: str = "tool-1") -> dict:
    return {"role": "assistant", "content": [{"toolUse": {"toolUseId": tool_use_id, "name": name, "input": {}}}]}


def capture_requests(model: MockedModelProvider, fail_first: bool = False) -> list[list[dict]]:
    """Record a copy of the messages each model call receives, optionally failing the first call."""
    requests: list[list[dict]] = []
    original_stream = model.stream

    async def stream(messages, *args, **kwargs):
        requests.append(copy.deepcopy(messages))
        if fail_first and len(requests) == 1:
            raise RuntimeError("throttled")
        async for event in original_stream(messages, *args, **kwargs):
            yield event

    model.stream = stream
    return requests


def setup(model: MockedModelProvider, render_content, **kwargs: Any) -> tuple[Agent, list[list[dict]]]:
    """An agent with one injector named ``test`` and a record of the messages each model call received."""
    trigger = kwargs.pop("trigger", None)
    agent = Agent(
        model=model,
        callback_handler=None,
        plugins=[ContextInjector(render_content, name="test", trigger=trigger)],
        **kwargs,
    )
    return agent, capture_requests(model)


def assert_each_request_extends_the_previous(requests: list[list[dict]]) -> None:
    for index in range(1, len(requests)):
        previous = requests[index - 1]
        assert requests[index][: len(previous)] == previous


def contents(messages: list[dict]) -> list[list[dict]]:
    return [message["content"] for message in messages]


class TestPluginInterface:
    def test_defaults_to_strands_context_injector_name(self):
        assert ContextInjector(lambda context: "x").name == "strands:context-injector"

    def test_honors_a_custom_name(self):
        assert ContextInjector(lambda context: "x", name="now").name == "now"

    def test_registers_invoke_model_input_middleware_on_init_agent(self):
        agent = MagicMock()
        ContextInjector(lambda context: "x").init_agent(agent)

        tru_stages = [call.args[0] for call in agent.add_middleware.call_args_list]
        assert tru_stages == [InvokeModelStage.Input]


def test_sends_the_injected_text_last_and_keeps_the_cache_point_ahead_of_it():
    model = MockedModelProvider([text_turn("Hello")])
    seen: list[dict] = []
    original_stream = model.stream

    def stream(messages, *args, **kwargs):
        seen.append(
            {
                "last_block": messages[-1]["content"][-1],
                "dynamic_trailing_blocks": kwargs.get("dynamic_trailing_blocks", 0),
            }
        )
        return original_stream(messages, *args, **kwargs)

    model.stream = stream
    agent = Agent(model=model, callback_handler=None, plugins=[ContextInjector(lambda context: "<ctx>INJECTED</ctx>")])

    agent("what is the weather?")

    assert seen == [{"last_block": {"text": "\n\n<ctx>INJECTED</ctx>"}, "dynamic_trailing_blocks": 1}]


def test_writes_the_text_into_the_latest_user_message_as_an_injected_block_sent_as_text():
    agent, requests = setup(MockedModelProvider([text_turn("ok")]), lambda context: "<memory>dark mode</memory>")

    agent("what theme?")

    assert agent.messages[0]["content"] == [{"text": "what theme?"}, injected("<memory>dark mode</memory>")]
    assert requests[0][0]["content"] == [{"text": "what theme?"}, {"text": "\n\n<memory>dark mode</memory>"}]


def test_fires_no_event_for_the_write_so_listeners_keep_the_message_as_it_was_added():
    agent, _ = setup(MockedModelProvider([text_turn("ok")]), lambda context: "reminder")
    added: list[dict] = []
    agent.hooks.add_callback(MessageAddedEvent, lambda event: added.append(copy.deepcopy(event.message)))

    agent("ask")

    assert contents(added) == [[{"text": "ask"}], [{"text": "ok"}]]
    assert agent.messages[0]["tracking_id"] == added[0]["tracking_id"]


def test_keeps_each_injector_apart_when_two_write_into_the_same_message():
    agent = Agent(
        model=MockedModelProvider([text_turn("ok")]),
        callback_handler=None,
        plugins=[
            ContextInjector(lambda context: "likes tea", name="memory"),
            ContextInjector(lambda context: "cwd: /repo", name="env"),
        ],
    )

    agent("ask")

    assert agent.messages[0]["content"] == [
        {"text": "ask"},
        injected("likes tea", "memory"),
        injected("cwd: /repo", "env"),
    ]


def test_writes_on_every_tool_result_turn_with_every_turn_and_sends_only_the_latest_text():
    todo = "v1"

    @tool
    def todo_write() -> str:
        """Save the list."""
        nonlocal todo
        todo = "v2"
        return "saved"

    model = MockedModelProvider([tool_use_turn("todo_write"), text_turn("done")])
    agent, requests = setup(model, lambda context: f"<todos>{todo}</todos>", trigger="everyTurn", tools=[todo_write])

    agent("plan the work")

    assert agent.messages[0]["content"] == [{"text": "plan the work"}, injected("<todos>v1</todos>")]
    # The tool result stays first in its message; the new list follows it.
    tool_result = {"toolResult": {"toolUseId": "tool-1", "status": "success", "content": [{"text": "saved"}]}}
    assert agent.messages[2]["content"] == [tool_result, injected("<todos>v2</todos>")]
    assert len(requests) == 2
    assert requests[1][0]["content"] == [{"text": "plan the work"}]
    assert requests[1][2]["content"] == [tool_result, {"text": "\n\n<todos>v2</todos>"}]


def test_keeps_every_request_a_prefix_of_the_next_for_a_model_that_takes_temporary_messages():
    todo = "v1"

    @tool
    def todo_write() -> str:
        """Save the list."""
        nonlocal todo
        todo = "v2"
        return "saved"

    model = MockedModelProvider([tool_use_turn("todo_write"), text_turn("done"), text_turn("again")])
    temporary = ModelInfo(capabilities=ModelCapabilities(temporary_messages=True))
    with patch.object(MockedModelProvider, "model_info", new_callable=PropertyMock, return_value=temporary):
        agent, requests = setup(
            model, lambda context: f"<todos>{todo}</todos>", trigger="everyTurn", tools=[todo_write]
        )

        agent("plan the work")
        agent("next")

    assert len(requests) == 3
    assert_each_request_extends_the_previous(requests)
    assert requests[2][-1]["content"] == [{"text": "next"}, injected("<todos>v2</todos>")]


def test_writes_on_every_user_turn_and_sends_only_the_latest_text():
    agent, requests = setup(MockedModelProvider([text_turn("one"), text_turn("two")]), lambda context: "cwd: /repo")

    agent("first")
    agent("second")

    assert agent.messages[0]["content"] == [{"text": "first"}, injected("cwd: /repo")]
    assert agent.messages[2]["content"] == [{"text": "second"}, injected("cwd: /repo")]
    assert contents(requests[1]) == [
        [{"text": "first"}],
        [{"text": "one"}],
        [{"text": "second"}, {"text": "\n\ncwd: /repo"}],
    ]


def test_keeps_injected_blocks_out_of_context_offloading():
    text = f"<agents_md>{'Keep functions small. ' * 40}</agents_md>"
    model = MockedModelProvider([text_turn("one"), text_turn("two"), text_turn("three")])
    agent, requests = setup(
        model,
        lambda context: text,
        context_manager={"strategies": [Offload.summarize("*").when(threshold=20)]},
    )

    agent("first")
    agent("second")
    agent("third")

    # Three requests means the summarizer never ran on the injected block.
    assert len(requests) == 3
    assert agent.messages[0]["content"] == [{"text": "first"}, injected(text)]


def test_writes_into_a_message_once_so_a_retry_resends_the_same_request_even_when_the_text_changes():
    renders = 0

    def render(context):
        nonlocal renders
        renders += 1
        return f"<now>{renders}</now>"

    model = MockedModelProvider([text_turn("ok")])
    agent = Agent(model=model, callback_handler=None, plugins=[ContextInjector(render, name="test")])
    requests = capture_requests(model, fail_first=True)

    def retry(event: AfterModelCallEvent) -> None:
        if event.exception:
            event.retry = True

    agent.hooks.add_callback(AfterModelCallEvent, retry)

    agent("ask")

    assert agent.messages[0]["content"] == [{"text": "ask"}, injected("<now>1</now>")]
    assert requests[1] == requests[0]
    assert renders == 1


def test_writes_nothing_when_another_hook_cancels_the_model_call():
    render = MagicMock(return_value="reminder")
    agent, _ = setup(MockedModelProvider([]), render)

    def cancel(event: BeforeModelCallEvent) -> None:
        event.cancel = "denied"

    agent.hooks.add_callback(BeforeModelCallEvent, cancel)

    agent("ask")

    assert agent.messages[0]["content"] == [{"text": "ask"}]
    render.assert_not_called()


def test_writes_into_a_user_message_another_before_model_call_event_hook_adds():
    agent, _ = setup(MockedModelProvider([text_turn("ok")]), lambda context: "reminder")

    def add_guide(event: BeforeModelCallEvent) -> None:
        event.agent.messages.append({"role": "user", "content": [{"text": "[guide] be brief"}]})

    agent.hooks.add_callback(BeforeModelCallEvent, add_guide)

    agent("ask")

    assert contents(agent.messages[:2]) == [
        [{"text": "ask"}],
        [{"text": "[guide] be brief"}, injected("reminder")],
    ]


def test_writes_into_the_result_a_background_task_delivers_before_the_model_call():
    model = MockedModelProvider([text_turn("one"), text_turn("two")])
    agent, requests = setup(model, lambda context: "reminder", trigger="everyTurn")
    agent("Run work.")

    def deliver(event: BeforeModelCallEvent) -> None:
        add_input(
            event,
            _ContinuationInput(
                args=[
                    {
                        "role": "assistant",
                        "content": [{"toolUse": {"toolUseId": "task-1", "name": "task", "input": {}}}],
                    },
                    {
                        "role": "user",
                        "content": [
                            {"toolResult": {"toolUseId": "task-1", "status": "success", "content": [{"text": "done"}]}}
                        ],
                    },
                ]
            ),
        )

    agent.hooks.add_callback(BeforeModelCallEvent, deliver)

    agent("Continue.")

    tool_result = {"toolResult": {"toolUseId": "task-1", "status": "success", "content": [{"text": "done"}]}}
    assert requests[1][-1]["content"] == [tool_result, {"text": "\n\nreminder"}]


def test_keeps_text_other_middleware_adds_for_one_call_after_the_injected_block():
    class PerCall(Plugin):
        name = "per-call"

        def init_agent(self, agent):
            async def add_text(context):
                messages = list(context.messages)
                latest = messages[-1]
                messages[-1] = {**latest, "content": [*latest["content"], {"text": "\n\nper-call"}]}
                return dataclasses.replace(context, messages=messages)

            agent.add_middleware(InvokeModelStage.Input, add_text)

    model = MockedModelProvider([text_turn("ok")])
    agent = Agent(
        model=model,
        callback_handler=None,
        plugins=[PerCall(), ContextInjector(lambda context: "reminder", name="test")],
    )
    requests = capture_requests(model, fail_first=True)

    def retry(event: AfterModelCallEvent) -> None:
        if event.exception:
            event.retry = True

    agent.hooks.add_callback(AfterModelCallEvent, retry)

    agent("ask")

    assert requests[0][0]["content"] == [{"text": "ask"}, {"text": "\n\nreminder"}, {"text": "\n\nper-call"}]
    assert requests[1] == requests[0]


def test_does_not_render_on_a_tool_result_turn_with_the_default_user_turn_trigger():
    @tool
    def lookup() -> str:
        """Look something up."""
        return "found"

    render = MagicMock(return_value="reminder")
    model = MockedModelProvider([tool_use_turn("lookup"), text_turn("done")])
    agent, requests = setup(model, render, tools=[lookup])

    agent("ask")

    assert render.call_count == 1
    assert requests[0][0]["content"] == [{"text": "ask"}, {"text": "\n\nreminder"}]
    assert requests[1][0]["content"] == [{"text": "ask"}]


def test_passes_the_conversation_state_and_the_agent_to_render_content():
    received: dict = {}

    def record(context):
        received["context"] = context
        return None

    agent, _ = setup(MockedModelProvider([text_turn("ok")]), record)

    agent("ask")

    assert [message["role"] for message in received["context"].messages] == ["user"]
    assert received["context"].state is agent.state
    assert received["context"].agent is agent


def _raise(context):
    raise ValueError("boom")


@pytest.mark.parametrize("render_content", [lambda context: "   ", _raise], ids=["returns_empty_text", "raises"])
def test_leaves_the_conversation_unchanged_when_render_content(render_content):
    agent, _ = setup(MockedModelProvider([text_turn("ok")]), render_content)

    with patch.object(plugin_logger, "warning"):
        agent("ask")

    assert agent.messages[0]["content"] == [{"text": "ask"}]
