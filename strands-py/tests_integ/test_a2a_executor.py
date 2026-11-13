"""Integration tests for A2A executor with real file processing."""

import os
import threading
import time
from uuid import uuid4

import pytest
import requests
import uvicorn
from a2a.helpers import new_data_part
from a2a.types import Message, Part, Role, SendMessageRequest
from google.protobuf.json_format import MessageToDict

from strands import Agent
from strands.multiagent.a2a import A2AServer

_A2A_VERSION_HEADER = {"A2A-Version": "1.0"}


def _send_message(message: Message, request_id: str, *, port: int) -> dict:
    """POST a SendMessage JSON-RPC request and return its `result`, failing on a JSON-RPC error."""
    payload = {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "SendMessage",
        "params": MessageToDict(SendMessageRequest(message=message)),
    }
    response = requests.post(
        f"http://127.0.0.1:{port}",
        headers={"Content-Type": "application/json", **_A2A_VERSION_HEADER},
        json=payload,
        timeout=30,
    )
    assert response.status_code == 200
    response_data = response.json()
    assert "error" not in response_data, response_data
    return response_data["result"]


@pytest.mark.asyncio
async def test_a2a_executor_with_real_image():
    """Test A2A server processes a real image file correctly via HTTP."""
    # Read the test image file
    test_image_path = os.path.join(os.path.dirname(__file__), "resources/yellow.png")
    with open(test_image_path, "rb") as f:
        original_image_bytes = f.read()

    # Create real Strands agent
    strands_agent = Agent(name="Test Image Agent", description="Agent for testing image processing")

    # Create A2A server
    a2a_server = A2AServer(agent=strands_agent, port=9001)
    fastapi_app = a2a_server.to_fastapi_app()

    # Start server in background
    server_thread = threading.Thread(target=lambda: uvicorn.run(fastapi_app, port=9001), daemon=True)
    server_thread.start()
    time.sleep(1)  # Give server time to start

    message = Message(
        message_id=str(uuid4()),
        role=Role.ROLE_USER,
        parts=[
            Part(text="What primary color is this image, respond with NONE if you are unsure"),
            Part(raw=original_image_bytes, media_type="image/png", filename="image.png"),
        ],
    )
    result = _send_message(message, "test-image-request", port=9001)

    task = result["task"]
    assert task["status"]["state"] == "TASK_STATE_COMPLETED"
    all_text = " ".join(
        part["text"] for artifact in task["artifacts"] for part in artifact["parts"] if "text" in part
    ).lower()
    assert "yellow" in all_text


@pytest.mark.asyncio
async def test_a2a_executor_interrupt_resume_over_http():
    """Park a tool interrupt and resume it over real JSON-RPC, matching production wire shapes.

    Uses a `MockedModelProvider` (no live model call) so the interrupt/resume turn sequence is
    deterministic, while still exercising the real HTTP + JSON-RPC + protobuf wire round trip.
    """
    from strands import tool
    from strands.types.tools import ToolContext
    from tests.fixtures.mocked_model_provider import MockedModelProvider

    @tool(name="approval_tool", context=True)
    def approval_tool(tool_context: ToolContext) -> str:
        return tool_context.interrupt("approval_interrupt", reason="need approval")

    tool_use_message = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "approval_tool", "input": {}}}],
    }
    final_message = {"role": "assistant", "content": [{"text": "done"}]}
    model = MockedModelProvider([tool_use_message, final_message])
    strands_agent = Agent(
        name="Test Interrupt Agent",
        description="Agent for testing interrupt park/resume over A2A",
        model=model,
        tools=[approval_tool],
        callback_handler=None,
    )

    a2a_server = A2AServer(agent=strands_agent, port=9002)
    fastapi_app = a2a_server.to_fastapi_app()

    server_thread = threading.Thread(target=lambda: uvicorn.run(fastapi_app, port=9002), daemon=True)
    server_thread.start()
    time.sleep(1)

    initial_message = Message(
        message_id=str(uuid4()),
        role=Role.ROLE_USER,
        parts=[Part(text="Use the approval_tool now.")],
    )
    task = _send_message(initial_message, "test-interrupt-request", port=9002)["task"]
    assert task["status"]["state"] == "TASK_STATE_INPUT_REQUIRED"

    interrupt_data = next(
        part["data"] for part in task["status"]["message"]["parts"] if "data" in part and "interrupts" in part["data"]
    )
    interrupt_id = interrupt_data["interrupts"][0]["interruptId"]

    resume_message = Message(
        message_id=str(uuid4()),
        task_id=task["id"],
        context_id=task["contextId"],
        role=Role.ROLE_USER,
        parts=[new_data_part({"interruptResponse": {"interruptId": interrupt_id, "response": "APPROVE"}})],
    )
    resumed_task = _send_message(resume_message, "test-interrupt-resume", port=9002)["task"]
    assert resumed_task["status"]["state"] == "TASK_STATE_COMPLETED"


@pytest.mark.asyncio
async def test_a2a_agent_content_round_trip_streaming_disabled():
    """End-to-end: A2AAgent → A2AServer with enable_a2a_compliant_streaming=False.

    Asserts the reply *content* is preserved through convert_responses_to_agent_result,
    not just stop_reason.
    """
    from strands.agent.a2a_agent import A2AAgent
    from tests.fixtures.mocked_model_provider import MockedModelProvider

    reply_text = "The capital of France is Paris."
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": reply_text}]}])
    strands_agent = Agent(
        name="Content Agent",
        description="Agent that returns a known answer",
        model=model,
        callback_handler=None,
    )

    port = 9003
    a2a_server = A2AServer(agent=strands_agent, port=port, enable_a2a_compliant_streaming=False)
    fastapi_app = a2a_server.to_fastapi_app()

    server_thread = threading.Thread(target=lambda: uvicorn.run(fastapi_app, port=port), daemon=True)
    server_thread.start()
    time.sleep(1)

    a2a_agent = A2AAgent(endpoint=f"http://127.0.0.1:{port}")
    result = await a2a_agent.invoke_async("What is the capital of France?")

    assert result.stop_reason == "end_turn"
    content_text = " ".join(block["text"] for block in result.message["content"] if "text" in block)
    assert reply_text in content_text


@pytest.mark.asyncio
async def test_a2a_agent_content_round_trip_streaming_enabled():
    """End-to-end: A2AAgent → A2AServer with enable_a2a_compliant_streaming=True.

    Asserts content is correctly accumulated from artifact_update deltas through
    convert_responses_to_agent_result.
    """
    from strands.agent.a2a_agent import A2AAgent
    from tests.fixtures.mocked_model_provider import MockedModelProvider

    reply_text = "The capital of France is Paris."
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": reply_text}]}])
    strands_agent = Agent(
        name="Streaming Content Agent",
        description="Agent that returns a known answer via compliant streaming",
        model=model,
        callback_handler=None,
    )

    port = 9004
    a2a_server = A2AServer(agent=strands_agent, port=port, enable_a2a_compliant_streaming=True)
    fastapi_app = a2a_server.to_fastapi_app()

    server_thread = threading.Thread(target=lambda: uvicorn.run(fastapi_app, port=port), daemon=True)
    server_thread.start()
    time.sleep(1)

    a2a_agent = A2AAgent(endpoint=f"http://127.0.0.1:{port}")
    result = await a2a_agent.invoke_async("What is the capital of France?")

    assert result.stop_reason == "end_turn"
    content_text = " ".join(block["text"] for block in result.message["content"] if "text" in block)
    assert reply_text in content_text


@pytest.mark.asyncio
async def test_a2a_agent_interrupt_round_trip():
    """End-to-end: A2AAgent sees interrupt content through convert_responses_to_agent_result.

    Parks on input_required with a reason message, asserts the A2AAgent receives both
    stop_reason="interrupt" AND the interrupt question text in the result content.
    """
    from strands import tool
    from strands.agent.a2a_agent import A2AAgent
    from strands.types.tools import ToolContext
    from tests.fixtures.mocked_model_provider import MockedModelProvider

    @tool(name="ask_user", context=True)
    def ask_user(tool_context: ToolContext) -> str:
        return tool_context.interrupt("ask_interrupt", reason="Do you approve this action?")

    tool_use_message = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "ask_user", "input": {}}}],
    }
    model = MockedModelProvider([tool_use_message])
    strands_agent = Agent(
        name="Interrupt Agent",
        description="Agent that asks for approval",
        model=model,
        tools=[ask_user],
        callback_handler=None,
    )

    port = 9005
    a2a_server = A2AServer(agent=strands_agent, port=port, enable_a2a_compliant_streaming=True)
    fastapi_app = a2a_server.to_fastapi_app()

    server_thread = threading.Thread(target=lambda: uvicorn.run(fastapi_app, port=port), daemon=True)
    server_thread.start()
    time.sleep(1)

    a2a_agent = A2AAgent(endpoint=f"http://127.0.0.1:{port}")
    result = await a2a_agent.invoke_async("Please ask for approval.")

    assert result.stop_reason == "interrupt"
    content_text = " ".join(block["text"] for block in result.message["content"] if "text" in block)
    assert "approve" in content_text.lower() or "interrupt" in content_text.lower()
