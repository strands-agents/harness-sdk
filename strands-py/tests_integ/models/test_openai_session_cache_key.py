"""A session-backed agent routes OpenAI prompt caching on its session id, end to end.

With ``cache_config=CacheConfig()`` and a ``SessionManager`` attached, every request the agent sends
carries ``prompt_cache_key = strands-<session_id>`` — derived automatically, no key management. These
tests drive the full path (``Agent.invoke_async`` -> event loop -> ``model.stream`` -> request build)
against the real OpenAI API for both the Chat Completions and Responses surfaces, and confirm OpenAI
both accepts the derived key and returns a cache read on the repeat turn. A restart scenario rebuilds
the agent and model on the same session and confirms the restored prefix still reads the cache.

The outbound key is captured with a pass-through spy on the OpenAI resource ``create`` method: it
records ``prompt_cache_key`` and then performs the genuine network call, so nothing is stubbed. The
providers build a fresh client per request, so the spy patches the resource *class* to intercept all
of them.

Not decorated with ``retry_on_flaky``: a retry of the cache-read assertion would read the entry the
first attempt just wrote and pass, hiding a routing regression — the same reasoning as
``tests_integ/test_prompt_cache_per_call_content.py``.
"""

import os
import uuid

import openai
import pytest

from strands import Agent
from strands.models.model import CacheConfig
from strands.models.openai import OpenAIModel
from strands.session.file_session_manager import FileSessionManager
from tests_integ.models import providers
from tests_integ.models.providers import _openai_responses_available

if _openai_responses_available:
    from strands.models.openai_responses import OpenAIResponsesModel

# these tests only run if we have the openai api key
pytestmark = providers.openai.mark

# Automatic prompt caching is available on gpt-4o-mini for prefixes past ~1024 tokens.
MODEL_ID = "gpt-4o-mini"
SESSION_ID = "integ-openai-session-cache"
DERIVED_KEY = f"strands-{SESSION_ID}"
RESTORE_SESSION_ID = "integ-openai-session-restore"
RESTORE_DERIVED_KEY = f"strands-{RESTORE_SESSION_ID}"

# A shared system-prompt prefix long enough to clear OpenAI's minimum cacheable length.
DURABLE_SYSTEM_PREFIX = "You answer arithmetic questions with only the number and never add commentary. " * 200


def _chat_completions_class() -> type:
    return type(openai.AsyncOpenAI(api_key="probe-key-unused").chat.completions)


def _responses_class() -> type:
    return type(openai.AsyncOpenAI(api_key="probe-key-unused").responses)


def _cache_model_params():
    params = [pytest.param(OpenAIModel, _chat_completions_class, id="chat")]
    if _openai_responses_available:
        params.append(pytest.param(OpenAIResponsesModel, _responses_class, id="responses"))
    return params


def _spy_outbound_cache_key(monkeypatch, resource_class: type) -> list[str | None]:
    """Record each outbound ``prompt_cache_key``, then perform the real network call."""
    captured: list[str | None] = []
    original_create = resource_class.create

    async def spy_create(self, **kwargs):
        captured.append(kwargs.get("prompt_cache_key"))
        return await original_create(self, **kwargs)

    monkeypatch.setattr(resource_class, "create", spy_create)
    return captured


@pytest.mark.asyncio
@pytest.mark.parametrize("model_class,resource_class_fn", _cache_model_params())
async def test_session_backed_agent_routes_and_reuses_prompt_cache_key(
    model_class, resource_class_fn, monkeypatch, tmp_path, quiet_strands_logging
):
    """Both turns carry ``strands-<session_id>`` and the repeat turn reads the cached prefix."""
    captured = _spy_outbound_cache_key(monkeypatch, resource_class_fn())
    model = model_class(
        model_id=MODEL_ID,
        client_args={"api_key": os.getenv("OPENAI_API_KEY")},
        cache_config=CacheConfig(),
    )
    session_manager = FileSessionManager(session_id=SESSION_ID, storage_dir=str(tmp_path))
    # A per-run nonce makes turn 1 a guaranteed cold write, so turn 2's read is caused by this run.
    system_prompt = f"Session {uuid.uuid4()}. {DURABLE_SYSTEM_PREFIX}"
    agent = Agent(model=model, system_prompt=system_prompt, session_manager=session_manager)

    await agent.invoke_async("What is 2+2? Answer with just the number.")
    result = await agent.invoke_async("What is 3+3? Answer with just the number.")

    assert len(captured) >= 2 and all(key == DERIVED_KEY for key in captured)
    assert result.metrics.accumulated_usage.get("cacheReadInputTokens", 0) > 0


@pytest.mark.asyncio
@pytest.mark.parametrize("model_class,resource_class_fn", _cache_model_params())
async def test_cache_key_empty_string_opts_out(model_class, resource_class_fn, monkeypatch, tmp_path):
    """``cache_key=""`` sends no ``prompt_cache_key`` even with a session attached."""
    captured = _spy_outbound_cache_key(monkeypatch, resource_class_fn())
    model = model_class(
        model_id=MODEL_ID,
        client_args={"api_key": os.getenv("OPENAI_API_KEY")},
        cache_config=CacheConfig(cache_key=""),
    )
    session_manager = FileSessionManager(session_id=SESSION_ID, storage_dir=str(tmp_path))
    agent = Agent(model=model, system_prompt="Answer with just the number.", session_manager=session_manager)

    await agent.invoke_async("What is 1+1? Answer with just the number.")

    assert captured and all(key is None for key in captured)


@pytest.mark.asyncio
@pytest.mark.parametrize("model_class,resource_class_fn", _cache_model_params())
async def test_restored_session_reuses_prompt_cache_key(
    model_class, resource_class_fn, monkeypatch, tmp_path, quiet_strands_logging
):
    """A session restored into a fresh agent and model still routes on ``strands-<session_id>`` and hits the cache.

    Simulates a process restart: warm the cache, drop the agent and model, then rebuild both on the same session
    id and storage so the session manager rehydrates the prior turns before the first post-restart request.
    """
    captured = _spy_outbound_cache_key(monkeypatch, resource_class_fn())
    # One nonce shared by both lifetimes: identical prefix so restore can hit, unique per run so the read is ours.
    system_prompt = f"Restore {uuid.uuid4()}. {DURABLE_SYSTEM_PREFIX}"

    def _build_agent() -> Agent:
        model = model_class(
            model_id=MODEL_ID,
            client_args={"api_key": os.getenv("OPENAI_API_KEY")},
            cache_config=CacheConfig(),
        )
        session_manager = FileSessionManager(session_id=RESTORE_SESSION_ID, storage_dir=str(tmp_path))
        return Agent(model=model, system_prompt=system_prompt, session_manager=session_manager)

    agent_before = _build_agent()
    await agent_before.invoke_async("What is 2+2? Answer with just the number.")
    await agent_before.invoke_async("What is 3+3? Answer with just the number.")
    del agent_before

    agent_after = _build_agent()
    assert len(agent_after.messages) > 0  # the session manager rehydrated the prior turns

    result = await agent_after.invoke_async("What is 5+5? Answer with just the number.")

    assert len(captured) >= 3 and all(key == RESTORE_DERIVED_KEY for key in captured)
    assert result.metrics.accumulated_usage.get("cacheReadInputTokens", 0) > 0
