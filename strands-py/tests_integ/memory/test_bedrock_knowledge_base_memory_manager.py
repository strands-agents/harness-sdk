"""Live MemoryManager E2E tests over ``BedrockKnowledgeBaseStore``.

These drive the full :class:`~strands.memory.MemoryManager` (extraction, injection, and the
search/add tools) through a real :class:`~strands.Agent` against a live Bedrock Knowledge Base, so
they need BOTH a Bedrock model and the KB and skip unless both are available.

Each block enables ONLY the manager feature it asserts and turns the rest off, so a pass cannot be
explained by an unintended path (e.g. the injection tests disable the search tool, so a correct
answer can only have come from the auto-injected ``<memory>`` context).

Notes on coverage:

* **Injection asserts the model input, not history.** ``_observe_model_input`` captures the per-call
  messages the model receives, so the tests check the folded ``<memory>`` block (and that durable
  ``agent.messages`` is left untouched).
* **Extraction uses an explicit extractor.** The store keeps ``extraction`` verbatim and the manager
  reads ``store.extraction.trigger`` directly, so these tests pass an explicit
  ``ExtractionConfig(trigger=..., extractor=ModelExtractor())`` (the extractor defaults to the
  agent's model).
* **Tool forcing** uses an ``InvokeModelStage.Input`` middleware that sets ``ctx.tool_choice`` once.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import replace
from typing import Any

import boto3
import pytest

from strands import Agent
from strands._middleware.stages import InvokeModelStage
from strands.memory.extraction.model_extractor import ModelExtractor
from strands.memory.extraction.triggers import IntervalTrigger, InvocationTrigger
from strands.memory.extraction.types import ExtractionConfig
from strands.memory.memory_manager import MemoryManager
from strands.models.bedrock import BedrockModel
from strands.vended_memory_stores.bedrock_knowledge_base import (
    BedrockKnowledgeBaseConfig,
    BedrockKnowledgeBaseStore,
)

from ._bedrock_kb_test_helpers import (
    cleanup_custom_document,
    search_until,
    unique_marker,
    wait_for_indexed,
)

# Bedrock KB ingestion is eventually consistent and routinely exceeds the global 90s per-test cap
# once indexing (up to 120s), agent turns, and the follow-on search poll are serialized; raise it.
pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(300)]

# The manager's default tool names (memory_manager.py: ``config.name ... else "search_memory"`` /
# ``"add_memory"``). Kept here so an assertion can't silently go stale if a default changes.
SEARCH_TOOL = "search_memory"
ADD_TOOL = "add_memory"

# A capable tool-using model, consistent with other Bedrock integ tests.
MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"


# --------------------------------------------------------------------------- #
# Fixtures and helpers
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="session")
def mm_clients():
    """Build the boto3 clients the manager E2E tests share (once per session)."""
    session = boto3.Session()
    return {"agent": session.client("bedrock-agent"), "runtime": session.client("bedrock-agent-runtime")}


@pytest.fixture
def skip_if_no_kb(bedrock_kb_context):
    """Skip a test when the live Bedrock KB is unavailable.

    These tests also need Bedrock model access; that surfaces as a runtime error if absent, since
    there is no separate model-availability probe here.
    """
    if bedrock_kb_context.should_skip:
        pytest.skip("Bedrock KB test-infra parameters not available")


def _make_model() -> BedrockModel:
    """Build the Bedrock model used to drive the agent."""
    return BedrockModel(model_id=MODEL_ID, max_tokens=1024)


def _make_store(
    bedrock_kb_context: Any,
    mm_clients: dict[str, Any],
    name: str,
    *,
    scope: str | None = None,
    extraction: ExtractionConfig | None = None,
) -> BedrockKnowledgeBaseStore:
    """Build a writable CUSTOM store with a unique scope so tests never cross-contaminate retrieval."""
    return BedrockKnowledgeBaseStore(
        config=BedrockKnowledgeBaseConfig(
            knowledge_base_id=bedrock_kb_context.knowledge_base_id,
            data_source_type="CUSTOM",
            data_source_id=bedrock_kb_context.custom_data_source_id,
            runtime_client=mm_clients["runtime"],
            agent_client=mm_clients["agent"],
        ),
        name=name,
        writable=True,
        scope=scope if scope is not None else unique_marker("mm-scope"),
        extraction=extraction,
    )


def _capture_added_ids(
    store: BedrockKnowledgeBaseStore,
    registrar: list,
    agent_client: Any,
    knowledge_base_id: str,
    data_source_id: str,
) -> list[str]:
    """Wrap ``store.add`` so every document id written *through the manager* is captured for cleanup.

    The manager discards the returned id (extraction/add_memory both drop it), so the only way to
    clean up those writes is to observe them at the ``add`` boundary. Shadows the bound method on the
    instance; the manager still recognizes the store as ``add``-capable because that check inspects the
    class. Returns the (live) id list and registers best-effort cleanup that deletes all captured ids.
    """
    ids: list[str] = []
    orig = store.add

    async def wrapped(content, metadata=None):
        result = await orig(content, metadata)
        ids.append(result.document_id)
        return result

    store.add = wrapped  # type: ignore[method-assign]

    def _cleanup() -> None:
        if not ids:
            return
        try:
            agent_client.delete_knowledge_base_documents(
                knowledgeBaseId=knowledge_base_id,
                dataSourceId=data_source_id,
                documentIdentifiers=[{"dataSourceType": "CUSTOM", "custom": {"id": doc_id}} for doc_id in ids],
            )
        except Exception:  # noqa: BLE001 - best-effort; don't mask test failures.
            pass

    registrar.append(_cleanup)
    return ids


async def _seed_fact(
    store: BedrockKnowledgeBaseStore,
    content: str,
    registrar: list,
    agent_client: Any,
    knowledge_base_id: str,
    data_source_id: str,
) -> str:
    """Seed a fact directly, wait for it to index, and register cleanup. Returns the document id."""
    result = await store.add(content)
    cleanup_custom_document(registrar, agent_client, knowledge_base_id, data_source_id, result.document_id)
    wait_for_indexed(
        agent_client,
        knowledge_base_id,
        data_source_id,
        {"dataSourceType": "CUSTOM", "custom": {"id": result.document_id}},
    )
    return result.document_id


def _force_tool_once(agent: Agent, tool_name: str) -> None:
    """Force ``tool_name`` on the FIRST model call only, via an ``InvokeModelStage.Input`` middleware.

    Removes the one nondeterministic variable in the tool tests (whether the model *chooses* to call
    the tool) while still exercising the real path: the manager registers the tool, the agent invokes
    it, and the result flows back. It must fire only once. Forcing on every call would loop forever,
    since the model could never emit its final text answer after the tool result.
    """
    state = {"forced": False}

    def handler(ctx):
        if state["forced"]:
            return ctx
        state["forced"] = True
        return replace(ctx, tool_choice={"tool": {"name": tool_name}})

    agent._middleware_registry.add_middleware(InvokeModelStage.Input, handler)


def _observe_model_input(agent: Agent) -> Callable[[], list[dict] | None]:
    """Capture the messages the model actually saw on the most recent call.

    Registers an ``InvokeModelStage.Input`` middleware that records ``ctx.messages`` (the per-call,
    post-injection copy the model receives). Returns a getter for the captured messages, so a test can
    assert what injection folded in without touching the agent's durable history.
    """
    captured: dict[str, list[dict] | None] = {"seen": None}

    def handler(ctx):
        captured["seen"] = ctx.messages
        return ctx

    agent._middleware_registry.add_middleware(InvokeModelStage.Input, handler)
    return lambda: captured["seen"]


async def _wait_for(predicate, *, timeout_s: float = 30.0, interval_s: float = 0.5) -> bool:
    """Poll ``predicate`` until it returns truthy or the timeout elapses."""
    deadline = time.monotonic() + timeout_s
    while True:
        if predicate():
            return True
        if time.monotonic() >= deadline:
            return False
        await asyncio.sleep(interval_s)


def _message_text(message: dict) -> str:
    """Concatenate the text blocks of a message."""
    return "".join(block.get("text", "") for block in message.get("content", []))


def _has_tool_use(messages: list[dict], tool_name: str) -> bool:
    """Return whether any message contains a ``toolUse`` block for ``tool_name``."""
    return any(
        "toolUse" in block and block["toolUse"].get("name") == tool_name
        for message in messages
        for block in message.get("content", [])
    )


# --------------------------------------------------------------------------- #
# Extraction (tools off; the only write path is extraction)
# --------------------------------------------------------------------------- #


class TestExtraction:
    """Autonomous extraction with the search/add tools off, so the only write path is extraction."""

    async def test_extracts_with_invocation_trigger(
        self, skip_if_no_kb, bedrock_kb_context, mm_clients, cleanup_registrar
    ):
        """With an InvocationTrigger (fires every turn), one turn extracts and stores a fact, no flush needed."""
        kb_id = bedrock_kb_context.knowledge_base_id
        ds_id = bedrock_kb_context.custom_data_source_id

        store = _make_store(
            bedrock_kb_context,
            mm_clients,
            "integ-mm-extract-invocation",
            extraction=ExtractionConfig(trigger=[InvocationTrigger()], extractor=ModelExtractor()),
        )
        ids = _capture_added_ids(store, cleanup_registrar, mm_clients["agent"], kb_id, ds_id)
        memory_manager = MemoryManager(stores=[store], search_tool_config=False, injection=False)
        agent = Agent(model=_make_model(), plugins=[memory_manager], callback_handler=None)

        marker = unique_marker("extract-invocation")
        await agent.invoke_async(f"Please remember this fact: the project codename is {marker}.")

        # No flush: the trigger fires on its own; the write is in the background.
        assert await _wait_for(lambda: len(ids) > 0)
        assert await search_until(store, marker, lambda entry: marker in entry.content) is not None

        # Drain any still-in-flight background writes so they're captured before cleanup.
        await memory_manager.flush()

    async def test_honors_interval_trigger_cadence(
        self, skip_if_no_kb, bedrock_kb_context, mm_clients, cleanup_registrar
    ):
        """An IntervalTrigger(2) stays idle after turn 1 and fires on turn 2, draining both buffered turns."""
        kb_id = bedrock_kb_context.knowledge_base_id
        ds_id = bedrock_kb_context.custom_data_source_id

        store = _make_store(
            bedrock_kb_context,
            mm_clients,
            "integ-mm-extract-interval",
            extraction=ExtractionConfig(trigger=[IntervalTrigger(turns=2)], extractor=ModelExtractor()),
        )
        ids = _capture_added_ids(store, cleanup_registrar, mm_clients["agent"], kb_id, ds_id)
        memory_manager = MemoryManager(stores=[store], search_tool_config=False, injection=False)
        agent = Agent(model=_make_model(), plugins=[memory_manager], callback_handler=None)

        marker = unique_marker("extract-interval")
        # Turn 1: the trigger should NOT fire yet (cadence is every 2 turns). Give the background path
        # a moment to prove it stays idle.
        await agent.invoke_async(f"Please remember this fact: the project codename is {marker}.")
        assert await _wait_for(lambda: len(ids) > 0, timeout_s=5.0) is False

        # Turn 2: the trigger fires, draining buffered messages from both turns.
        await agent.invoke_async("Thanks. Keep that in mind.")
        assert await _wait_for(lambda: len(ids) > 0)
        assert await search_until(store, marker, lambda entry: marker in entry.content) is not None

        await memory_manager.flush()

    async def test_flush_force_saves_when_trigger_not_fired(
        self, skip_if_no_kb, bedrock_kb_context, mm_clients, cleanup_registrar
    ):
        """When IntervalTrigger(5) hasn't fired after one turn, ``flush()`` force-saves the buffered turn on demand."""
        kb_id = bedrock_kb_context.knowledge_base_id
        ds_id = bedrock_kb_context.custom_data_source_id

        # IntervalTrigger(5) will not fire after a single turn, so the autonomous path writes nothing.
        # That is what makes flush() observable here.
        store = _make_store(
            bedrock_kb_context,
            mm_clients,
            "integ-mm-extract-flush",
            extraction=ExtractionConfig(trigger=[IntervalTrigger(turns=5)], extractor=ModelExtractor()),
        )
        ids = _capture_added_ids(store, cleanup_registrar, mm_clients["agent"], kb_id, ds_id)
        memory_manager = MemoryManager(stores=[store], search_tool_config=False, injection=False)
        agent = Agent(model=_make_model(), plugins=[memory_manager], callback_handler=None)

        marker = unique_marker("extract-flush")
        await agent.invoke_async(f"Please remember this fact: the project codename is {marker}.")

        assert await _wait_for(lambda: len(ids) > 0, timeout_s=5.0) is False

        # flush() bypasses the trigger schedule and force-saves the buffered turn on demand.
        await memory_manager.flush()
        assert len(ids) > 0
        assert await search_until(store, marker, lambda entry: marker in entry.content) is not None


# --------------------------------------------------------------------------- #
# Injection (search tool off; the only path to the fact is auto-injected context)
# --------------------------------------------------------------------------- #


class TestInjection:
    """Auto-injection of retrieved memory into the model input, with the search tool disabled so the
    only path to a seeded fact is the injected ``<memory>`` block."""

    async def test_folds_memory_block_into_model_input_without_touching_history(
        self, skip_if_no_kb, bedrock_kb_context, mm_clients, cleanup_registrar
    ):
        """Injection folds a ``<memory>`` block into the model input and never mutates durable history."""
        kb_id = bedrock_kb_context.knowledge_base_id
        ds_id = bedrock_kb_context.custom_data_source_id

        store = _make_store(bedrock_kb_context, mm_clients, "integ-mm-inject")
        answer = unique_marker("willow-tag")
        await _seed_fact(
            store,
            f"The weeping willow in the meditation garden carries botanical tag {answer}.",
            cleanup_registrar,
            mm_clients["agent"],
            kb_id,
            ds_id,
        )

        memory_manager = MemoryManager(stores=[store], injection=True, search_tool_config=False)
        agent = Agent(model=_make_model(), plugins=[memory_manager], callback_handler=None)
        get_seen = _observe_model_input(agent)

        # The answer is a non-guessable code, so a correct response can only come from the injected fact.
        prompt = "What botanical tag does the weeping willow in the meditation garden carry?"
        result = await agent.invoke_async(prompt)

        # 1. The model input carried the injected memory (ephemeral fold into the latest user message).
        seen = get_seen()
        assert seen is not None
        injected_text = "\n".join(_message_text(m) for m in seen)
        assert "<memory>" in injected_text
        assert f'source="{store.name}"' in injected_text
        assert answer in injected_text

        # 2. Durable history is untouched: the stored user message is byte-identical to the original
        #    prompt (injection folds into the per-call copy only, never agent.messages), and the search
        #    tool was never used (it is disabled), proving the answer came from injection, not a tool.
        first_user_message = next((m for m in agent.messages if m["role"] == "user"), None)
        assert first_user_message is not None
        assert _message_text(first_user_message) == prompt
        assert not _has_tool_use(agent.messages, SEARCH_TOOL)

        # 3. The model actually used the injected fact (the unique tag cannot be guessed).
        assert answer in _message_text(result.message)

    async def test_injects_from_multiple_stores_with_source_attribution(
        self, skip_if_no_kb, bedrock_kb_context, mm_clients, cleanup_registrar
    ):
        """Injection pulls from multiple stores, attributing each entry to its own source."""
        kb_id = bedrock_kb_context.knowledge_base_id
        ds_id = bedrock_kb_context.custom_data_source_id

        store_a = _make_store(bedrock_kb_context, mm_clients, "alpha")
        store_b = _make_store(bedrock_kb_context, mm_clients, "beta")
        willow = unique_marker("willow-tag")
        dove = unique_marker("dove-ring")
        await _seed_fact(
            store_a,
            f"The weeping willow in the meditation garden carries botanical tag {willow}.",
            cleanup_registrar,
            mm_clients["agent"],
            kb_id,
            ds_id,
        )
        await _seed_fact(
            store_b,
            f"The dove in the wildlife sanctuary wears identification ring {dove}.",
            cleanup_registrar,
            mm_clients["agent"],
            kb_id,
            ds_id,
        )

        memory_manager = MemoryManager(stores=[store_a, store_b], injection=True, search_tool_config=False)
        agent = Agent(model=_make_model(), plugins=[memory_manager], callback_handler=None)
        get_seen = _observe_model_input(agent)

        await agent.invoke_async("What is the willow's botanical tag, and what is the dove's identification ring?")

        seen = get_seen()
        assert seen is not None
        injected_text = "\n".join(_message_text(m) for m in seen)
        # Both stores contributed entries, each attributed to its own source and carrying its own fact
        # (asserting the unique codes too, so an empty entry cannot satisfy the test).
        assert 'source="alpha"' in injected_text
        assert 'source="beta"' in injected_text
        assert willow in injected_text
        assert dove in injected_text


# --------------------------------------------------------------------------- #
# search_memory tool (injection off; the only path to the fact is the tool)
# --------------------------------------------------------------------------- #


class TestSearchMemoryTool:
    """The ``search_memory`` tool, with the only path to a seeded fact being the tool itself."""

    async def test_model_retrieves_seeded_fact_via_search_tool(
        self, skip_if_no_kb, bedrock_kb_context, mm_clients, cleanup_registrar
    ):
        """The model retrieves a seeded fact via the ``search_memory`` tool and surfaces it in its answer."""
        kb_id = bedrock_kb_context.knowledge_base_id
        ds_id = bedrock_kb_context.custom_data_source_id

        store = _make_store(bedrock_kb_context, mm_clients, "integ-mm-search-tool")
        answer = unique_marker("dove-ring")
        await _seed_fact(
            store,
            f"The dove in the wildlife sanctuary wears identification ring {answer}.",
            cleanup_registrar,
            mm_clients["agent"],
            kb_id,
            ds_id,
        )

        # injection=False so the ONLY path to the seeded fact is the search tool, not auto-injection.
        memory_manager = MemoryManager(stores=[store], injection=False)
        agent = Agent(model=_make_model(), plugins=[memory_manager], callback_handler=None)
        _force_tool_once(agent, SEARCH_TOOL)

        result = await agent.invoke_async(
            "Use your memory tools to look up the dove's identification ring in the wildlife sanctuary, then tell me."
        )

        assert _has_tool_use(agent.messages, SEARCH_TOOL)
        assert answer in _message_text(result.message)

    async def test_routes_search_across_multiple_stores(
        self, skip_if_no_kb, bedrock_kb_context, mm_clients, cleanup_registrar
    ):
        """The manager fans the search tool across multiple stores and finds the fact wherever it lives."""
        kb_id = bedrock_kb_context.knowledge_base_id
        ds_id = bedrock_kb_context.custom_data_source_id

        store_a = _make_store(bedrock_kb_context, mm_clients, "integ-mm-search-a")
        store_b = _make_store(bedrock_kb_context, mm_clients, "integ-mm-search-b")
        # Fact lives only in store B; the manager must fan out across both.
        answer = unique_marker("dove-ring")
        await _seed_fact(
            store_b,
            f"The dove in the wildlife sanctuary wears identification ring {answer}.",
            cleanup_registrar,
            mm_clients["agent"],
            kb_id,
            ds_id,
        )

        # injection=False so the ONLY path to the seeded fact is the search tool, not auto-injection.
        memory_manager = MemoryManager(stores=[store_a, store_b], injection=False)
        agent = Agent(model=_make_model(), plugins=[memory_manager], callback_handler=None)
        _force_tool_once(agent, SEARCH_TOOL)

        result = await agent.invoke_async(
            "Use your memory tools to look up the dove's identification ring in the wildlife sanctuary, then tell me."
        )

        assert _has_tool_use(agent.messages, SEARCH_TOOL)
        assert answer in _message_text(result.message)


# --------------------------------------------------------------------------- #
# add_memory tool (search tool off; the only path is the add tool)
# --------------------------------------------------------------------------- #


class TestAddMemoryTool:
    """The ``add_memory`` tool, with the search tool off so the only write path is the add tool."""

    async def test_model_persists_fact_via_add_tool(
        self, skip_if_no_kb, bedrock_kb_context, mm_clients, cleanup_registrar
    ):
        """The model persists a fact via the ``add_memory`` tool, and it becomes searchable afterward."""
        kb_id = bedrock_kb_context.knowledge_base_id
        ds_id = bedrock_kb_context.custom_data_source_id

        store = _make_store(bedrock_kb_context, mm_clients, "integ-mm-add-tool")
        ids = _capture_added_ids(store, cleanup_registrar, mm_clients["agent"], kb_id, ds_id)

        # Search tool and injection off so the only path is the add tool.
        memory_manager = MemoryManager(stores=[store], add_tool_config=True, search_tool_config=False, injection=False)
        agent = Agent(model=_make_model(), plugins=[memory_manager], callback_handler=None)
        _force_tool_once(agent, ADD_TOOL)

        marker = unique_marker("add-tool")
        await agent.invoke_async(
            f"Please remember for later, using your memory tools: the quietest grove in the forest is "
            f"cataloged as {marker}."
        )

        assert _has_tool_use(agent.messages, ADD_TOOL)
        assert len(ids) > 0
        assert await search_until(store, marker, lambda entry: marker in entry.content) is not None
