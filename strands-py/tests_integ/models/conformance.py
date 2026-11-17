"""Model conformance: the cases and targets in shared/conformance.json, and the result record each run writes.

See shared/README.md for the file format, how a case applies to a model, and the result record.
"""

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
from tests_integ.models import providers

_SHARED = json.loads(
    (pathlib.Path(__file__).parents[2] / ".." / "shared" / "conformance.json").read_text(encoding="utf-8")
)
CASES: dict[str, dict[str, Any]] = _SHARED["cases"]

# Shared case and provider ids this SDK does not run, with the reason.
OMITTED_CASES: dict[str, str] = {}
OMITTED_PROVIDERS: dict[str, str] = {}

NOT_APPLICABLE = "not applicable"
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


def _marks(provider: str) -> list[pytest.MarkDecorator]:
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
        marks=_marks(row["provider"]),
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


def record(item: pytest.Item, report: pytest.TestReport) -> None:
    """Append the result record for a finished conformance test to STRANDS_CONFORMANCE_RESULTS."""
    path = os.environ.get("STRANDS_CONFORMANCE_RESULTS")
    case_id = getattr(getattr(item, "function", None), "conformance_case", None)
    ran = report.when == "call" or (report.when == "setup" and not report.passed)
    if not path or case_id is None or not ran:
        return

    target: Target = item.callspec.params["target"]
    result = {"sdk": "python", "provider": target.provider, "model": target.model_id, "case": case_id}
    if report.skipped:
        reason = str(report.longrepr[2]).removeprefix("Skipped: ")
        applicable = not reason.startswith(NOT_APPLICABLE)
        result["status"] = "skipped" if applicable else "not-applicable"
        result["reason"] = reason if applicable else reason.removeprefix(f"{NOT_APPLICABLE}: ")
    else:
        result["status"] = "passed" if report.passed else "failed"

    with open(path, "a", encoding="utf-8") as results:
        results.write(json.dumps(result) + "\n")
