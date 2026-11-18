"""Model conformance: the cases and targets in shared/conformance.json, and the result record each run writes.

See shared/README.md for the file format, how a case applies to a model, and the result record.
"""

import itertools
import json
import os
import pathlib
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import pytest

from strands.models import BedrockModel, Model
from strands.models.anthropic import AnthropicModel
from strands.models.gemini import GeminiModel
from strands.models.mistral import MistralModel
from strands.models.openai import OpenAIModel
from strands.types.exceptions import ModelThrottledException
from tests_integ.models import providers

_SHARED = json.loads(
    (pathlib.Path(__file__).parents[2] / ".." / "shared" / "conformance.json").read_text(encoding="utf-8")
)
CASES: dict[str, dict[str, Any]] = _SHARED["cases"]
# (provider, model, case) -> the shared known failure entry, which names the issue tracking it.
KNOWN_FAILURES: dict[tuple[str, str, str], dict[str, Any]] = {
    (row["provider"], row["model"], row["case"]): row for row in _SHARED["knownFailures"]
}

# Shared case and provider ids this SDK does not run, with the reason.
OMITTED_CASES: dict[str, str] = {}
OMITTED_PROVIDERS: dict[str, str] = {}

# The caching case's system prompt, one guideline per topic and action pair: about twice the largest cache
# minimum among the targets, and ordinary prose so that no provider filters it.
CACHE_PROMPT = "\n".join(
    [_SHARED["cachePrompt"]["intro"]]
    + [
        f"{number}. When a customer asks about {topic}, {action}."
        for number, (topic, action) in enumerate(
            itertools.product(_SHARED["cachePrompt"]["topics"], _SHARED["cachePrompt"]["actions"]), start=1
        )
    ]
)

NOT_APPLICABLE = "not applicable"
# The cases call every listed model, so they only run when asked. CI sets this for the weekly run and for
# changes that can affect how a model behaves.
ENABLED = bool(os.environ.get("STRANDS_CONFORMANCE"))
# HTTP statuses that mean the provider could not serve the call, which says nothing about the case.
_PROVIDER_ERROR_STATUSES = frozenset({401, 403, 404, 408, 429})
_MANTLE_CONFIG = {"region": "us-east-1"}


def _openai_responses(**kwargs: Any) -> Model:
    from strands.models.openai_responses import OpenAIResponsesModel

    return OpenAIResponsesModel(**kwargs)


# Shared provider id -> (skip mark source, factory). Factories set only the model id, so the SDK's defaults are
# what the cases exercise.
PROVIDERS: dict[str, tuple[providers.ProviderInfo | None, Callable[[str], Model]]] = {
    "anthropic": (
        providers.anthropic,
        lambda model_id: AnthropicModel(client_args={"api_key": os.getenv("ANTHROPIC_API_KEY")}, model_id=model_id),
    ),
    "bedrock": (providers.bedrock, lambda model_id: BedrockModel(model_id=model_id)),
    "gemini": (
        providers.gemini,
        lambda model_id: GeminiModel(client_args={"api_key": os.getenv("GOOGLE_API_KEY")}, model_id=model_id),
    ),
    "mantle": (
        providers.mantle,
        lambda model_id: OpenAIModel(model_id=model_id, bedrock_mantle_config=_MANTLE_CONFIG),
    ),
    "mantle-responses": (
        providers.mantle_responses,
        lambda model_id: _openai_responses(model_id=model_id, bedrock_mantle_config=_MANTLE_CONFIG),
    ),
    "mistral": (
        providers.mistral,
        lambda model_id: MistralModel(model_id=model_id, api_key=os.getenv("MISTRAL_API_KEY")),
    ),
    "openai": (
        providers.openai,
        lambda model_id: OpenAIModel(model_id=model_id, client_args={"api_key": os.getenv("OPENAI_API_KEY")}),
    ),
    "openai-responses": (
        providers.openai_responses,
        lambda model_id: _openai_responses(model_id=model_id, client_args={"api_key": os.getenv("OPENAI_API_KEY")}),
    ),
}


@dataclass(frozen=True)
class Target:
    """One provider and model id pair from the shared targets."""

    provider: str
    model_id: str

    def create_model(self) -> Model:
        return PROVIDERS[self.provider][1](self.model_id)


def _marks(row: dict[str, Any]) -> list[pytest.MarkDecorator]:
    provider = row["provider"]
    if not ENABLED:
        return [pytest.mark.skip(reason="set STRANDS_CONFORMANCE=1 to run the model conformance cases")]
    if row.get("endOfLife"):
        return [pytest.mark.skip(reason=f"{NOT_APPLICABLE}: end of life")]
    if provider in OMITTED_PROVIDERS:
        return [pytest.mark.skip(reason=f"{NOT_APPLICABLE}: {OMITTED_PROVIDERS[provider]}")]
    if provider not in PROVIDERS:
        return []
    info = PROVIDERS[provider][0]
    return [info.mark] if info else [pytest.mark.skip(reason=f"{provider} provider is not importable")]


TARGET_PROVIDERS = {row["provider"] for row in _SHARED["targets"]}
TARGETS = [
    pytest.param(
        Target(row["provider"], row["model"]),
        id=f"{row['provider']}-{row['model']}",
        marks=_marks(row),
    )
    for row in _SHARED["targets"]
]

IMPLEMENTED: set[str] = set()


def case(case_id: str) -> Callable:
    """Mark a test as the implementation of a shared case."""

    def decorator(test: Callable) -> Callable:
        test.conformance_case = case_id
        IMPLEMENTED.add(case_id)
        return test

    return decorator


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def not_applicable_reason(case_id: str, model: Model) -> str | None:
    """Why the case does not apply to the model, or None when it does."""
    spec = CASES[case_id]
    path = spec.get("requires")
    if path is None:
        return None

    value: Any = model.model_info
    for name in path.split("."):
        value = getattr(value, _snake(name))
    if value is None:
        return f"{path} is unknown for this model"

    if "equals" not in spec:
        return None
    # Shared values are camelCase; the Python model info is snake_case.
    expected = _snake(spec["equals"]) if isinstance(spec["equals"], str) else spec["equals"]
    return None if value == expected else f"{path} is not {spec['equals']}"


def _http_status(error: BaseException) -> int | None:
    """The HTTP status a vendor SDK error carries, wherever that SDK keeps it."""
    response = getattr(error, "response", None)
    metadata = response.get("ResponseMetadata", {}) if isinstance(response, dict) else {}
    candidates = (getattr(error, "status_code", None), getattr(error, "code", None), metadata.get("HTTPStatusCode"))
    return next((status for status in candidates if isinstance(status, int)), None)


def provider_error_reason(error: BaseException | None) -> str | None:
    """Why a failure is the provider's (throttling, credentials, an outage, a model not served), or None."""
    while error is not None:
        if isinstance(error, ModelThrottledException):
            return type(error).__name__
        status = _http_status(error)
        if status is not None and (status in _PROVIDER_ERROR_STATUSES or status >= 500):
            return f"{type(error).__name__} (HTTP {status})"
        error = error.__cause__ or error.__context__
    return None


def _outcome(report: pytest.TestReport, error: BaseException | None) -> dict[str, str]:
    # A strict xfail that passes reports as failed with no exception, and one that fails reports as skipped.
    if report.passed or (report.failed and error is None):
        return {"status": "passed"}
    if hasattr(report, "wasxfail") or not report.skipped:
        reason = provider_error_reason(error)
        return {"status": "error", "reason": reason} if reason else {"status": "failed"}
    reason = str(report.longrepr[2]).removeprefix("Skipped: ")
    if reason.startswith(NOT_APPLICABLE):
        return {"status": "not-applicable", "reason": reason.removeprefix(f"{NOT_APPLICABLE}: ")}
    return {"status": "skipped", "reason": reason}


def record(item: pytest.Item, report: pytest.TestReport, error: BaseException | None) -> None:
    """Append the result record for a finished conformance test to STRANDS_CONFORMANCE_RESULTS."""
    path = os.environ.get("STRANDS_CONFORMANCE_RESULTS")
    case_id = getattr(getattr(item, "function", None), "conformance_case", None)
    ran = report.when == "call" or (report.when == "setup" and not report.passed)
    if not path or case_id is None or not ran:
        return

    target: Target = item.callspec.params["target"]
    result = {"sdk": "python", "provider": target.provider, "model": target.model_id, "case": case_id}
    result.update(_outcome(report, error))

    with open(path, "a", encoding="utf-8") as results:
        results.write(json.dumps(result) + "\n")
