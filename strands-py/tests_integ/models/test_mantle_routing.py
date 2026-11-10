"""Drift detection for the hand-maintained Mantle base-path table (#3654).

Mantle serves each model from exactly one base path (``/v1`` or ``/openai/v1``), rejects
the other with HTTP 400, and exposes no API that reports the routing, so
:data:`strands.models._openai_bedrock._OPENAI_PATH_MODEL_PREFIXES` goes stale whenever Mantle
onboards a model. For every model in the live catalog, this test asserts that the
resolved path serves it, probing the other path only on failure to distinguish misrouted
from unserved ids. Only HTTP 200 and 400 count as answers. A misrouted or unserved model
fails the test; a model that never settles on 200/400 after retries is inconclusive
(transient throttling, or an unentitled model) and skips the test rather than holding the gate.

Failure means the table needs updating, not that the SDK is broken for existing models.
"""

import concurrent.futures
import json
import os
import time
import urllib.error
import urllib.request
from typing import NoReturn

import pytest

from strands.models._openai_bedrock import _resolve_mantle_base_path, resolve_bedrock_client_args
from tests_integ.conftest import retry_on_flaky

_REGION = "us-east-1"
_BASE = f"https://bedrock-mantle.{_REGION}.api.aws"
_TIMEOUT = 30
_MAX_WORKERS = 8

# Statuses that answer "does this route serve this model": 200 yes, 400 no. Everything
# else is inconclusive and must not be read as "no".
_DEFINITIVE = (200, 400)
_ATTEMPTS = 3

# Models that answer on neither OpenAI-compatible base path. The Anthropic family is served
# from /anthropic/v1/messages (a different protocol, reached via AnthropicModel, not
# OpenAIModel), so it is out of scope for this table.
_NOT_OPENAI_COMPATIBLE_PREFIXES = ("anthropic.",)


def _skip_locally_or_fail_in_ci(message: str) -> NoReturn:
    """Skip when running locally, but keep CI permission regressions red."""
    if os.getenv("CI") == "true" or os.getenv("GITHUB_ACTIONS") == "true":
        pytest.fail(message)
    pytest.skip(message)


def _mint_token() -> str:
    """Mint a Mantle bearer token."""
    return resolve_bedrock_client_args({"region": _REGION})["api_key"]


def _token_or_skip() -> str:
    """Mint a Mantle bearer token, or skip when local prerequisites are absent."""
    try:
        return _mint_token()
    except Exception as e:  # noqa: BLE001 - any credential/import failure means "can't run here"
        _skip_locally_or_fail_in_ci(f"cannot mint a Bedrock Mantle token: {e}")


def _list_models(token: str) -> list[str]:
    request = urllib.request.Request(f"{_BASE}/v1/models", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            _skip_locally_or_fail_in_ci(f"account lacks bedrock-mantle:ListModels ({e.code})")
        raise
    return sorted(model["id"] for model in payload["data"])


def _status(path: str, body: dict, token: str) -> int:
    """POST to a Mantle route and return the HTTP status (0 on timeout or transport error)."""
    request = urllib.request.Request(
        f"{_BASE}{path}",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
            return response.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:  # noqa: BLE001 - transport failure is undetermined, not "not served"
        return 0


def _status_settled(path: str, body: dict, token: str) -> int:
    """``_status`` retried with backoff until it answers 200/400, or the last status seen."""
    status = 0
    for attempt in range(_ATTEMPTS):
        status = _status(path, body, token)
        if status in _DEFINITIVE:
            return status
        if attempt < _ATTEMPTS - 1:
            time.sleep(2**attempt)
    return status


def _serves(base_path: str, model_id: str, token: str) -> bool | None:
    """Whether Mantle serves ``model_id`` from ``base_path``.

    Returns ``True`` if either API surface answers 200, ``False`` only if both
    definitively reject with 400, and ``None`` when a surface never settled (the route
    could not be determined and the caller must not treat that as "not served").
    """
    surfaces = (
        (
            "chat/completions",
            {"model": model_id, "messages": [{"role": "user", "content": "hi"}], "max_completion_tokens": 8},
        ),
        ("responses", {"model": model_id, "input": "hi", "max_output_tokens": 24}),
    )

    determined = True
    for surface, body in surfaces:
        status = _status_settled(f"{base_path}/{surface}", body, token)
        if status == 200:
            return True
        if status != 400:
            determined = False
    return False if determined else None


@retry_on_flaky(
    "Mantle can transiently fail the catalog listing or throttle a probe during a sweep; "
    "retry the whole sweep once so it gets another chance before it fails or skips. Real "
    "drift (misrouted/unserved) and the CI no-entitlement failure are deterministic and "
    "are not retried.",
    max_attempts=2,
    retry_on=[urllib.error.URLError, "mantle routing could not be verified"],
)
@pytest.mark.timeout(600)
def test_mantle_base_path_table_matches_live_catalog():
    """Every live Mantle model is routed to the base path it is actually served from.

    The 600s timeout covers the retry backoff a drifted or flaky sweep pays on both
    paths; a clean sweep finishes in under a minute.
    """
    models = [
        model_id
        for model_id in _list_models(_token_or_skip())
        if not model_id.startswith(_NOT_OPENAI_COMPATIBLE_PREFIXES)
    ]
    assert models, "Mantle returned no OpenAI-compatible models"

    def check(model_id: str) -> tuple[str, str, str]:
        """Classify ``model_id`` as ok / misrouted / unserved / undetermined.

        The resolved path is probed first, so a model served from both paths is ok.
        Minting per model keeps long sweeps inside the token's lifetime.
        """
        resolved = _resolve_mantle_base_path(model_id)
        other = "/openai/v1" if resolved == "/v1" else "/v1"

        on_resolved = _serves(resolved, model_id, _mint_token())
        if on_resolved:
            return model_id, "ok", resolved

        on_other = _serves(other, model_id, _mint_token())
        if on_other:
            return model_id, "misrouted", resolved
        if on_resolved is None or on_other is None:
            return model_id, "undetermined", resolved
        return model_id, "unserved", resolved

    with concurrent.futures.ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
        results = list(pool.map(check, models))

    def ids(verdict: str) -> dict[str, str]:
        return {model_id: resolved for model_id, outcome, resolved in results if outcome == verdict}

    misrouted = ids("misrouted")
    assert not misrouted, (
        "Mantle serves these models from the base path the SDK does not use. Update "
        "_OPENAI_PATH_MODEL_PREFIXES in strands/models/_openai_bedrock.py (and the TypeScript "
        f"mirror in strands-ts/src/models/openai/mantle.ts): {misrouted}"
    )

    unserved = ids("unserved")
    assert not unserved, (
        "Mantle lists these models but serves them from neither OpenAI-compatible base "
        "path, so OpenAIModel cannot reach them at all. They likely speak another "
        "protocol (as anthropic.* does via /anthropic/v1/messages) and need adding to "
        f"_NOT_OPENAI_COMPATIBLE_PREFIXES: {unserved}"
    )

    # Undetermined means Mantle never returned a definitive 200/400 (transient 429/5xx/timeout,
    # or a model the account is not entitled to). That is not routing drift, so skip rather than
    # hold the gate on an inconclusive external-service sweep. misrouted/unserved are checked
    # first so an inconclusive probe cannot read as a clean sweep.
    undetermined = ids("undetermined")
    if undetermined:
        pytest.skip(f"mantle routing could not be verified for: {undetermined}")
