"""Model conformance: the cases and targets in shared/conformance.json, and the result record each run writes.

See shared/README.md for the file format, how a case applies to a model, and the result record.
"""

import asyncio
import functools
import inspect
import itertools
import json
import os
import pathlib
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import pytest

from strands.models import BedrockModel, Model
from strands.models._model_info import _lookup_key
from strands.models.anthropic import AnthropicModel
from strands.models.gemini import GeminiModel
from strands.models.mistral import MistralModel
from strands.models.openai import OpenAIModel
from strands.types.exceptions import ModelThrottledException
from tests_integ.models import providers

_SHARED_DIRECTORY = pathlib.Path(__file__).parents[2] / ".." / "shared"
_SHARED = json.loads((_SHARED_DIRECTORY / "conformance.json").read_text(encoding="utf-8"))
# The entries as written, for the capabilities ModelInfo does not carry.
_MODEL_ENTRIES: dict[str, dict[str, Any]] = json.loads(
    (_SHARED_DIRECTORY / "model-info.json").read_text(encoding="utf-8")
)["models"]
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

# On a single call a model can skip a tool or ignore injected text, so these cases also retry a failed assertion.
# A target that does it often belongs in knownFailures as intermittent.
_RETRIES_ASSERTIONS = {"tool-use", "structured-output", "forced-tool-choice", "temporary-messages"}
# A provider can be unavailable for a short while, so an error that may clear gets a few spaced attempts.
_ATTEMPTS = 3
_RETRY_DELAY_SECONDS = 30
# Slow reasoning models can take over a minute; a call that takes longer than this is treated as hung.
_ATTEMPT_LIMIT_SECONDS = 180
# The cases call every listed model, so they only run when asked: "core" runs the targets marked core and any
# other value runs them all. See shared/README.md for when CI sets each.
MODE = os.environ.get("STRANDS_CONFORMANCE", "")
# HTTP statuses that mean the provider could not serve the call, which says nothing about the case.
_PROVIDER_ERROR_STATUSES = frozenset({401, 403, 404, 408, 429})
_MANTLE_CONFIG = {"region": "us-east-1"}
# Shared provider ids that call OpenAI's Chat Completions API.
_CHAT_COMPLETIONS_PROVIDERS = frozenset({"openai", "mantle"})


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
    if not MODE:
        return [pytest.mark.skip(reason="set STRANDS_CONFORMANCE to run the model conformance cases")]
    if MODE == "core" and not row.get("core"):
        return [pytest.mark.skip(reason="not in the core set that pull requests run")]
    if row.get("endOfLife"):
        return [pytest.mark.skip(reason=f"{NOT_APPLICABLE}: end of life")]
    if provider in OMITTED_PROVIDERS:
        return [pytest.mark.skip(reason=f"{NOT_APPLICABLE}: {OMITTED_PROVIDERS[provider]}")]
    if provider not in PROVIDERS:
        return []
    info = PROVIDERS[provider][0]
    return [info.mark] if info else [pytest.mark.skip(reason=f"{provider} provider is not importable")]


TARGET_PROVIDERS = {row["provider"] for row in _SHARED["targets"]}
# Model info entries no target resolves to, and the ones the shared file says are left out, with the reason.
UNTARGETED_ENTRIES = set(_MODEL_ENTRIES) - {_lookup_key(row["model"]) for row in _SHARED["targets"]}
UNTESTED: dict[str, str] = _SHARED["untested"]
LIVE_TARGETS = {(row["provider"], row["model"]) for row in _SHARED["targets"] if not row.get("endOfLife")}
TARGETS = [
    pytest.param(
        Target(row["provider"], row["model"]),
        id=f"{row['provider']}-{row['model']}",
        marks=_marks(row),
    )
    for row in _SHARED["targets"]
]

IMPLEMENTED: set[str] = set()


# The running test, set by a fixture, so the retry wrapper can see its target and count its attempts.
running_item: pytest.Item | None = None


def _within_attempt_limit(test: Callable, args: tuple, kwargs: dict[str, Any]) -> Any:
    """Run a sync test on a daemon thread, so a call that never answers ends the attempt and not the whole test.

    Nothing can stop the hung call, so it is left to finish on its own while the next attempt runs.
    """
    outcome: dict[str, Any] = {}

    def run() -> None:
        try:
            outcome["value"] = test(*args, **kwargs)
        except BaseException as error:  # re-raised on the test's own thread below
            outcome["error"] = error

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    thread.join(_ATTEMPT_LIMIT_SECONDS)
    if thread.is_alive():
        raise TimeoutError(f"the attempt did not finish within {_ATTEMPT_LIMIT_SECONDS} seconds")
    if "error" in outcome:
        raise outcome["error"]
    return outcome.get("value")


def _note_attempt(attempt: int) -> None:
    if running_item is not None:
        running_item.conformance_attempts = attempt


def _give_up(case_id: str, attempt: int, error: Exception) -> bool:
    known = _known_failure(running_item) if running_item else None
    # The tracked failure of a known failure is expected, so it is reported after one attempt.
    if attempt == _ATTEMPTS or (known and _is_tracked_failure(known, error)):
        return True
    if isinstance(error, AssertionError):
        return case_id not in _RETRIES_ASSERTIONS
    return _will_not_clear(error)


def case(case_id: str) -> Callable:
    """Mark a test as the implementation of a shared case, retried when another attempt may pass."""

    def decorator(test: Callable) -> Callable:
        @functools.wraps(test)
        def sync_test(*args: Any, **kwargs: Any) -> Any:
            for attempt in itertools.count(1):
                _note_attempt(attempt)
                try:
                    return _within_attempt_limit(test, args, kwargs)
                except Exception as error:
                    if _give_up(case_id, attempt, error):
                        raise
                time.sleep(_RETRY_DELAY_SECONDS)

        @functools.wraps(test)
        async def async_test(*args: Any, **kwargs: Any) -> Any:
            for attempt in itertools.count(1):
                _note_attempt(attempt)
                try:
                    return await asyncio.wait_for(test(*args, **kwargs), _ATTEMPT_LIMIT_SECONDS)
                except Exception as error:
                    if _give_up(case_id, attempt, error):
                        raise
                await asyncio.sleep(_RETRY_DELAY_SECONDS)

        wrapped = async_test if inspect.iscoroutinefunction(test) else sync_test
        wrapped.conformance_case = case_id
        IMPLEMENTED.add(case_id)
        return wrapped

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


def tool_limit_reason(case_id: str, target: Target) -> str | None:
    """Why the shared model info says the target cannot call the tools a case needs, or None."""
    if not CASES[case_id].get("tools"):
        return None
    capabilities = _MODEL_ENTRIES.get(_lookup_key(target.model_id) or "", {}).get("capabilities", {})
    if capabilities.get("toolUse") is False:
        return "capabilities.toolUse is false"
    if target.provider in _CHAT_COMPLETIONS_PROVIDERS and capabilities.get("chatCompletionsTools") == "unsupported":
        return "capabilities.chatCompletionsTools is unsupported"
    return None


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
        # asyncio's timeout is a class of its own before Python 3.11.
        if isinstance(error, (TimeoutError, asyncio.TimeoutError)):
            return f"{type(error).__name__} (no response)"
        status = _http_status(error)
        if status is not None and (status in _PROVIDER_ERROR_STATUSES or status >= 500):
            return f"{type(error).__name__} (HTTP {status})"
        error = error.__cause__ or error.__context__
    return None


def _will_not_clear(error: BaseException | None) -> bool:
    """Whether the provider rejected the request with a 4xx that is neither a timeout nor a throttle."""
    while error is not None:
        status = _http_status(error)
        if status is not None:
            return 400 <= status < 500 and status not in (408, 429)
        error = error.__cause__ or error.__context__
    return False


def _known_failure(item: pytest.Item) -> dict[str, Any] | None:
    case_id = getattr(getattr(item, "function", None), "conformance_case", None)
    if case_id is None:
        return None
    target: Target = item.callspec.params["target"]
    return KNOWN_FAILURES.get((target.provider, target.model_id, case_id))


def _is_tracked_failure(known: dict[str, Any], error: BaseException | None) -> bool:
    """Whether the error is the failure the entry tracks: a failed assertion, or an error carrying its text."""
    if "error" not in known:
        return isinstance(error, AssertionError)
    while error is not None:
        if known["error"] in str(error):
            return True
        error = error.__cause__ or error.__context__
    return False


def apply_known_failure(item: pytest.Item, call: pytest.CallInfo, report: pytest.TestReport) -> None:
    """Report the tracked failure of a known failure as expected, and its unexpected pass as a failure.

    Any other error on the pair is left as a failure, so a known failure cannot hide a different problem.
    """
    known = _known_failure(item)
    if known is None or call.when != "call":
        return
    if call.excinfo is None:
        if not known.get("intermittent"):
            report.outcome = "failed"
            report.longrepr = (
                f"known failure #{known['issue']} now passes; remove it from knownFailures in shared/conformance.json"
            )
    elif _is_tracked_failure(known, call.excinfo.value):
        report.outcome = "skipped"
        report.wasxfail = f"known failure: {known['reason']} See #{known['issue']}"


def _outcome(report: pytest.TestReport, error: BaseException | None) -> dict[str, str]:
    # A known failure that passes reports as failed with no exception, and one that fails reports as skipped.
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
    known = _known_failure(item)
    if known and hasattr(report, "wasxfail"):
        result["known"] = {"reason": known["reason"], "issue": known["issue"]}
    attempts = getattr(item, "conformance_attempts", 1)
    if attempts > 1:
        result["attempts"] = attempts

    with open(path, "a", encoding="utf-8") as results:
        results.write(json.dumps(result) + "\n")
