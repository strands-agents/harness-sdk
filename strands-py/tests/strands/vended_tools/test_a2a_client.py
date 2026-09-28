"""Tests for the a2a_client tool."""

from __future__ import annotations

from typing import Any

import pytest
from a2a.client import ClientConfig

import strands.vended_tools.a2a_client.a2a_client as a2a_client_module
from strands.vended_tools.a2a_client import make_a2a_client
from strands.vended_tools.a2a_client.a2a_client import A2AClientError

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

_ENDPOINT = "https://agent.example.com"
_ENDPOINTS: dict[str, ClientConfig | None] = {_ENDPOINT: None}


class _FakeAgentCard:
    def model_dump(self, *, mode: str, exclude_none: bool) -> dict[str, Any]:
        return dict(_FAKE_CARD)


class _FakeAgentResult:
    message = _FAKE_MESSAGE
    state: dict = {}


class _FakeA2AAgent:
    def __init__(self, endpoint: str, *, client_config: Any = None, timeout: int = 300) -> None:
        self.endpoint = endpoint
        self.client_config = client_config

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
        tool = make_a2a_client(allowed_endpoints={"https://a.example.com": None, "https://b.example.com": None})
        with pytest.raises(A2AClientError, match="not in the allowed endpoints list") as exc_info:
            await tool(operation="discover", endpoint="https://evil.example.com")
        assert "https://a.example.com" in str(exc_info.value)


class TestDiscover:
    @pytest.mark.asyncio
    async def test_returns_agent_card_dict(self, fake_agent):
        tool = make_a2a_client(allowed_endpoints=_ENDPOINTS)
        tru_result = await tool(operation="discover", endpoint=_ENDPOINT)
        assert tru_result == _FAKE_CARD

    @pytest.mark.asyncio
    async def test_wraps_discovery_error_as_a2a_client_error(self, monkeypatch):
        original = RuntimeError("connection refused")

        class _FailingAgent(_FakeA2AAgent):
            async def get_agent_card(self) -> _FakeAgentCard:
                raise original

        monkeypatch.setattr(a2a_client_module, "A2AAgent", _FailingAgent)
        tool = make_a2a_client(allowed_endpoints=_ENDPOINTS)
        with pytest.raises(A2AClientError, match="Failed to discover agent card") as exc_info:
            await tool(operation="discover", endpoint=_ENDPOINT)
        assert exc_info.value.__cause__ is original

    @pytest.mark.asyncio
    async def test_rejects_oversized_agent_card(self, monkeypatch):
        class _BigCardAgent(_FakeA2AAgent):
            async def get_agent_card(self) -> _FakeAgentCard:
                card = _FakeAgentCard()
                card.model_dump = lambda **_: {"data": "x" * 1000}
                return card

        monkeypatch.setattr(a2a_client_module, "A2AAgent", _BigCardAgent)
        tool = make_a2a_client(allowed_endpoints=_ENDPOINTS, max_bytes=100)
        with pytest.raises(A2AClientError, match="exceeds max_bytes limit"):
            await tool(operation="discover", endpoint=_ENDPOINT)


class TestSendMessage:
    @pytest.mark.asyncio
    async def test_returns_message_dict(self, fake_agent):
        tool = make_a2a_client(allowed_endpoints=_ENDPOINTS)
        tru_result = await tool(operation="send_message", endpoint=_ENDPOINT, message="Hello")
        assert tru_result == {"message": _FAKE_MESSAGE}

    @pytest.mark.asyncio
    @pytest.mark.parametrize("message", [None, ""])
    async def test_missing_message_raises(self, message):
        tool = make_a2a_client(allowed_endpoints=_ENDPOINTS)
        with pytest.raises(A2AClientError, match="'message' is required"):
            await tool(operation="send_message", endpoint=_ENDPOINT, message=message)

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
        tool = make_a2a_client(allowed_endpoints=_ENDPOINTS)
        with pytest.raises(A2AClientError, match=task_state) as exc_info:
            await tool(operation="send_message", endpoint=_ENDPOINT, message="Hello")
        if detail_text:
            assert detail_text in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_wraps_send_error_as_a2a_client_error(self, monkeypatch):
        original = RuntimeError("timeout")

        class _FailingAgent(_FakeA2AAgent):
            async def invoke_async(self, prompt: str) -> _FakeAgentResult:
                raise original

        monkeypatch.setattr(a2a_client_module, "A2AAgent", _FailingAgent)
        tool = make_a2a_client(allowed_endpoints=_ENDPOINTS)
        with pytest.raises(A2AClientError, match="Failed to send message") as exc_info:
            await tool(operation="send_message", endpoint=_ENDPOINT, message="Hello")
        assert exc_info.value.__cause__ is original

    @pytest.mark.asyncio
    async def test_rejects_oversized_response(self, monkeypatch):
        class _BigResponseAgent(_FakeA2AAgent):
            async def invoke_async(self, prompt: str) -> _FakeAgentResult:
                result = _FakeAgentResult()
                result.message = {"role": "assistant", "content": [{"text": "x" * 1000}]}
                return result

        monkeypatch.setattr(a2a_client_module, "A2AAgent", _BigResponseAgent)
        tool = make_a2a_client(allowed_endpoints=_ENDPOINTS, max_bytes=100)
        with pytest.raises(A2AClientError, match="exceeds max_bytes limit"):
            await tool(operation="send_message", endpoint=_ENDPOINT, message="Hello")


class TestFactory:
    def test_empty_allowed_endpoints_raises(self):
        with pytest.raises(ValueError, match="allowed_endpoints must contain at least one endpoint"):
            make_a2a_client(allowed_endpoints={})

    def test_non_positive_max_bytes_raises(self):
        with pytest.raises(ValueError, match="max_bytes must be positive"):
            make_a2a_client(allowed_endpoints=_ENDPOINTS, max_bytes=0)

    def test_custom_name(self):
        tool = make_a2a_client(name="my_agent", allowed_endpoints=_ENDPOINTS)
        assert tool.tool_name == "my_agent"

    def test_description_includes_endpoints(self):
        tool = make_a2a_client(allowed_endpoints={"https://a.example.com": None, "https://b.example.com": None})
        desc = tool.tool_spec["description"]
        assert "https://a.example.com" in desc
        assert "https://b.example.com" in desc

    def test_custom_description_overrides(self):
        tool = make_a2a_client(
            description="My custom description",
            allowed_endpoints=_ENDPOINTS,
        )
        assert tool.tool_spec["description"] == "My custom description"

    @pytest.mark.asyncio
    async def test_per_endpoint_config_is_passed_to_agent(self, monkeypatch):
        seen_config: list[Any] = []

        class _CapturingAgent(_FakeA2AAgent):
            def __init__(self, endpoint: str, *, client_config: Any = None, timeout: int = 300) -> None:
                super().__init__(endpoint, client_config=client_config, timeout=timeout)
                seen_config.append(client_config)

        monkeypatch.setattr(a2a_client_module, "A2AAgent", _CapturingAgent)
        config = ClientConfig()
        tool = make_a2a_client(allowed_endpoints={_ENDPOINT: config})
        await tool(operation="discover", endpoint=_ENDPOINT)
        assert seen_config[0] is config

    def test_lazy_load_from_vended_tools(self):
        import strands.vended_tools as vt

        assert vt.make_a2a_client is make_a2a_client
