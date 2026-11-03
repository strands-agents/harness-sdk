"""Offline voice checks using the sidecar's pinned Python dependencies."""

import asyncio
import base64
import importlib.util
import json
import sys
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

SIDECAR_PATH = Path(__file__).parents[1] / "src" / "agent" / "voice-sidecar.py"
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


class RecordingOutput:
    def __init__(self) -> None:
        self.events: list[Any] = []

    async def start(self, agent: Any) -> None:
        pass

    async def stop(self) -> None:
        pass

    async def __call__(self, event: Any) -> None:
        self.events.append(event)


def audio_event() -> Any:
    return sidecar.BidiAudioDeltaEvent(
        audio=base64.b64encode(bytes(320)).decode(),
        format="pcm",
        sample_rate=16000,
        channels=1,
        content_id="audio",
    )


def tool_event() -> Any:
    return sidecar.BidiToolUseBlocksEvent(
        [{"toolUseId": "route-1", "name": "route_voice_turn", "input": {"intent": "conversation", "request": "Hi"}}]
    )


async def narration_ready(output: Any) -> bool:
    waiter = asyncio.create_task(output.wait_until_idle())
    try:
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        return waiter.done()
    finally:
        waiter.cancel()
        await asyncio.gather(waiter, return_exceptions=True)


class VoicePlaybackTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        emitter = patch.object(sidecar, "emit")
        self.emit = emitter.start()
        self.addCleanup(emitter.stop)
        self.sink = RecordingOutput()
        self.output = sidecar.ControlledAudioOutput(self.sink)
        await self.output(sidecar.BidiConnectionStartEvent("connection", "model"))

    async def test_plays_routed_response_and_releases_future_narration(self) -> None:
        await self.output(sidecar.BidiResponseStartEvent("response"))
        await self.output(tool_event())
        await self.output(audio_event())
        await self.output(sidecar.BidiResponseStopEvent("response"))

        self.assertTrue(await narration_ready(self.output))
        self.assertEqual(len(self.sink.events), 1)
        self.assertIsInstance(self.sink.events[0], sidecar.BidiAudioDeltaEvent)

    async def test_stopping_playback_preserves_the_active_model_turn(self) -> None:
        await self.output(sidecar.BidiResponseStartEvent("response"))
        await self.output(tool_event())
        await self.output(audio_event())
        await self.output.stop_speaking()
        await self.output(audio_event())

        self.assertFalse(await narration_ready(self.output))
        self.assertEqual(sum(isinstance(event, sidecar.BidiAudioDeltaEvent) for event in self.sink.events), 1)
        await self.output(sidecar.BidiResponseStopEvent("response"))
        self.assertTrue(await narration_ready(self.output))
        self.emit.assert_any_call("speech_output_stopped")

    async def test_barge_in_preserves_the_users_turn_and_suppresses_old_audio(self) -> None:
        await self.output(sidecar.BidiResponseStartEvent("interrupted"))
        await self.output(audio_event())
        await self.output(sidecar.BidiBargeInEvent())
        await self.output(audio_event())
        await self.output(sidecar.BidiResponseStopEvent("interrupted"))
        self.assertFalse(await narration_ready(self.output))

        await self.output(sidecar.BidiResponseStartEvent("answer"))
        await self.output(audio_event())
        await self.output(sidecar.BidiResponseStopEvent("answer"))
        self.assertTrue(await narration_ready(self.output))
        self.assertEqual(sum(isinstance(event, sidecar.BidiAudioDeltaEvent) for event in self.sink.events), 2)
        self.emit.assert_any_call("speech_output_interrupted")
        self.emit.assert_any_call("speech_output_complete", response_id="answer")

    async def test_tool_only_response_waits_for_its_spoken_followup(self) -> None:
        await self.output(sidecar.BidiResponseStartEvent("routing"))
        await self.output(tool_event())
        await self.output(sidecar.BidiResponseStopEvent("routing"))
        self.assertFalse(await narration_ready(self.output))

        await self.output(sidecar.BidiResponseStartEvent("answer"))
        await self.output(audio_event())
        await self.output(sidecar.BidiResponseStopEvent("answer"))
        self.assertTrue(await narration_ready(self.output))

    async def test_connection_changes_clear_playback_and_wait_for_reconnection(self) -> None:
        for event in (
            sidecar.BidiConnectionRestartEvent("scheduled"),
            sidecar.BidiConnectionStopEvent("connection", "user_request"),
        ):
            with self.subTest(event=event["type"]):
                await self.output(sidecar.BidiResponseStartEvent("response"))
                await self.output(audio_event())
                await self.output(event)
                self.assertFalse(await narration_ready(self.output))
                self.assertIsInstance(self.sink.events[-1], sidecar.BidiBargeInEvent)
                await self.output(sidecar.BidiConnectionStartEvent("new-connection", "model"))
                self.assertTrue(await narration_ready(self.output))


@asynccontextmanager
async def sidecar_runtime(*arguments: str):
    controls: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    allow_connection = asyncio.Event()
    input_received = asyncio.Event()
    narration_sent = asyncio.Event()
    captured_inputs: list[Any] = []
    narrations: list[str] = []
    sink = RecordingOutput()
    source = AsyncMock(return_value=sidecar.AudioDelta(format="pcm", source={"bytes": b"\x01\x02" * 160}))
    source.start = AsyncMock()
    source.stop = AsyncMock()

    class Agent:
        def __init__(self, **kwargs: Any) -> None:
            pass

        async def run(self, inputs: list[Any], outputs: list[Any]) -> None:
            await inputs[0].start(self)
            captured_inputs.append(await inputs[0]())
            input_received.set()
            await allow_connection.wait()
            for output in outputs:
                await output.start(self)
                await output(sidecar.BidiConnectionStartEvent("connection", "model"))
            await asyncio.Event().wait()

        async def send(self, text: str) -> None:
            narrations.append(text)
            narration_sent.set()

    with (
        patch.object(sys, "argv", ["sidecar.py", "--model", "model", "--voice", "tiffany", *arguments]),
        patch.object(sidecar, "RoutedNovaSonicModel"),
        patch.object(sidecar, "BidiAgent", Agent),
        patch.object(sidecar, "AudioIO", return_value=SimpleNamespace(input=lambda: source, output=lambda: sink)),
        patch.object(
            sidecar,
            "SidecarControl",
            return_value=SimpleNamespace(start=AsyncMock(), stop=AsyncMock(), next=controls.get),
        ),
        patch.object(sidecar, "emit"),
    ):
        task = asyncio.create_task(sidecar.run_voice(sidecar.parse_args(), "us-east-1"))
        try:
            yield SimpleNamespace(
                controls=controls,
                allow_connection=allow_connection,
                input_received=input_received,
                narration_sent=narration_sent,
                captured_inputs=captured_inputs,
                narrations=narrations,
            )
        finally:
            controls.put_nowait({"type": "stop"})
            await asyncio.wait_for(task, timeout=1)


class VoiceRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_muted_capture_reports_periodic_zero_levels(self) -> None:
        source = AsyncMock(return_value=sidecar.AudioDelta(format="pcm", source={"bytes": b"\x01\x02" * 160}))
        audio_input = sidecar.MutableAudioInput(source)
        with patch.object(sidecar, "emit") as emit:
            audio_input.set_muted(True)
            emit.reset_mock()
            with patch.object(sidecar.time, "monotonic", side_effect=[1.0, 1.01, 1.09]):
                for _ in range(3):
                    event = await audio_input()
                    self.assertEqual(event.source["bytes"], bytes(320))

            self.assertEqual(emit.call_count, 2)
            for event in emit.call_args_list:
                self.assertEqual(event.args, ("input_level",))
                self.assertEqual(event.kwargs, {"level": 0.0, "db": -60.0})

    async def test_unmuting_restores_captured_audio(self) -> None:
        captured = b"\x01\x02" * 160
        source = AsyncMock(return_value=sidecar.AudioDelta(format="pcm", source={"bytes": captured}))
        audio_input = sidecar.MutableAudioInput(source)
        with patch.object(sidecar, "emit"):
            audio_input.set_muted(True)
            self.assertEqual((await audio_input()).source["bytes"], bytes(320))
            audio_input.set_muted(False)
            self.assertEqual((await audio_input()).source["bytes"], captured)

    async def test_starting_muted_silences_the_first_microphone_chunk(self) -> None:
        async with sidecar_runtime("--muted") as runtime:
            await asyncio.wait_for(runtime.input_received.wait(), timeout=1)
            self.assertEqual(runtime.captured_inputs[0].source["bytes"], bytes(320))

    async def test_narration_accepted_during_startup_waits_for_connection(self) -> None:
        async with sidecar_runtime() as runtime:
            await asyncio.wait_for(runtime.input_received.wait(), timeout=1)
            await runtime.controls.put({"type": "narrate", "text": "The task finished."})
            for _ in range(3):
                await asyncio.sleep(0)
            self.assertEqual(runtime.narrations, [])

            runtime.allow_connection.set()
            await asyncio.wait_for(runtime.narration_sent.wait(), timeout=1)
            self.assertEqual(len(runtime.narrations), 1)
            self.assertIn("The task finished.", runtime.narrations[0])


class VoiceStartupTests(unittest.TestCase):
    def test_preflight_reports_missing_credentials_and_devices(self) -> None:
        for credentials, devices, message in (
            (None, [], "AWS credentials were not found"),
            (object(), [{"input_channels": 0, "output_channels": 1}], "No microphone input device"),
            (object(), [{"input_channels": 1, "output_channels": 0}], "No speaker output device"),
        ):
            with (
                self.subTest(message=message),
                patch.object(sys, "argv", ["sidecar.py"]),
                patch.object(sidecar.boto3, "Session") as session,
                patch.object(sidecar, "audio_devices", return_value=devices),
                patch.object(sidecar, "emit") as emit,
            ):
                session.return_value.get_credentials.return_value = credentials
                session.return_value.region_name = "us-east-1"
                self.assertEqual(sidecar.main(), 1)
                self.assertEqual(emit.call_args.args, ("fatal_error",))
                self.assertEqual(emit.call_args.kwargs["code"], "RuntimeError")
                self.assertIn(message, emit.call_args.kwargs["message"])

    def test_selected_device_open_failures_reach_the_parent(self) -> None:
        async def receive(_model: Any):
            yield sidecar.BidiConnectionStartEvent("connection", "model")
            await asyncio.Event().wait()

        def open_device(**options: Any) -> Any:
            direction = "input" if options.get("input") else "output"
            if options.get(f"{direction}_device_index") == 999:
                raise OSError(f"{direction} device 999 is unavailable")
            return SimpleNamespace(close=lambda: None)

        for direction in ("input", "output"):
            message = f"{direction} device 999 is unavailable"
            with (
                self.subTest(direction=direction),
                patch.object(
                    sys,
                    "argv",
                    [
                        "sidecar.py",
                        "--model",
                        "amazon.nova-2-5-sonic",
                        "--voice",
                        "tiffany",
                        f"--{direction}-device",
                        "999",
                    ],
                ),
                patch.object(sidecar, "preflight", return_value=("us-east-1", [])),
                patch.object(sidecar.RoutedNovaSonicModel, "start", new=AsyncMock()),
                patch.object(sidecar.RoutedNovaSonicModel, "receive", new=receive),
                patch.object(sidecar.RoutedNovaSonicModel, "stop", new=AsyncMock()),
                patch.object(sidecar.pyaudio, "PyAudio") as audio,
                patch.object(
                    sidecar,
                    "SidecarControl",
                    return_value=SimpleNamespace(start=AsyncMock(), stop=AsyncMock(), next=asyncio.Event().wait),
                ),
                patch.object(sidecar, "emit") as emit,
            ):
                audio.return_value.open.side_effect = open_device
                self.assertEqual(sidecar.main(), 1)
                emit.assert_any_call("fatal_error", code="OSError", message=message)
                audio.return_value.terminate.assert_called()


if __name__ == "__main__":
    unittest.main()
