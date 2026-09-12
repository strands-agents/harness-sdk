"""Tests for the bidirectional model base class."""

from collections.abc import AsyncIterable
from typing import Any
from unittest.mock import AsyncMock

import pytest
from pydantic import BaseModel

from strands.experimental.bidi import Restartable
from strands.experimental.bidi.models.configs import AudioConfig
from strands.experimental.bidi.models.model import AudioCapable, BidiModel, _validate_tool_result_message
from strands.experimental.bidi.types.events import BidiInputEvent, BidiOutputEvent
from strands.models import Model
from strands.types.content import Message, Messages
from strands.types.tools import ToolSpec


class _Output(BaseModel):
    value: str


class _TestBidiModel(BidiModel):
    def __init__(self) -> None:
        self._model_id = "test-model"
        self.usage_is_cumulative = False

    def update_config(self, **model_config: Any) -> None:
        self._model_id = model_config.get("model_id", self._model_id)

    def get_config(self) -> dict[str, Any]:
        return {"model_id": self._model_id}

    async def start(
        self,
        system_prompt: str | None = None,
        tools: list[ToolSpec] | None = None,
        messages: Messages | None = None,
        **kwargs: Any,
    ) -> None:
        pass

    async def stop(self) -> None:
        pass

    def receive(self) -> AsyncIterable[BidiOutputEvent]:
        async def events() -> AsyncIterable[BidiOutputEvent]:
            if False:
                yield

        return events()

    async def send(self, content: BidiInputEvent) -> None:
        pass

    async def send_tool_results(self, message: Message) -> None:
        pass


class _AudioBidiModel(_TestBidiModel):
    def get_audio_config(self) -> AudioConfig:
        return {
            "input_rate": 16000,
            "output_rate": 24000,
            "channels": 1,
            "format": "pcm",
        }


class _TestRestartableBidiModel(_TestBidiModel):
    async def restart(
        self,
        system_prompt: str | None = None,
        tools: list[ToolSpec] | None = None,
        messages: Messages | None = None,
        **restart_kwargs: Any,
    ) -> None:
        pass


def test_model_is_model():
    assert isinstance(_TestBidiModel(), Model)


def test_audio_capable_identifies_audio_models():
    assert isinstance(_AudioBidiModel(), AudioCapable)
    assert not isinstance(_TestBidiModel(), AudioCapable)


def test_model_without_restart_is_not_restartable():
    assert not isinstance(_TestBidiModel(), Restartable)


def test_model_with_restart_is_restartable():
    assert isinstance(_TestRestartableBidiModel(), Restartable)


def test_stream_raises_not_implemented():
    with pytest.raises(NotImplementedError, match="regular streaming"):
        _TestBidiModel().stream([])


def test_structured_output_raises_not_implemented():
    with pytest.raises(NotImplementedError, match="structured output"):
        _TestBidiModel().structured_output(_Output, [])


def test_incomplete_bidi_model_cannot_be_instantiated():
    """Third-party models must implement the grouped tool-result contract."""

    class _IncompleteBidiModel(BidiModel):
        def update_config(self, **model_config: Any) -> None:
            pass

        def get_config(self) -> dict[str, Any]:
            return {"model_id": "incomplete"}

        async def start(
            self,
            system_prompt: str | None = None,
            tools: list[ToolSpec] | None = None,
            messages: Messages | None = None,
            **kwargs: Any,
        ) -> None:
            pass

        async def stop(self) -> None:
            pass

        def receive(self) -> AsyncIterable[BidiOutputEvent]:
            async def events() -> AsyncIterable[BidiOutputEvent]:
                if False:
                    yield

            return events()

        async def send(self, content: BidiInputEvent) -> None:
            pass

    with pytest.raises(TypeError, match="abstract method 'send_tool_results'"):
        _IncompleteBidiModel()


@pytest.mark.asyncio
async def test_bidi_model_spec_exposes_async_grouped_tool_results():
    """BidiModel mocks expose the grouped result method as an async API."""
    model = AsyncMock(spec=BidiModel)
    message: Message = {
        "role": "user",
        "content": [{"toolResult": {"toolUseId": "call-1", "status": "success", "content": []}}],
    }

    await model.send_tool_results(message)

    model.send_tool_results.assert_awaited_once_with(message)


@pytest.mark.parametrize(
    "message,error",
    [
        ({"role": "assistant", "content": []}, "role"),
        ({"role": "user", "content": []}, "non-empty"),
        ({"role": "user", "content": [{"text": "invalid"}]}, "only 'toolResult'"),
        (
            {"role": "user", "content": [{"toolResult": {"toolUseId": "", "status": "success", "content": []}}]},
            "toolUseId",
        ),
        (
            {"role": "user", "content": [{"toolResult": {"toolUseId": "1", "status": "pending", "content": []}}]},
            "status",
        ),
        (
            {"role": "user", "content": [{"toolResult": {"toolUseId": "1", "status": "success", "content": {}}}]},
            "content",
        ),
    ],
)
def test_validate_tool_result_message_rejects_invalid_groups(message, error):
    """Grouped provider writes reject malformed messages before sending."""
    with pytest.raises(ValueError, match=error):
        _validate_tool_result_message(message)


def test_validate_tool_result_message_preserves_order_and_rejects_duplicates():
    """Grouped result validation preserves source order and enforces unique IDs."""
    message: Message = {
        "role": "user",
        "content": [
            {"toolResult": {"toolUseId": "2", "status": "success", "content": []}},
            {"toolResult": {"toolUseId": "1", "status": "error", "content": [{"text": "failed"}]}},
        ],
    }

    assert [result["toolUseId"] for result in _validate_tool_result_message(message)] == ["2", "1"]

    message["content"][1]["toolResult"]["toolUseId"] = "2"
    with pytest.raises(ValueError, match="duplicate toolUseId '2'"):
        _validate_tool_result_message(message)
