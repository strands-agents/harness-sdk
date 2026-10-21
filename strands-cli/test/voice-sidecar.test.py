"""Offline voice routing checks using the sidecar's pinned Python dependencies."""

import importlib.util
import json
import unittest
from pathlib import Path
from typing import Any

SIDECAR_PATH = Path(__file__).parents[1] / "src" / "tui" / "voice" / "sidecar.py"
SPEC = importlib.util.spec_from_file_location("voice_sidecar", SIDECAR_PATH)
assert SPEC is not None and SPEC.loader is not None
sidecar = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sidecar)
ROUTE_RESULT = sidecar.ToolResultBlock(tool_use_id="route-1", status="success", content=[{"text": "accepted"}])


class RecordingSocket:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.fail_response = False

    async def send(self, message: str) -> None:
        event = json.loads(message)
        if self.fail_response and event["type"] == "response.create":
            raise ConnectionError("response send failed")
        self.events.append(event)


def model_and_socket() -> tuple[Any, RecordingSocket]:
    model = sidecar.RoutedOpenAIRealtimeModel(
        model_id="gpt-realtime-2.1",
        transcription_model_id="gpt-transcribe",
        api_key="test-key",
    )
    socket = RecordingSocket()
    model._websocket = socket
    return model, socket


class VoiceRoutingTests(unittest.IsolatedAsyncioTestCase):
    async def test_speaks_after_a_result_deferred_until_response_stop(self) -> None:
        model, socket = model_and_socket()
        state = model._session_state
        state.active_responses.add("routing-response")
        state.pending_tools.add("route-1")

        await model._send_tool_result(ROUTE_RESULT)
        self.assertEqual([event["type"] for event in socket.events], ["conversation.item.create"])
        state.active_responses.clear()
        await model._flush_response_request(state)

        self.assertEqual(socket.events[-1], {"type": "response.create", "response": {"tool_choice": "none"}})
        await model._send_event({"type": "response.create"})
        self.assertEqual(socket.events[-1], {"type": "response.create"})

    async def test_speaks_after_an_immediate_routing_result(self) -> None:
        model, socket = model_and_socket()
        await model._send_tool_result(ROUTE_RESULT)
        self.assertEqual(socket.events[-1], {"type": "response.create", "response": {"tool_choice": "none"}})

    async def test_preserves_the_routing_result_until_a_response_is_sent(self) -> None:
        model, socket = model_and_socket()
        socket.fail_response = True
        with self.assertRaises(ConnectionError):
            await model._send_tool_result(ROUTE_RESULT)

        socket.fail_response = False
        await model._flush_response_request(model._session_state)
        self.assertEqual(socket.events[-1], {"type": "response.create", "response": {"tool_choice": "none"}})


if __name__ == "__main__":
    unittest.main()
