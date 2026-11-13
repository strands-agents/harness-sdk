"""Offline coverage of harness injectors through the real OpenAI Responses request formatter."""

import json
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from strands import tool
from strands.memory import MemoryEntry
from strands.models import CacheConfig, openai_responses

from strands_harness import create_harness


@tool
def read_status() -> str:
    """Read the local test status."""
    return "Local status: ready."


async def _response(response_id, *events):
    yield SimpleNamespace(type="response.created", response=SimpleNamespace(id=response_id))
    for event in events:
        yield event
    yield SimpleNamespace(type="response.completed", response=SimpleNamespace(usage=None))


def _input_text_blocks(request):
    return [
        block
        for item in request["input"]
        for block in item.get("content", item.get("output", []))
        if isinstance(block, dict) and block.get("type") == "input_text"
    ]


MEMORY = "Offline memory: releases ship on Thursdays."


class _FixedMemory:
    name = "memory"
    description = None
    max_search_results = None
    writable = False
    extraction = None

    async def search(self, query, options=None):
        return [MemoryEntry(content=MEMORY)]


def _durable_history(messages):
    """The conversation without injected blocks, which the model reads only for their own turn."""
    return [
        {**message, "content": [block for block in message["content"] if "injected" not in block]}
        for message in messages
    ]


def _is_temporary(block):
    return "<system-reminder>" in block["text"] or "<memory>" in block["text"]


@pytest.fixture
def client(monkeypatch):
    # Only the OpenAI network client is mocked: resolution, injection, tool execution,
    # streaming conversion, and the local environment reader all run normally.
    # Without a key, a request that escapes the client mock fails instead of reaching OpenAI.
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    # Bedrock Mantle mints its bearer token locally from these fake credentials.
    monkeypatch.delenv("AWS_PROFILE", raising=False)
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.delenv("AWS_SESSION_TOKEN", raising=False)
    # boto3 reads AWS_DEFAULT_REGION (not AWS_REGION) when Mantle resolves its region.
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    client = AsyncMock()
    client_cls = MagicMock()
    client_cls.return_value.__aenter__.return_value = client
    monkeypatch.setattr(openai_responses.openai, "AsyncOpenAI", client_cls)
    return client


# Both providers resolve GPT-5.6+ to a Responses model whose model info takes cache points.
@pytest.mark.parametrize(
    ("model", "model_id"),
    [("openai/gpt-6-sol", "gpt-6-sol"), ("bedrock-mantle/openai.gpt-6-luna", "openai.gpt-6-luna")],
)
async def test_openai_injections_preserve_durable_cache_boundaries(monkeypatch, tmp_path, client, model, model_id):
    monkeypatch.chdir(tmp_path)
    project_context = "Offline project guidance: keep transient context out of history."
    (tmp_path / "AGENTS.md").write_text(project_context)

    responses = [
        _response("resp_1", SimpleNamespace(type="response.output_text.delta", delta="First answer.")),
        _response(
            "resp_2",
            SimpleNamespace(
                type="response.output_item.added",
                item=SimpleNamespace(type="function_call", call_id="call_status", id="item_status", name="read_status"),
            ),
            SimpleNamespace(type="response.function_call_arguments.delta", item_id="item_status", delta="{}"),
        ),
        _response("resp_3", SimpleNamespace(type="response.output_text.delta", delta="Status checked.")),
        _response("resp_4", SimpleNamespace(type="response.output_text.delta", delta="Final answer.")),
    ]
    requests = []
    histories_at_request = []

    async def respond(**request):
        assert len(requests) < len(responses), "Unexpected extra model call"
        # OpenAI merges extra_body into the JSON payload; record that wire shape so
        # extension fields work with clients that do not expose named kwargs yet.
        wire_request = deepcopy(request)
        wire_request.update(wire_request.pop("extra_body", {}) or {})
        requests.append(wire_request)
        histories_at_request.append(deepcopy(agent.messages))
        return responses[len(requests) - 1]

    client.responses.create.side_effect = respond
    # The harness resolver uses provider/model, not provider:model. Leave caching at
    # its default so this also covers propagation from the harness to the SDK model.
    agent = create_harness(
        model=model,
        session=False,
        memory={"stores": [_FixedMemory()]},
        skills=False,
        builtin_tools=[],
        builtin_plugins=["environment", "todos"],
        tools=[read_status],
        context_manager=False,
        background_tasks=False,
        callback_handler=None,
    )
    assert isinstance(agent.model, openai_responses.OpenAIResponsesModel)
    assert agent.model.config["cache_config"] == CacheConfig(strategy="auto")

    prompts = ["First question.", "Check the local status.", "Final question."]
    todo_labels = ["Planning the first request", "Checking the second request", "Finishing the third request"]
    histories_after_invocation = []
    for prompt, label in zip(prompts, todo_labels, strict=True):
        agent.state.set("todos", [{"content": label, "activeForm": label, "status": "in_progress"}])
        result = await agent.invoke_async(prompt)
        assert result.stop_reason == "end_turn"
        histories_after_invocation.append(deepcopy(agent.messages))

    assert client.responses.create.await_count == 4
    assert [len(history) for history in histories_after_invocation] == [2, 6, 8]
    assert agent.model.stateful is False
    # The system prompt starts the cached prefix, so per-turn context must never reach it.
    assert len({request["instructions"] for request in requests}) == 1
    for request in requests:
        assert request["model"] == model_id
        assert request["stream"] is True
        assert request["store"] is False
        assert "previous_response_id" not in request
        assert request["prompt_cache_options"]["mode"] == "explicit"
        assert {spec["name"] for spec in request["tools"]} == {"read_status", "todo_write", "search_memory"}

    # Every invocation gets fresh environment/todo context; only todos resurface on
    # the tool-result continuation because environment's trigger is userTurn.
    for request_index, label_index in enumerate([0, 1, 1, 2]):
        request = requests[request_index]
        blocks = _input_text_blocks(request)
        reminders = [block for block in blocks if _is_temporary(block)]
        memories = [block for block in reminders if MEMORY in block["text"]]
        # Memory, like environment, is injected on user turns only, never on the tool continuation.
        assert len(memories) == (0 if request_index == 2 else 1)
        todo_reminders = [block for block in reminders if "Your current todo list:" in block["text"]]
        assert len(todo_reminders) == 1
        assert todo_labels[label_index] in todo_reminders[0]["text"]
        assert all(
            label not in json.dumps(request["input"]) for label in todo_labels if label != todo_labels[label_index]
        )
        environment = [block for block in reminders if "<environment>" in block["text"]]
        if request_index == 2:
            assert environment == []
        else:
            assert len(environment) == 1
            assert project_context in environment[0]["text"]
            assert "Working directory:" in environment[0]["text"]
            assert "Date:" in environment[0]["text"]
        assert all("prompt_cache_breakpoint" not in block for block in reminders)
        assert any("prompt_cache_breakpoint" in block for block in blocks), blocks
        boundary = max(i for i, block in enumerate(blocks) if "prompt_cache_breakpoint" in block)
        assert blocks[boundary]["prompt_cache_breakpoint"] == {"mode": "explicit"}
        assert all(boundary < blocks.index(block) for block in reminders)
        expected_boundary = "Local status: ready." if request_index == 2 else prompts[label_index]
        assert blocks[boundary]["text"] == expected_boundary

    # The previous request's entire stable input prefix (including its checkpoint)
    # must survive on the next call after ephemeral reminder blocks are removed.
    for previous, current in zip(requests[:-1], requests[1:], strict=True):
        stable_prefix = deepcopy(previous["input"])
        if stable_prefix[-1].get("role") == "user":
            stable_prefix[-1]["content"] = [block for block in stable_prefix[-1]["content"] if not _is_temporary(block)]
            if not stable_prefix[-1]["content"]:
                stable_prefix.pop()
        assert current["input"][: len(stable_prefix)] == stable_prefix

    continuation = requests[2]["input"]
    output_index = next(i for i, item in enumerate(continuation) if item.get("type") == "function_call_output")
    assert continuation[output_index] == {
        "type": "function_call_output",
        "call_id": "call_status",
        "output": [
            {"type": "input_text", "text": "Local status: ready.", "prompt_cache_breakpoint": {"mode": "explicit"}}
        ],
    }
    assert continuation[output_index + 1]["role"] == "user"
    assert "Your current todo list:" in continuation[output_index + 1]["content"][0]["text"]

    # Inspect history both while the request is being sent and after each invocation,
    # not merely at the end where a leaking injector might already have cleaned up.
    injected_roles = [
        message["role"] for message in agent.messages if any("injected" in block for block in message["content"])
    ]
    assert all(role == "user" for role in injected_roles)
    for history in histories_at_request + histories_after_invocation:
        serialized = json.dumps(_durable_history(history))
        for transient in [
            "<system-reminder>",
            "<environment>",
            "<memory>",
            MEMORY,
            project_context,
            *todo_labels,
            "prompt_cache_breakpoint",
        ]:
            assert transient not in serialized
    durable = json.dumps(_durable_history(agent.messages))
    assert all(prompt in durable for prompt in prompts)
    assert "Local status: ready." in durable
    assert "call_status" in durable


@pytest.mark.parametrize(
    ("model", "cache_points"),
    [
        ("openai/gpt-6-sol", True),
        ("openai/gpt-4.1", False),
        ("bedrock-mantle/openai.gpt-6-luna", True),
        ("bedrock-mantle/openai.gpt-oss-120b", False),
    ],
)
@pytest.mark.parametrize("caching", [True, False])
async def test_openai_session_cache_key_follows_caching(monkeypatch, tmp_path, client, model, cache_points, caching):
    # With caching on, every OpenAI and Mantle model gets the per-session routing key; only models
    # that take cache points (GPT-5.6+) also get checkpoints. With caching off, the harness sends no
    # cache fields at all.
    monkeypatch.chdir(tmp_path)
    requests = []

    async def respond(**request):
        wire_request = deepcopy(request)
        wire_request.update(wire_request.pop("extra_body", {}) or {})
        requests.append(wire_request)
        return _response("resp_1", SimpleNamespace(type="response.output_text.delta", delta="Done."))

    client.responses.create.side_effect = respond
    agent = create_harness(
        model=model,
        caching=caching,
        session={"id": "cache-key-test", "dir": str(tmp_path / "sessions")},
        memory=False,
        skills=False,
        builtin_tools=[],
        builtin_plugins=[],
        context_manager=False,
        background_tasks=False,
        callback_handler=None,
    )
    await agent.invoke_async("Hello.")

    assert len(requests) == 1
    request = requests[0]
    if caching:
        assert request["prompt_cache_key"] == "strands-cache-key-test"
        assert ("prompt_cache_options" in request) is cache_points
        assert ("prompt_cache_breakpoint" in json.dumps(request["input"])) is cache_points
    else:
        assert "prompt_cache_key" not in request
        assert "prompt_cache_options" not in request
        assert "prompt_cache_breakpoint" not in json.dumps(request["input"])
