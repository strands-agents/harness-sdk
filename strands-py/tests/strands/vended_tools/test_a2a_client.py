"""Tests for the a2a_client tool."""

from __future__ import annotations

from typing import Any

import pytest

import strands.vended_tools.a2a_client.a2a_client as a2a_client_module
from strands.vended_tools.a2a_client import A2AClientError, make_a2a_client

_FAKE_CARD = {
    "name": "Test Agent",
    "description": "A test agent",
    "url": "https://agent.example.com",
    "version": "1.0.0",
    "skills": [],
    "capabilities": {},
    "defaultInputModes": ["text"],
    "defaultOutputModes": ["text"],
}

_FAKE_MESSAGE = {"role": "assistant", "content": [{"text": "Hello from agent"}]}


class _FakeAgentCard:
    def model_dump(self, *, mode: str, exclude_none: bool) -> dict[str, Any]:
        return dict(_FAKE_CARD)


class _FakeAgentResult:
    message = _FAKE_MESSAGE
    state: dict = {}


class _FakeA2AAgent:
    def __init__(self, endpoint: str, *, client_config: Any = None, timeout: int = 300) -> None:
        self.endpoint = endpoint

    async def get_agent_card(self) -> _FakeAgentCard:
        return _FakeAgentCard()

    async def invoke_async(self, prompt: str) -> _FakeAgentResult:
        return _FakeAgentResult()


@pytest.fixture
def fake_agent(monkeypatch):
    monkeypatch.setattr(a2a_client_module, "A2AAgent", _FakeA2AAgent)


class TestAllowlist:
    @pytest.mark.asyncio
    async def test_rejects_endpoint_not_in_allowlist(self):
        tool = make_a2a_client(allowed_endpoints=["https://a.example.com", "https://b.example.com"])
        with pytest.raises(A2AClientError, match="not in the allowed endpoints list") as exc_info:
            await tool(operation="discover", endpoint="https://evil.example.com")
        assert "https://a.example.com" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_accepts_endpoint_in_allowlist(self, fake_agent):
        tool = make_a2a_client(allowed_endpoints=["https://agent.example.com"])
        tru_result = await tool(operation="discover", endpoint="https://agent.example.com")
        assert tru_result == _FAKE_CARD


class TestDiscover:
    @pytest.mark.asyncio
    async def test_returns_agent_card_dict(self, fake_agent):
        tool = make_a2a_client(allowed_endpoints=["https://agent.example.com"])
        tru_result = await tool(operation="discover", endpoint="https://agent.example.com")
        assert tru_result == _FAKE_CARD

    @pytest.mark.asyncio
    async def test_wraps_discovery_error_as_a2a_client_error(self, monkeypatch):
        original = RuntimeError("connection refused")

        class _FailingAgent(_FakeA2AAgent):
            async def get_agent_card(self) -> _FakeAgentCard:
                raise original

        monkeypatch.setattr(a2a_client_module, "A2AAgent", _FailingAgent)
        tool = make_a2a_client(allowed_endpoints=["https://agent.example.com"])
        with pytest.raises(A2AClientError, match="Failed to discover agent card") as exc_info:
            await tool(operation="discover", endpoint="https://agent.example.com")
        assert exc_info.value.__cause__ is original

    @pytest.mark.asyncio
    async def test_rejects_oversized_agent_card(self, monkeypatch):
        class _BigCardAgent(_FakeA2AAgent):
            async def get_agent_card(self) -> _FakeAgentCard:
                card = _FakeAgentCard()
                card.model_dump = lambda **_: {"data": "x" * 1000}
                return card

        monkeypatch.setattr(a2a_client_module, "A2AAgent", _BigCardAgent)
        tool = make_a2a_client(allowed_endpoints=["https://agent.example.com"], max_bytes=100)
        with pytest.raises(A2AClientError, match="exceeds max_bytes limit"):
            await tool(operation="discover", endpoint="https://agent.example.com")


class TestSendMessage:
    @pytest.mark.asyncio
    async def test_returns_message_dict(self, fake_agent):
        tool = make_a2a_client(allowed_endpoints=["https://agent.example.com"])
        tru_result = await tool(
            operation="send_message",
            endpoint="https://agent.example.com",
            message="Hello",
        )
        assert tru_result == {"message": _FAKE_MESSAGE}

    @pytest.mark.asyncio
    @pytest.mark.parametrize("message", [None, ""])
    async def test_missing_message_raises(self, message):
        tool = make_a2a_client(allowed_endpoints=["https://agent.example.com"])
        with pytest.raises(A2AClientError, match="'message' is required"):
            await tool(operation="send_message", endpoint="https://agent.example.com", message=message)

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "task_state, detail_text",
        [
            ("failed", None),
            ("canceled", None),
            ("rejected", None),
            ("auth-required", None),
            ("input-required", "Which region should I deploy to?"),
        ],
    )
    async def test_non_completed_task_state_raises(self, monkeypatch, task_state, detail_text):
        content = [{"text": detail_text}] if detail_text else []

        class _NonCompletedAgent(_FakeA2AAgent):
            async def invoke_async(self, prompt: str) -> _FakeAgentResult:
                result = _FakeAgentResult()
                result.state = {"a2a_task_state": task_state}
                result.message = {"role": "assistant", "content": content}
                return result

        monkeypatch.setattr(a2a_client_module, "A2AAgent", _NonCompletedAgent)
        tool = make_a2a_client(allowed_endpoints=["https://agent.example.com"])
        with pytest.raises(A2AClientError, match=task_state) as exc_info:
            await tool(
                operation="send_message",
                endpoint="https://agent.example.com",
                message="Hello",
            )
        if detail_text:
            assert detail_text in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_wraps_send_error_as_a2a_client_error(self, monkeypatch):
        original = RuntimeError("timeout")

        class _FailingAgent(_FakeA2AAgent):
            async def invoke_async(self, prompt: str) -> _FakeAgentResult:
                raise original

        monkeypatch.setattr(a2a_client_module, "A2AAgent", _FailingAgent)
        tool = make_a2a_client(allowed_endpoints=["https://agent.example.com"])
        with pytest.raises(A2AClientError, match="Failed to send message") as exc_info:
            await tool(
                operation="send_message",
                endpoint="https://agent.example.com",
                message="Hello",
            )
        assert exc_info.value.__cause__ is original

    @pytest.mark.asyncio
    async def test_rejects_oversized_response(self, monkeypatch):
        class _BigResponseAgent(_FakeA2AAgent):
            async def invoke_async(self, prompt: str) -> _FakeAgentResult:
                result = _FakeAgentResult()
                result.message = {"role": "assistant", "content": [{"text": "x" * 1000}]}
                return result

        monkeypatch.setattr(a2a_client_module, "A2AAgent", _BigResponseAgent)
        tool = make_a2a_client(allowed_endpoints=["https://agent.example.com"], max_bytes=100)
        with pytest.raises(A2AClientError, match="exceeds max_bytes limit"):
            await tool(
                operation="send_message",
                endpoint="https://agent.example.com",
                message="Hello",
            )


class TestFactory:
    def test_empty_allowed_endpoints_raises(self):
        with pytest.raises(ValueError, match="allowed_endpoints must contain at least one endpoint"):
            make_a2a_client(allowed_endpoints=[])

    def test_non_positive_max_bytes_raises(self):
        with pytest.raises(ValueError, match="max_bytes must be positive"):
            make_a2a_client(allowed_endpoints=["https://agent.example.com"], max_bytes=0)

    def test_custom_name(self):
        tool = make_a2a_client(name="my_agent", allowed_endpoints=["https://agent.example.com"])
        assert tool.tool_name == "my_agent"

    def test_description_includes_endpoints(self):
        tool = make_a2a_client(allowed_endpoints=["https://a.example.com", "https://b.example.com"])
        desc = tool.tool_spec["description"]
        assert "https://a.example.com" in desc
        assert "https://b.example.com" in desc

    def test_custom_description_is_used(self):
        tool = make_a2a_client(
            description="My custom description",
            allowed_endpoints=["https://agent.example.com"],
        )
        assert tool.tool_spec["description"] == "My custom description"

    def test_lazy_load_from_vended_tools(self):
        import strands.vended_tools as vt

        assert vt.make_a2a_client is make_a2a_client
