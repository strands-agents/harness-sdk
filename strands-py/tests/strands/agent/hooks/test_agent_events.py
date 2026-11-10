import asyncio
import unittest.mock
from unittest.mock import ANY, AsyncMock, MagicMock, call, patch

import pytest
from pydantic import BaseModel

import strands
from strands import Agent
from strands.agent import AgentResult
from strands.models import BedrockModel
from strands.types._events import TypedEvent
from strands.types.exceptions import ModelThrottledException
from tests.fixtures.mocked_model_provider import MockedModelProvider


@strands.tool
def normal_tool(agent: Agent):
    return f"Done with synchronous {agent.name}!"


@strands.tool
async def async_tool(agent: Agent):
    await asyncio.sleep(0.1)
    return f"Done with asynchronous {agent.name}!"


@strands.tool
async def streaming_tool():
    await asyncio.sleep(0.2)
    yield {"tool_streaming": True}
    yield "Final result"


@pytest.fixture
def mock_sleep():
    with patch.object(strands.event_loop._retry.asyncio, "sleep", new_callable=AsyncMock) as mock:
        yield mock


any_props = {
    "agent": ANY,
    "event_loop_cycle_id": ANY,
    "event_loop_cycle_span": ANY,
    "event_loop_cycle_trace": ANY,
    "request_state": {},
}


@pytest.mark.asyncio
async def test_stream_e2e_success(alist):
    mock_provider = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [
                    {"text": "Okay invoking normal tool"},
                    {"toolUse": {"name": "normal_tool", "toolUseId": "123", "input": {}}},
                ],
            },
            {
                "role": "assistant",
                "content": [
                    {"text": "Invoking async tool"},
                    {"toolUse": {"name": "async_tool", "toolUseId": "1234", "input": {}}},
                ],
            },
            {
                "role": "assistant",
                "content": [
                    {"text": "Invoking streaming tool"},
                    {"toolUse": {"name": "streaming_tool", "toolUseId": "12345", "input": {}}},
                ],
            },
            {
                "role": "assistant",
                "content": [
                    {"text": "I invoked the tools!"},
                ],
            },
        ]
    )

    mock_callback = unittest.mock.Mock()
    agent = Agent(model=mock_provider, tools=[async_tool, normal_tool, streaming_tool], callback_handler=mock_callback)

    stream = agent.stream_async("Do the stuff", invocation_state={"arg1": 1013})

    tool_config = {
        "toolChoice": {"auto": {}},
        "tools": [
            {
                "toolSpec": {
                    "description": "async_tool",
                    "inputSchema": {"json": {"properties": {}, "required": [], "type": "object"}},
                    "name": "async_tool",
                }
            },
            {
                "toolSpec": {
                    "description": "normal_tool",
                    "inputSchema": {"json": {"properties": {}, "required": [], "type": "object"}},
                    "name": "normal_tool",
                }
            },
            {
                "toolSpec": {
                    "description": "streaming_tool",
                    "inputSchema": {"json": {"properties": {}, "required": [], "type": "object"}},
                    "name": "streaming_tool",
                }
            },
        ],
    }

    tru_events = await alist(stream)
    exp_events = [
        # Cycle 1: Initialize and invoke normal_tool
        {"arg1": 1013, "init_event_loop": True},
        {"start": True},
        {"start_event_loop": True},
        {"event": {"messageStart": {"role": "assistant"}}},
        {"event": {"contentBlockStart": {"start": {}}}},
        {"event": {"contentBlockDelta": {"delta": {"text": "Okay invoking normal tool"}}}},
        {
            **any_props,
            "arg1": 1013,
            "data": "Okay invoking normal tool",
            "delta": {"text": "Okay invoking normal tool"},
        },
        {"event": {"contentBlockStop": {}}},
        {"event": {"contentBlockStart": {"start": {"toolUse": {"name": "normal_tool", "toolUseId": "123"}}}}},
        {"event": {"contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}}},
        {
            **any_props,
            "arg1": 1013,
            "current_tool_use": {"input": {}, "name": "normal_tool", "toolUseId": "123"},
            "delta": {"toolUse": {"input": "{}"}},
            "type": "tool_use_stream",
        },
        {"event": {"contentBlockStop": {}}},
        {"event": {"messageStop": {"stopReason": "tool_use"}}},
        {
            "message": {
                "content": [
                    {"text": "Okay invoking normal tool"},
                    {"toolUse": {"input": {}, "name": "normal_tool", "toolUseId": "123"}},
                ],
                "role": "assistant",
                "metadata": ANY,
                "tracking_id": ANY,
            }
        },
        {
            "message": {
                "content": [
                    {
                        "toolResult": {
                            "content": [{"text": "Done with synchronous Strands Agents!"}],
                            "status": "success",
                            "toolUseId": "123",
                        }
                    },
                ],
                "role": "user",
                "tracking_id": ANY,
            }
        },
        # Cycle 2: Invoke async_tool
        {"start": True},
        {"start": True},
        {"start_event_loop": True},
        {"event": {"messageStart": {"role": "assistant"}}},
        {"event": {"contentBlockStart": {"start": {}}}},
        {"event": {"contentBlockDelta": {"delta": {"text": "Invoking async tool"}}}},
        {
            **any_props,
            "arg1": 1013,
            "data": "Invoking async tool",
            "delta": {"text": "Invoking async tool"},
            "event_loop_parent_cycle_id": ANY,
            "messages": ANY,
            "model": ANY,
            "system_prompt": None,
            "tool_config": tool_config,
        },
        {"event": {"contentBlockStop": {}}},
        {"event": {"contentBlockStart": {"start": {"toolUse": {"name": "async_tool", "toolUseId": "1234"}}}}},
        {"event": {"contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}}},
        {
            **any_props,
            "arg1": 1013,
            "current_tool_use": {"input": {}, "name": "async_tool", "toolUseId": "1234"},
            "delta": {"toolUse": {"input": "{}"}},
            "event_loop_parent_cycle_id": ANY,
            "messages": ANY,
            "model": ANY,
            "system_prompt": None,
            "tool_config": tool_config,
            "type": "tool_use_stream",
        },
        {"event": {"contentBlockStop": {}}},
        {"event": {"messageStop": {"stopReason": "tool_use"}}},
        {
            "message": {
                "content": [
                    {"text": "Invoking async tool"},
                    {"toolUse": {"input": {}, "name": "async_tool", "toolUseId": "1234"}},
                ],
                "role": "assistant",
                "metadata": ANY,
                "tracking_id": ANY,
            }
        },
        {
            "message": {
                "content": [
                    {
                        "toolResult": {
                            "content": [{"text": "Done with asynchronous Strands Agents!"}],
                            "status": "success",
                            "toolUseId": "1234",
                        }
                    },
                ],
                "role": "user",
                "tracking_id": ANY,
            }
        },
        # Cycle 3: Invoke streaming_tool
        {"start": True},
        {"start": True},
        {"start_event_loop": True},
        {"event": {"messageStart": {"role": "assistant"}}},
        {"event": {"contentBlockStart": {"start": {}}}},
        {"event": {"contentBlockDelta": {"delta": {"text": "Invoking streaming tool"}}}},
        {
            **any_props,
            "arg1": 1013,
            "data": "Invoking streaming tool",
            "delta": {"text": "Invoking streaming tool"},
            "event_loop_parent_cycle_id": ANY,
            "messages": ANY,
            "model": ANY,
            "system_prompt": None,
            "tool_config": tool_config,
        },
        {"event": {"contentBlockStop": {}}},
        {"event": {"contentBlockStart": {"start": {"toolUse": {"name": "streaming_tool", "toolUseId": "12345"}}}}},
        {"event": {"contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}}},
        {
            **any_props,
            "arg1": 1013,
            "current_tool_use": {"input": {}, "name": "streaming_tool", "toolUseId": "12345"},
            "delta": {"toolUse": {"input": "{}"}},
            "event_loop_parent_cycle_id": ANY,
            "messages": ANY,
            "model": ANY,
            "system_prompt": None,
            "tool_config": tool_config,
            "type": "tool_use_stream",
        },
        {"event": {"contentBlockStop": {}}},
        {"event": {"messageStop": {"stopReason": "tool_use"}}},
        {
            "message": {
                "content": [
                    {"text": "Invoking streaming tool"},
                    {"toolUse": {"input": {}, "name": "streaming_tool", "toolUseId": "12345"}},
                ],
                "role": "assistant",
                "metadata": ANY,
                "tracking_id": ANY,
            }
        },
        {
            "tool_stream_event": {
                "data": {"tool_streaming": True},
                "tool_use": {"input": {}, "name": "streaming_tool", "toolUseId": "12345"},
            },
            "type": "tool_stream",
        },
        {
            "tool_stream_event": {
                "data": "Final result",
                "tool_use": {"input": {}, "name": "streaming_tool", "toolUseId": "12345"},
            },
            "type": "tool_stream",
        },
        {
            "message": {
                "content": [
                    {"toolResult": {"content": [{"text": "Final result"}], "status": "success", "toolUseId": "12345"}}
                ],
                "role": "user",
                "tracking_id": ANY,
            }
        },
        # Cycle 4: Final response
        {"start": True},
        {"start": True},
        {"start_event_loop": True},
        {"event": {"messageStart": {"role": "assistant"}}},
        {"event": {"contentBlockStart": {"start": {}}}},
        {"event": {"contentBlockDelta": {"delta": {"text": "I invoked the tools!"}}}},
        {
            **any_props,
            "arg1": 1013,
            "data": "I invoked the tools!",
            "delta": {"text": "I invoked the tools!"},
            "event_loop_parent_cycle_id": ANY,
            "messages": ANY,
            "model": ANY,
            "system_prompt": None,
            "tool_config": tool_config,
        },
        {"event": {"contentBlockStop": {}}},
        {"event": {"messageStop": {"stopReason": "end_turn"}}},
        {
            "message": {
                "content": [{"text": "I invoked the tools!"}],
                "role": "assistant",
                "metadata": ANY,
                "tracking_id": ANY,
            }
        },
        {
            "result": AgentResult(
                stop_reason="end_turn",
                message={
                    "content": [{"text": "I invoked the tools!"}],
                    "role": "assistant",
                    "metadata": ANY,
                    "tracking_id": ANY,
                },
                metrics=ANY,
                state={},
            ),
        },
    ]
    assert tru_events == exp_events

    exp_calls = [call(**event) for event in exp_events]
    act_calls = mock_callback.call_args_list
    assert act_calls == exp_calls

    # Ensure that all events coming out of the agent are *not* typed events
    typed_events = [event for event in tru_events if isinstance(event, TypedEvent)]
    assert typed_events == []


@pytest.mark.asyncio
async def test_stream_e2e_throttle_and_redact(alist, mock_sleep):
    model = MagicMock()
    model.stream.side_effect = [
        ModelThrottledException("ThrottlingException | ConverseStream"),
        ModelThrottledException("ThrottlingException | ConverseStream"),
        MockedModelProvider(
            [
                {"redactedUserContent": "BLOCKED!", "redactedAssistantContent": "INPUT BLOCKED!"},
            ]
        ).stream([]),
    ]

    mock_callback = unittest.mock.Mock()
    agent = Agent(model=model, tools=[normal_tool], callback_handler=mock_callback)

    stream = agent.stream_async("Do the stuff", invocation_state={"arg1": 1013})

    # Base object with common properties
    throttle_props = {
        **any_props,
        "arg1": 1013,
    }

    tru_events = await alist(stream)
    exp_events = [
        {"arg1": 1013, "init_event_loop": True},
        {"start": True},
        {"start_event_loop": True},
        {"event_loop_throttled_delay": 4, **throttle_props},
        {"event_loop_throttled_delay": 8, **throttle_props},
        {"event": {"messageStart": {"role": "assistant"}}},
        {"event": {"redactContent": {"redactUserContentMessage": "BLOCKED!"}}},
        {"event": {"contentBlockStart": {"start": {}}}},
        {"event": {"contentBlockDelta": {"delta": {"text": "INPUT BLOCKED!"}}}},
        {
            **any_props,
            "arg1": 1013,
            "data": "INPUT BLOCKED!",
            "delta": {"text": "INPUT BLOCKED!"},
        },
        {"event": {"contentBlockStop": {}}},
        {"event": {"messageStop": {"stopReason": "guardrail_intervened"}}},
        {
            "message": {
                "content": [{"text": "INPUT BLOCKED!"}],
                "role": "assistant",
                "metadata": ANY,
                "tracking_id": ANY,
            }
        },
        {
            "result": AgentResult(
                stop_reason="guardrail_intervened",
                message={
                    "content": [{"text": "INPUT BLOCKED!"}],
                    "role": "assistant",
                    "metadata": ANY,
                    "tracking_id": ANY,
                },
                metrics=ANY,
                state={},
            ),
        },
    ]
    assert tru_events == exp_events

    exp_calls = [call(**event) for event in exp_events]
    act_calls = mock_callback.call_args_list
    assert act_calls == exp_calls

    # Ensure that all events coming out of the agent are *not* typed events
    typed_events = [event for event in tru_events if isinstance(event, TypedEvent)]
    assert typed_events == []


@pytest.mark.asyncio
async def test_stream_e2e_reasoning_redacted_content(alist):
    mock_provider = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [
                    {"reasoningContent": {"redactedContent": b"test_redacted_data"}},
                    {"text": "Response with redacted reasoning"},
                ],
            },
        ]
    )

    mock_callback = unittest.mock.Mock()
    agent = Agent(model=mock_provider, callback_handler=mock_callback)

    stream = agent.stream_async("Test redacted content")

    tru_events = await alist(stream)
    exp_events = [
        {"init_event_loop": True},
        {"start": True},
        {"start_event_loop": True},
        {"event": {"messageStart": {"role": "assistant"}}},
        {"event": {"contentBlockStart": {"start": {}}}},
        {"event": {"contentBlockDelta": {"delta": {"reasoningContent": {"redactedContent": b"test_redacted_data"}}}}},
        {
            **any_props,
            "reasoningRedactedContent": b"test_redacted_data",
            "delta": {"reasoningContent": {"redactedContent": b"test_redacted_data"}},
            "reasoning": True,
        },
        {"event": {"contentBlockStop": {}}},
        {"event": {"contentBlockStart": {"start": {}}}},
        {"event": {"contentBlockDelta": {"delta": {"text": "Response with redacted reasoning"}}}},
        {
            **any_props,
            "data": "Response with redacted reasoning",
            "delta": {"text": "Response with redacted reasoning"},
        },
        {"event": {"contentBlockStop": {}}},
        {"event": {"messageStop": {"stopReason": "end_turn"}}},
        {
            "message": {
                "content": [
                    {"reasoningContent": {"redactedContent": b"test_redacted_data"}},
                    {"text": "Response with redacted reasoning"},
                ],
                "role": "assistant",
                "metadata": ANY,
                "tracking_id": ANY,
            }
        },
        {
            "result": AgentResult(
                stop_reason="end_turn",
                message={
                    "content": [
                        {"reasoningContent": {"redactedContent": b"test_redacted_data"}},
                        {"text": "Response with redacted reasoning"},
                    ],
                    "role": "assistant",
                    "metadata": ANY,
                    "tracking_id": ANY,
                },
                metrics=ANY,
                state={},
            ),
        },
    ]
    assert tru_events == exp_events

    exp_calls = [call(**event) for event in exp_events]
    act_calls = mock_callback.call_args_list
    assert act_calls == exp_calls

    # Ensure that all events coming out of the agent are *not* typed events
    typed_events = [event for event in tru_events if isinstance(event, TypedEvent)]
    assert typed_events == []


@pytest.mark.asyncio
async def test_event_loop_cycle_text_response_throttling_early_end(
    agenerator,
    alist,
    mock_sleep,
):
    model = MagicMock()
    model.stream.side_effect = [
        ModelThrottledException("ThrottlingException | ConverseStream"),
        ModelThrottledException("ThrottlingException | ConverseStream"),
        ModelThrottledException("ThrottlingException | ConverseStream"),
        ModelThrottledException("ThrottlingException | ConverseStream"),
        ModelThrottledException("ThrottlingException | ConverseStream"),
        ModelThrottledException("ThrottlingException | ConverseStream"),
    ]

    mock_callback = unittest.mock.Mock()
    with pytest.raises(ModelThrottledException):
        agent = Agent(model=model, callback_handler=mock_callback)

        # Because we're throwing an exception, we manually collect the items here
        tru_events = []
        stream = agent.stream_async("Do the stuff", invocation_state={"arg1": 1013})
        async for event in stream:
            tru_events.append(event)

    # Base object with common properties
    common_props = {
        **any_props,
        "arg1": 1013,
    }

    exp_events = [
        {"init_event_loop": True, "arg1": 1013},
        {"start": True},
        {"start_event_loop": True},
        {"event_loop_throttled_delay": 4, **common_props},
        {"event_loop_throttled_delay": 8, **common_props},
        {"event_loop_throttled_delay": 16, **common_props},
        {"event_loop_throttled_delay": 32, **common_props},
        {"event_loop_throttled_delay": 64, **common_props},
        {"force_stop": True, "force_stop_reason": "ThrottlingException | ConverseStream"},
    ]

    assert tru_events == exp_events

    exp_calls = [call(**event) for event in exp_events]
    act_calls = mock_callback.call_args_list
    assert act_calls == exp_calls

    # Ensure that all events coming out of the agent are *not* typed events
    typed_events = [event for event in tru_events if isinstance(event, TypedEvent)]
    assert typed_events == []


@pytest.mark.filterwarnings("ignore:Agent.structured_output_async method is deprecated:DeprecationWarning")
@pytest.mark.asyncio
async def test_structured_output(agenerator):
    # we use bedrock here as it uses the tool implementation
    model = BedrockModel()
    model.stream = MagicMock()
    model.stream.return_value = agenerator(
        [
            {
                "contentBlockStart": {
                    "start": {"toolUse": {"toolUseId": "tooluse_efwXnrK_S6qTyxzcq1IUMQ", "name": "Person"}},
                    "contentBlockIndex": 0,
                }
            },
            {"contentBlockDelta": {"delta": {"toolUse": {"input": ""}}, "contentBlockIndex": 0}},
            {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"na'}}, "contentBlockIndex": 0}},
            {"contentBlockDelta": {"delta": {"toolUse": {"input": 'me"'}}, "contentBlockIndex": 0}},
            {"contentBlockDelta": {"delta": {"toolUse": {"input": ': "J'}}, "contentBlockIndex": 0}},
            {"contentBlockDelta": {"delta": {"toolUse": {"input": 'ohn"'}}, "contentBlockIndex": 0}},
            {"contentBlockDelta": {"delta": {"toolUse": {"input": ', "age": 3'}}, "contentBlockIndex": 0}},
            {"contentBlockDelta": {"delta": {"toolUse": {"input": "1}"}}, "contentBlockIndex": 0}},
            {"contentBlockStop": {"contentBlockIndex": 0}},
            {"messageStop": {"stopReason": "tool_use"}},
            {
                "metadata": {
                    "usage": {"inputTokens": 407, "outputTokens": 53, "totalTokens": 460},
                    "metrics": {"latencyMs": 1572},
                }
            },
        ]
    )

    mock_callback = unittest.mock.Mock()
    agent = Agent(model=model, callback_handler=mock_callback)

    class Person(BaseModel):
        name: str
        age: float

    await agent.structured_output_async(Person, "John is 31")

    exp_events = [
        {
            "event": {
                "contentBlockStart": {
                    "start": {"toolUse": {"toolUseId": "tooluse_efwXnrK_S6qTyxzcq1IUMQ", "name": "Person"}},
                    "contentBlockIndex": 0,
                }
            }
        },
        {"event": {"contentBlockDelta": {"delta": {"toolUse": {"input": ""}}, "contentBlockIndex": 0}}},
        {
            "type": "tool_use_stream",
            "delta": {"toolUse": {"input": ""}},
            "current_tool_use": {
                "toolUseId": "tooluse_efwXnrK_S6qTyxzcq1IUMQ",
                "name": "Person",
                "input": {"name": "John", "age": 31},
            },
        },
        {"event": {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"na'}}, "contentBlockIndex": 0}}},
        {
            "type": "tool_use_stream",
            "delta": {"toolUse": {"input": '{"na'}},
            "current_tool_use": {
                "toolUseId": "tooluse_efwXnrK_S6qTyxzcq1IUMQ",
                "name": "Person",
                "input": {"name": "John", "age": 31},
            },
        },
        {"event": {"contentBlockDelta": {"delta": {"toolUse": {"input": 'me"'}}, "contentBlockIndex": 0}}},
        {
            "type": "tool_use_stream",
            "delta": {"toolUse": {"input": 'me"'}},
            "current_tool_use": {
                "toolUseId": "tooluse_efwXnrK_S6qTyxzcq1IUMQ",
                "name": "Person",
                "input": {"name": "John", "age": 31},
            },
        },
        {"event": {"contentBlockDelta": {"delta": {"toolUse": {"input": ': "J'}}, "contentBlockIndex": 0}}},
        {
            "type": "tool_use_stream",
            "delta": {"toolUse": {"input": ': "J'}},
            "current_tool_use": {
                "toolUseId": "tooluse_efwXnrK_S6qTyxzcq1IUMQ",
                "name": "Person",
                "input": {"name": "John", "age": 31},
            },
        },
        {"event": {"contentBlockDelta": {"delta": {"toolUse": {"input": 'ohn"'}}, "contentBlockIndex": 0}}},
        {
            "type": "tool_use_stream",
            "delta": {"toolUse": {"input": 'ohn"'}},
            "current_tool_use": {
                "toolUseId": "tooluse_efwXnrK_S6qTyxzcq1IUMQ",
                "name": "Person",
                "input": {"name": "John", "age": 31},
            },
        },
        {"event": {"contentBlockDelta": {"delta": {"toolUse": {"input": ', "age": 3'}}, "contentBlockIndex": 0}}},
        {
            "type": "tool_use_stream",
            "delta": {"toolUse": {"input": ', "age": 3'}},
            "current_tool_use": {
                "toolUseId": "tooluse_efwXnrK_S6qTyxzcq1IUMQ",
                "name": "Person",
                "input": {"name": "John", "age": 31},
            },
        },
        {"event": {"contentBlockDelta": {"delta": {"toolUse": {"input": "1}"}}, "contentBlockIndex": 0}}},
        {
            "type": "tool_use_stream",
            "delta": {"toolUse": {"input": "1}"}},
            "current_tool_use": {
                "toolUseId": "tooluse_efwXnrK_S6qTyxzcq1IUMQ",
                "name": "Person",
                "input": {"name": "John", "age": 31},
            },
        },
        {"event": {"contentBlockStop": {"contentBlockIndex": 0}}},
        {"event": {"messageStop": {"stopReason": "tool_use"}}},
        {
            "event": {
                "metadata": {
                    "usage": {"inputTokens": 407, "outputTokens": 53, "totalTokens": 460},
                    "metrics": {"latencyMs": 1572},
                }
            }
        },
    ]

    exp_calls = [call(**event) for event in exp_events]
    act_calls = mock_callback.call_args_list
    assert act_calls == exp_calls
