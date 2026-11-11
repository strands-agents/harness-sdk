"""System One decision model tests — the behavioral spec shared by both providers."""

import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest

from strands.decisions import DecisionModel, DecisionsAPIDecisionModel, TypeSafeDecisionModel, Uncertain
from strands.types.exceptions import (
    ContextWindowOverflowException,
    ModelThrottledException,
    StructuredOutputException,
)

_SENTINEL = object()


@dataclass
class _ProviderCase:
    name: str
    model_cls: type[DecisionModel]
    endpoint: str
    default_model_id: str
    provider_name: str
    api_key_env: str


_PROVIDERS = [
    _ProviderCase(
        name="TypeSafeDecisionModel",
        model_cls=TypeSafeDecisionModel,
        endpoint="https://api.typesafe.ai/v1/systemone",
        default_model_id="jev-latest",
        provider_name="typesafe",
        api_key_env="TYPESAFE_API_KEY",
    ),
    _ProviderCase(
        name="DecisionsAPIDecisionModel",
        model_cls=DecisionsAPIDecisionModel,
        endpoint="https://decisionapi.net/v1/systemone",
        default_model_id="~typesafe/jev-latest",
        provider_name="decisions_api",
        api_key_env="JEV_API_KEY",
    ),
]

_PROVIDER_IDS = [case.name for case in _PROVIDERS]


def _response_body(answers: dict[str, Any], usage: Any = _SENTINEL) -> dict[str, Any]:
    if usage is _SENTINEL:
        usage = {"input_tokens": 12, "output_tokens": 3}
    return {"model": "resolved-model", "answers": answers, "usage": usage}


def _fake_client(payload: Any, *, status: int = 200, captured: list[httpx.Request] | None = None) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        if captured is not None:
            captured.append(request)
        return httpx.Response(status, json=payload)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _fake_text_client(body: str, *, status: int = 200) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, text=body, headers={"content-type": "text/plain"})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _request_body(request: httpx.Request) -> dict[str, Any]:
    return json.loads(request.content)


@pytest.fixture(autouse=True)
def _clear_provider_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for case in _PROVIDERS:
        monkeypatch.delenv(case.api_key_env, raising=False)


@pytest.mark.parametrize("provider", _PROVIDERS, ids=_PROVIDER_IDS)
class TestAsk:
    @pytest.mark.asyncio
    async def test_maps_questions_and_returns_typed_answers_with_confidence_metadata(self, provider: _ProviderCase):
        captured: list[httpx.Request] = []
        client = _fake_client(
            _response_body(
                {
                    "urgent": {"type": "noul", "noul": 0.9},
                    "department": {
                        "type": "choice",
                        "choice": "billing",
                        "probabilities": {"billing": 0.7, "support": 0.2, "sales": 0.1},
                        "confidence": 0.55,
                    },
                }
            ),
            captured=captured,
        )
        decision = provider.model_cls(api_key="test-key", http_client=client)

        result = await decision.ask(
            "Refund this today",
            {
                "urgent": {"question": "Is this urgent?", "choices": "boolean"},
                "department": {
                    "question": "Which team should handle this?",
                    "choices": ["billing", "support", "sales"],
                },
            },
        )

        assert len(captured) == 1
        assert str(captured[0].url) == provider.endpoint
        assert captured[0].headers["authorization"] == "Bearer test-key"
        assert captured[0].headers["content-type"] == "application/json"
        assert _request_body(captured[0]) == {
            "state": "Refund this today",
            "model": provider.default_model_id,
            "questions": {
                "urgent": {"type": "noul", "instructions": "Is this urgent?"},
                "department": {
                    "type": "choice",
                    "instructions": "Which team should handle this?",
                    "criteria": {"billing": None, "support": None, "sales": None},
                },
            },
        }

        assert result.answers == {"urgent": True, "department": "billing"}
        assert result.usage == {"inputTokens": 12, "outputTokens": 3, "totalTokens": 15}
        assert result.metadata.latency_ms >= 0
        assert result.metadata.provider_name == provider.provider_name
        assert result.metadata.model_id == "resolved-model"
        assert result.metadata.probabilities == {
            "urgent": pytest.approx({"true": 0.9, "false": 0.1}),
            "department": pytest.approx({"billing": 0.7, "support": 0.2, "sales": 0.1}),
        }
        assert result.metadata.confidence == {"urgent": pytest.approx(0.8), "department": pytest.approx(0.55)}

    @pytest.mark.asyncio
    async def test_applies_the_provider_wide_default_minimum_confidence(self, provider: _ProviderCase):
        client = _fake_client(_response_body({"q": {"type": "noul", "noul": 0.625}}))
        decision = provider.model_cls(api_key="test-key", http_client=client)

        result = await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

        assert result.answers == {"q": Uncertain()}
        assert result.metadata.confidence == {"q": pytest.approx(0.25)}

    @pytest.mark.asyncio
    async def test_accepts_confidence_equal_to_the_threshold(self, provider: _ProviderCase):
        client = _fake_client(_response_body({"q": {"type": "noul", "noul": 0.75}}))
        decision = provider.model_cls(api_key="test-key", http_client=client)

        result = await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

        assert result.answers == {"q": True}
        assert result.metadata.confidence == {"q": pytest.approx(0.5)}

    @pytest.mark.asyncio
    async def test_applies_override_default_and_disabled_uncertainty_in_precedence_order(self, provider: _ProviderCase):
        client = _fake_client(
            _response_body(
                {
                    "providerDefault": {"type": "noul", "noul": 0.8},
                    "questionOverride": {"type": "noul", "noul": 0.8},
                    "disabled": {"type": "noul", "noul": 0.5},
                }
            )
        )
        decision = provider.model_cls(api_key="test-key", default_min_confidence=0.7, http_client=client)

        result = await decision.ask(
            "state",
            {
                "providerDefault": {"question": "default?", "choices": "boolean"},
                "questionOverride": {
                    "question": "override?",
                    "choices": "boolean",
                    "uncertainty": {"min_confidence": 0.5},
                },
                "disabled": {"question": "forced?", "choices": "boolean", "uncertainty": False},
            },
        )

        assert result.answers == {"providerDefault": Uncertain(), "questionOverride": True, "disabled": True}
        assert result.metadata.confidence == {
            "providerDefault": pytest.approx(0.6),
            "questionOverride": pytest.approx(0.6),
            "disabled": pytest.approx(0.0),
        }

    @pytest.mark.asyncio
    async def test_thresholds_choice_answers_on_provider_confidence_with_overrides(self, provider: _ProviderCase):
        answer = {"type": "choice", "choice": "a", "probabilities": {"a": 0.9, "b": 0.1}, "confidence": 0.65}
        client = _fake_client(_response_body({"providerDefault": answer, "questionOverride": answer}))
        decision = provider.model_cls(api_key="test-key", default_min_confidence=0.7, http_client=client)

        result = await decision.ask(
            "state",
            {
                "providerDefault": {"question": "pick?", "choices": ["a", "b"]},
                "questionOverride": {
                    "question": "pick?",
                    "choices": ["a", "b"],
                    "uncertainty": {"min_confidence": 0.6},
                },
            },
        )

        assert result.answers == {"providerDefault": Uncertain(), "questionOverride": "a"}
        assert result.metadata.confidence == {
            "providerDefault": pytest.approx(0.65),
            "questionOverride": pytest.approx(0.65),
        }

    @pytest.mark.asyncio
    async def test_projects_messages_without_internal_tracking_ids_or_metadata(self, provider: _ProviderCase):
        captured: list[httpx.Request] = []
        client = _fake_client(_response_body({"q": {"type": "noul", "noul": 1}}), captured=captured)
        decision = provider.model_cls(api_key="test-key", http_client=client)
        message = {
            "role": "user",
            "content": [{"text": "hello"}],
            "tracking_id": "internal-id",
            "metadata": {"custom": {"private": "framework-value"}},
        }

        await decision.ask([message], {"q": {"question": "Greeting?", "choices": "boolean"}})

        assert _request_body(captured[0])["state"] == [{"role": "user", "content": [{"text": "hello"}]}]

    @pytest.mark.asyncio
    async def test_projects_content_block_state(self, provider: _ProviderCase):
        captured: list[httpx.Request] = []
        client = _fake_client(_response_body({"q": {"type": "noul", "noul": 1}}), captured=captured)
        decision = provider.model_cls(api_key="test-key", http_client=client)

        await decision.ask([{"text": "hello"}], {"q": {"question": "Greeting?", "choices": "boolean"}})

        assert _request_body(captured[0])["state"] == [{"text": "hello"}]

    @pytest.mark.asyncio
    async def test_creates_and_closes_the_default_http_client(
        self, provider: _ProviderCase, monkeypatch: pytest.MonkeyPatch
    ):
        created: list[Any] = []

        class FakeDefaultClient:
            def __init__(self, *, timeout: httpx.Timeout) -> None:
                self.timeout = timeout
                self.closed = False
                created.append(self)

            async def __aenter__(self) -> "FakeDefaultClient":
                return self

            async def __aexit__(self, *_args: Any) -> None:
                self.closed = True

            async def post(self, url: str, *, headers: dict[str, str], content: str) -> httpx.Response:
                request = httpx.Request("POST", url, headers=headers, content=content)
                return httpx.Response(
                    200,
                    json=_response_body({"q": {"type": "noul", "noul": 1}}),
                    request=request,
                )

        monkeypatch.setattr(httpx, "AsyncClient", FakeDefaultClient)
        decision = provider.model_cls(api_key="test-key")

        result = await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

        assert result.answers == {"q": True}
        assert len(created) == 1
        assert created[0].timeout == httpx.Timeout(30.0)
        assert created[0].closed is True

    @pytest.mark.asyncio
    async def test_rejects_binary_content_blocks_before_sending(self, provider: _ProviderCase):
        captured: list[httpx.Request] = []
        client = _fake_client(_response_body({}), captured=captured)
        decision = provider.model_cls(api_key="test-key", http_client=client)
        image = {"image": {"format": "png", "source": {"bytes": b"\x01\x02\x03"}}}

        with pytest.raises(ValueError, match="do not support binary ContentBlock state"):
            await decision.ask([image], {"q": {"question": "What is shown?", "choices": "boolean"}})
        assert captured == []

    @pytest.mark.asyncio
    async def test_honors_an_explicit_model_id(self, provider: _ProviderCase):
        captured: list[httpx.Request] = []
        client = _fake_client(_response_body({"q": {"type": "noul", "noul": 1}}), captured=captured)
        decision = provider.model_cls(api_key="test-key", model_id="pinned-model", http_client=client)

        await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

        assert _request_body(captured[0])["model"] == "pinned-model"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status", [429, 503, 529])
    async def test_maps_throttling_statuses_to_model_throttled(self, provider: _ProviderCase, status: int):
        client = _fake_client({"error": "retry later"}, status=status)
        decision = provider.model_cls(api_key="test-key", http_client=client)

        with pytest.raises(ModelThrottledException) as caught:
            await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

        cause = caught.value.__cause__
        assert isinstance(cause, httpx.HTTPStatusError)
        assert cause.response.status_code == status
        assert cause.response.json() == {"error": "retry later"}

    @pytest.mark.asyncio
    async def test_maps_http_413_to_context_window_overflow(self, provider: _ProviderCase):
        captured: list[httpx.Request] = []
        client = _fake_client({"error": "request too large"}, status=413, captured=captured)
        decision = provider.model_cls(api_key="test-key", http_client=client)

        # The body is sent now (no client-side size check); only the server's 413 maps it.
        with pytest.raises(ContextWindowOverflowException, match="HTTP 413: request too large"):
            await decision.ask("x" * (64 * 1024), {"q": {"question": "ok?", "choices": "boolean"}})
        assert len(captured) == 1

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("body", "detail"),
        [
            ({"error": "from error"}, "from error"),
            ({"message": "from message"}, "from message"),
            ({"detail": "from detail"}, "from detail"),
            ({"error": {"message": "nested message"}}, "nested message"),
        ],
        ids=["error", "message", "detail", "nested-message"],
    )
    async def test_raises_http_status_error_for_other_http_failures(
        self, provider: _ProviderCase, body: dict[str, Any], detail: str
    ):
        client = _fake_client(body, status=400)
        decision = provider.model_cls(api_key="test-key", http_client=client)

        with pytest.raises(httpx.HTTPStatusError, match=f"HTTP 400: {detail}") as caught:
            await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

        assert caught.value.response.status_code == 400
        assert caught.value.response.json() == body

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "body",
        [["unstructured"], {"error": {"code": "unknown"}}],
        ids=["non-object", "no-text-field"],
    )
    async def test_omits_http_error_detail_when_the_body_has_none(self, provider: _ProviderCase, body: Any):
        client = _fake_client(body, status=500)
        decision = provider.model_cls(api_key="test-key", http_client=client)

        with pytest.raises(httpx.HTTPStatusError) as caught:
            await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

        assert str(caught.value) == f"{provider.provider_name} decision request failed with HTTP 500"

    @pytest.mark.asyncio
    async def test_uses_a_non_json_error_body_as_http_error_detail(self, provider: _ProviderCase):
        client = _fake_text_client("upstream unavailable", status=500)
        decision = provider.model_cls(api_key="test-key", http_client=client)

        with pytest.raises(httpx.HTTPStatusError, match="HTTP 500: upstream unavailable"):
            await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

    @pytest.mark.asyncio
    async def test_propagates_transport_failures(self, provider: _ProviderCase):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("offline")

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        decision = provider.model_cls(api_key="test-key", http_client=client)

        with pytest.raises(httpx.ConnectError, match="offline"):
            await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

    @pytest.mark.asyncio
    async def test_rejects_a_non_json_success_response(self, provider: _ProviderCase):
        client = _fake_text_client("not json")
        decision = provider.model_cls(api_key="test-key", http_client=client)

        with pytest.raises(StructuredOutputException, match="returned a non-JSON response") as caught:
            await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

        assert isinstance(caught.value.__cause__, json.JSONDecodeError)

    @pytest.mark.asyncio
    async def test_rejects_an_empty_success_response(self, provider: _ProviderCase):
        client = _fake_text_client("")
        decision = provider.model_cls(api_key="test-key", http_client=client)

        with pytest.raises(StructuredOutputException, match="decision provider response must be an object"):
            await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

    @pytest.mark.asyncio
    async def test_omits_usage_when_the_provider_returns_null_token_counters(self, provider: _ProviderCase):
        client = _fake_client(
            _response_body({"q": {"type": "noul", "noul": 1}}, usage={"input_tokens": None, "output_tokens": None})
        )
        decision = provider.model_cls(api_key="test-key", http_client=client)

        result = await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

        assert result.usage is None

    @pytest.mark.asyncio
    async def test_omits_usage_when_the_provider_omits_it(self, provider: _ProviderCase):
        client = _fake_client({"model": "resolved-model", "answers": {"q": {"type": "noul", "noul": 1}}})
        decision = provider.model_cls(api_key="test-key", http_client=client)

        result = await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

        assert result.usage is None

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "usage",
        [
            {"input_tokens": -1, "output_tokens": 3},
            {"input_tokens": "12", "output_tokens": 3},
            {"input_tokens": 10**400, "output_tokens": 3},
        ],
        ids=["negative", "non-numeric", "huge-integer"],
    )
    async def test_omits_usage_for_invalid_token_counters(self, provider: _ProviderCase, usage: Any):
        client = _fake_client(_response_body({"q": {"type": "noul", "noul": 1}}, usage=usage))
        decision = provider.model_cls(api_key="test-key", http_client=client)

        result = await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

        assert result.usage is None

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("payload", "choices", "message"),
        [
            ([], "boolean", "decision provider response must be an object"),
            ({"model": "resolved-model", "answers": []}, "boolean", "decision provider answers must be an object"),
            (_response_body({}), "boolean", "omitted answer for question"),
            (_response_body({"q": {"type": "choice"}}), "boolean", "must have type 'noul'"),
            (_response_body({"q": {"type": "noul", "noul": 2}}), "boolean", "must be in [0.0, 1.0]"),
            (_response_body({"q": {"type": "noul", "noul": 10**400}}), "boolean", "must be in [0.0, 1.0]"),
            (
                _response_body({"q": {"type": "noul", "noul": -0.1}}),
                "boolean",
                "must be a non-negative finite number",
            ),
            (_response_body({"q": {"type": "noul"}}), ["a", "b"], "must have type 'choice'"),
            (
                _response_body({"q": {"type": "choice", "choice": "a", "probabilities": [], "confidence": 0.5}}),
                ["a", "b"],
                "probabilities for question id=<q> must be an object",
            ),
            (
                _response_body(
                    {
                        "q": {
                            "type": "choice",
                            "choice": "other",
                            "probabilities": {"a": 0.5, "b": 0.5},
                            "confidence": 0.5,
                        }
                    }
                ),
                ["a", "b"],
                "selected an unknown choice",
            ),
            (
                _response_body(
                    {
                        "q": {
                            "type": "choice",
                            "choice": "a",
                            "probabilities": {"a": 1.0},
                            "confidence": 1.0,
                        }
                    }
                ),
                ["a", "b"],
                "must contain exactly the requested choices",
            ),
            (
                _response_body(
                    {
                        "q": {
                            "type": "choice",
                            "choice": "a",
                            "probabilities": {"a": 1.0, "b": 0.0},
                            "confidence": 2.0,
                        }
                    }
                ),
                ["a", "b"],
                "must be in [0.0, 1.0]",
            ),
            (_response_body({"q": {"type": "noul", "noul": 1}}, usage=[]), "boolean", "usage must be an object"),
        ],
        ids=[
            "response-not-object",
            "answers-not-object",
            "answer-omitted",
            "wrong-boolean-answer-type",
            "invalid-noul-probability",
            "huge-integer-noul-probability",
            "negative-noul-probability",
            "wrong-choice-answer-type",
            "probabilities-not-object",
            "unknown-choice",
            "probability-keys-mismatch",
            "invalid-choice-confidence",
            "usage-not-object",
        ],
    )
    async def test_rejects_malformed_provider_responses(
        self, provider: _ProviderCase, payload: Any, choices: str | list[str], message: str
    ):
        client = _fake_client(payload)
        decision = provider.model_cls(api_key="test-key", http_client=client)

        with pytest.raises(StructuredOutputException, match=re.escape(message)):
            await decision.ask("state", {"q": {"question": "pick?", "choices": choices}})

    @pytest.mark.asyncio
    async def test_rejects_an_invalid_response_model_id(self, provider: _ProviderCase):
        client = _fake_client({"model": "", "answers": {"q": {"type": "noul", "noul": 1}}})
        decision = provider.model_cls(api_key="test-key", http_client=client)

        with pytest.raises(StructuredOutputException, match="model must be a non-empty string"):
            await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

    @pytest.mark.asyncio
    async def test_rejects_a_choice_answer_that_is_not_the_most_probable(self, provider: _ProviderCase):
        client = _fake_client(
            _response_body(
                {"q": {"type": "choice", "choice": "a", "probabilities": {"a": 0.4, "b": 0.6}, "confidence": 0.2}}
            )
        )
        decision = provider.model_cls(api_key="test-key", http_client=client)

        with pytest.raises(StructuredOutputException, match="must have the highest probability"):
            await decision.ask("state", {"q": {"question": "pick?", "choices": ["a", "b"]}})

    @pytest.mark.asyncio
    async def test_rejects_malformed_probability_distributions(self, provider: _ProviderCase):
        client = _fake_client(
            _response_body(
                {"q": {"type": "choice", "choice": "a", "probabilities": {"a": 0.4, "b": 0.4}, "confidence": 0.1}}
            )
        )
        decision = provider.model_cls(api_key="test-key", http_client=client)

        with pytest.raises(StructuredOutputException, match="must sum to 1"):
            await decision.ask("state", {"q": {"question": "pick?", "choices": ["a", "b"]}})

    @pytest.mark.asyncio
    async def test_accepts_choice_probabilities_rounded_to_four_decimals(self, provider: _ProviderCase):
        # Live strands-decider output: ten probabilities rounded to 4 decimals sum to 1.0001.
        probabilities = {
            "payments": 0.1056,
            "fraud": 0.0067,
            "onboarding": 0.0053,
            "tax": 0.0032,
            "identity": 0.0035,
            "payouts": 0.8215,
            "disputes": 0.0089,
            "refunds": 0.0076,
            "pricing": 0.0031,
            "support": 0.0347,
        }
        client = _fake_client(
            _response_body(
                {"q": {"type": "choice", "choice": "payouts", "probabilities": probabilities, "confidence": 0.8017}}
            )
        )
        decision = provider.model_cls(api_key="test-key", http_client=client)

        result = await decision.ask("state", {"q": {"question": "pick?", "choices": list(probabilities)}})

        assert result.answers == {"q": "payouts"}

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "probabilities",
        [
            # Rounded to 4 decimals, but the sum is past the rounding bound of 2 * 5e-5.
            {"a": 0.5001, "b": 0.5001},
            # Within the rounding bound, but rounding can't produce values off the 4-decimal grid.
            {"a": 0.50003, "b": 0.50003},
        ],
        ids=["past-bound", "off-grid"],
    )
    async def test_rejects_choice_probabilities_that_sum_just_past_the_bound(
        self, provider: _ProviderCase, probabilities: dict[str, float]
    ):
        client = _fake_client(
            _response_body({"q": {"type": "choice", "choice": "a", "probabilities": probabilities, "confidence": 0}})
        )
        decision = provider.model_cls(api_key="test-key", http_client=client)

        with pytest.raises(StructuredOutputException, match="must sum to 1"):
            await decision.ask("state", {"q": {"question": "pick?", "choices": ["a", "b"]}})

    @pytest.mark.asyncio
    async def test_rejects_more_than_255_choice_options_before_sending(self, provider: _ProviderCase):
        captured: list[httpx.Request] = []
        client = _fake_client(_response_body({}), captured=captured)
        decision = provider.model_cls(api_key="test-key", http_client=client)
        choices = [f"choice-{index}" for index in range(256)]

        with pytest.raises(ValueError, match="at most 255 choices"):
            await decision.ask("state", {"q": {"question": "pick?", "choices": choices}})
        assert captured == []

    @pytest.mark.asyncio
    async def test_serializes_the_body_as_compact_unescaped_utf8(self, provider: _ProviderCase):
        captured: list[httpx.Request] = []
        client = _fake_client(_response_body({"q": {"type": "noul", "noul": 1}}), captured=captured)
        decision = provider.model_cls(api_key="test-key", http_client=client)

        await decision.ask("caf\u00e9 \u3042", {"q": {"question": "ok?", "choices": "boolean"}})

        content = captured[0].content
        assert "caf\u00e9 \u3042".encode() in content
        assert b"\\u" not in content
        assert b", " not in content

    @pytest.mark.asyncio
    async def test_rejects_binary_nested_below_the_top_level_block(self, provider: _ProviderCase):
        captured: list[httpx.Request] = []
        client = _fake_client(_response_body({}), captured=captured)
        decision = provider.model_cls(api_key="test-key", http_client=client)
        state = [{"toolResult": {"content": [{"image": {"format": "png", "source": {"bytes": b"\x01\x02"}}}]}}]

        with pytest.raises(ValueError, match="do not support binary ContentBlock state"):
            await decision.ask(state, {"q": {"question": "ok?", "choices": "boolean"}})
        assert captured == []

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("value", "message"),
        [({"a"}, "Object of type set is not JSON serializable"), (float("nan"), "Out of range float values")],
        ids=["non-serializable", "nan"],
    )
    async def test_rejects_state_that_is_not_valid_json_with_value_error(
        self, provider: _ProviderCase, value: Any, message: str
    ):
        captured: list[httpx.Request] = []
        client = _fake_client(_response_body({}), captured=captured)
        decision = provider.model_cls(api_key="test-key", http_client=client)
        state = [{"toolResult": {"content": [{"json": {"value": value}}]}}]

        with pytest.raises(ValueError, match=message):
            await decision.ask(state, {"q": {"question": "ok?", "choices": "boolean"}})
        assert captured == []

    @pytest.mark.asyncio
    async def test_rejects_non_json_numeric_constants(self, provider: _ProviderCase):
        body = (
            '{"model":"resolved-model","answers":{"q":{"type":"noul","noul":1}},'
            '"usage":{"input_tokens":Infinity,"output_tokens":3}}'
        )
        client = _fake_text_client(body)
        decision = provider.model_cls(api_key="test-key", http_client=client)

        with pytest.raises(StructuredOutputException, match="returned a non-JSON response") as caught:
            await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

        assert isinstance(caught.value.__cause__, ValueError)

    @pytest.mark.asyncio
    async def test_rejects_an_overflowing_float_probability(self, provider: _ProviderCase):
        # 1e999 parses to float("inf"); parse_constant only rejects the Infinity/NaN literals.
        client = _fake_text_client('{"model":"resolved-model","answers":{"q":{"type":"noul","noul":1e999}}}')
        decision = provider.model_cls(api_key="test-key", http_client=client)

        with pytest.raises(StructuredOutputException, match="must be a non-negative finite number"):
            await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

    @pytest.mark.asyncio
    async def test_propagates_a_closed_client_error(self, provider: _ProviderCase):
        client = _fake_client(_response_body({"q": {"type": "noul", "noul": 1}}))
        await client.aclose()
        decision = provider.model_cls(api_key="test-key", http_client=client)

        with pytest.raises(RuntimeError, match="client has been closed"):
            await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})


@pytest.mark.parametrize("provider", _PROVIDERS, ids=_PROVIDER_IDS)
class TestConstruction:
    def test_requires_its_provider_specific_api_key(self, provider: _ProviderCase):
        with pytest.raises(ValueError, match=provider.api_key_env):
            provider.model_cls()

    @pytest.mark.parametrize("model_id", ["", "  "], ids=["empty", "whitespace"])
    def test_rejects_an_empty_model_id(self, provider: _ProviderCase, model_id: str):
        with pytest.raises(ValueError, match="model_id must be a non-empty string"):
            provider.model_cls(api_key="test-key", model_id=model_id)

    @pytest.mark.parametrize("threshold", [-0.1, 1.1, float("nan"), float("inf")])
    def test_rejects_an_invalid_provider_default_threshold(self, provider: _ProviderCase, threshold: float):
        with pytest.raises(ValueError, match=r"default_min_confidence must be in \[0.0, 1.0\]"):
            provider.model_cls(api_key="test-key", default_min_confidence=threshold)

    def test_rejects_a_non_numeric_provider_default_threshold(self, provider: _ProviderCase):
        with pytest.raises(ValueError, match=r"default_min_confidence must be in \[0.0, 1.0\]"):
            provider.model_cls(api_key="test-key", default_min_confidence="high")

    def test_rejects_a_non_async_http_client(self, provider: _ProviderCase):
        with pytest.raises(TypeError, match="http_client must be an httpx.AsyncClient"):
            provider.model_cls(api_key="test-key", http_client=httpx.Client())

    def test_omits_the_api_key_from_the_config_repr(self, provider: _ProviderCase):
        decision = provider.model_cls(api_key="secret-test-key")

        assert "secret-test-key" not in repr(decision._provider_config)


@pytest.mark.asyncio
async def test_typesafe_reads_its_api_key_from_the_environment(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("TYPESAFE_API_KEY", "typesafe-env-key")
    captured: list[httpx.Request] = []
    decision = TypeSafeDecisionModel(
        http_client=_fake_client(_response_body({"q": {"type": "noul", "noul": 1}}), captured=captured)
    )

    await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

    assert captured[0].headers["authorization"] == "Bearer typesafe-env-key"


@pytest.mark.asyncio
async def test_decisions_api_reads_its_api_key_from_the_environment(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("JEV_API_KEY", "decisions-env-key")
    captured: list[httpx.Request] = []
    decision = DecisionsAPIDecisionModel(
        http_client=_fake_client(_response_body({"q": {"type": "noul", "noul": 1}}), captured=captured)
    )

    await decision.ask("state", {"q": {"question": "ok?", "choices": "boolean"}})

    assert captured[0].headers["authorization"] == "Bearer decisions-env-key"


@pytest.mark.asyncio
async def test_decisions_api_enforces_the_question_count_limit_before_sending():
    captured: list[httpx.Request] = []
    decision = DecisionsAPIDecisionModel(
        api_key="test-key", http_client=_fake_client(_response_body({}), captured=captured)
    )
    questions = {f"q{index}": {"question": f"question {index}?", "choices": "boolean"} for index in range(9)}

    with pytest.raises(ValueError, match="at most 8 questions"):
        await decision.ask("state", questions)
    assert captured == []


def test_importing_strands_does_not_import_httpx():
    # httpx imports optional dependencies such as rich when installed, so the providers load lazily.
    env = os.environ.copy()
    python_path = str(Path(__file__).resolve().parents[3] / "src")
    if existing_python_path := env.get("PYTHONPATH"):
        python_path = os.pathsep.join((python_path, existing_python_path))
    env["PYTHONPATH"] = python_path

    code = """
import sys

import strands
import strands.decisions

if "httpx" in sys.modules:
    raise AssertionError("httpx imported eagerly")
strands.decisions.TypeSafeDecisionModel
if "httpx" not in sys.modules:
    raise AssertionError("TypeSafeDecisionModel did not load lazily")
"""
    subprocess.run([sys.executable, "-c", code], check=True, env=env)


def test_unknown_decisions_attribute_raises_attribute_error():
    import strands.decisions

    with pytest.raises(AttributeError, match="cannot import name 'MissingDecisionModel'"):
        strands.decisions.MissingDecisionModel  # noqa: B018
