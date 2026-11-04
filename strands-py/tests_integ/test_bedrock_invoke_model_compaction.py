"""Anthropic on-demand compaction over Bedrock InvokeModel, with boto3 only.

A tool-using agent loop on a preserved-thinking Claude model with strict thinking binding: it compacts the opening
turns mid-task through ``invoke_model``, keeps the last assistant turn (with its thinking) after the compaction block,
and finishes the task. Every later request replays the thinking blocks returned after the compaction; strict binding
makes any invalidated thinking a 400 instead of a silent drop.

The compaction helpers come from ``strands.models._anthropic_compaction``, which must import without ``anthropic``.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any

import boto3
import pytest
from botocore.config import Config

from strands.models._anthropic_compaction import (
    COMPACTION_BETA,
    compaction_params,
    format_native_block,
    from_last_native_block,
    read_compaction,
)
from strands.types.content import Message, Messages

REGION = os.environ.get("STRANDS_INTEG_BEDROCK_REGION", "us-west-2")
MAIN_MODEL_ID = os.environ.get("STRANDS_INTEG_MAIN_MODEL_ID", "us.anthropic.claude-sonnet-5-5")
SUMMARIZER_MODEL_ID = os.environ.get("STRANDS_INTEG_SUMMARIZER_MODEL_ID", "us.anthropic.claude-haiku-5-5")

BINDING_BETA = "thinking-binding-controls-2026-08-01"
BETAS = [BINDING_BETA, COMPACTION_BETA]
STRICT_THINKING = {"type": "adaptive", "block_binding": {"prefix_mismatch_behavior": "error"}}
CODEWORD = "PELICAN"
STEPS = 7
COMPACT_AFTER_TURNS = 3
EXPECTED_SUM = sum((n * 7) % 53 for n in range(1, STEPS + 1))
SYSTEM = "You are a careful assistant that follows the task exactly."
TASK = (
    f"Read steps 1 to {STEPS} in order with read_step, one call per turn. Every read_step call must pass codeword "
    f'"{CODEWORD}". When all steps are read, reply with exactly: DONE <sum of the values>.'
)
INSTRUCTIONS = (
    "Summarize the conversation so far for the assistant that continues it. Restate the original task from the "
    "first user message word for word, including the codeword. List every step already read with its value. "
    "Do not call tools; respond with the summary text only."
)
TOOLS = [
    {
        "name": "read_step",
        "description": "Read the value of one step.",
        "input_schema": {
            "type": "object",
            "properties": {"n": {"type": "integer"}, "codeword": {"type": "string"}},
            "required": ["n", "codeword"],
        },
    }
]
THINKING_TYPES = ("thinking", "redacted_thinking")


def test_compaction_helpers_import_without_anthropic() -> None:
    code = (
        "import sys; sys.modules['anthropic'] = None\n"
        "import strands.models._anthropic_compaction, strands.models.bedrock\n"
        "assert sys.modules['anthropic'] is None\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def _has_aws_credentials() -> bool:
    return boto3.Session().get_credentials() is not None


def _invoke(client: Any, model_id: str, body: dict[str, Any]) -> dict[str, Any]:
    body = {"anthropic_version": "bedrock-2023-05-31", "anthropic_beta": BETAS, **body}
    response = client.invoke_model(modelId=model_id, body=json.dumps(body))
    return json.loads(response["body"].read())


def _conversation_body(messages: Messages) -> dict[str, Any]:
    return {
        "max_tokens": 8192,
        "system": SYSTEM,
        "tools": TOOLS,
        "thinking": STRICT_THINKING,
        "messages": [_wire_message(message) for message in from_last_native_block(messages)],
    }


def _wire_message(message: Message) -> dict[str, Any]:
    """Send stored blocks as returned; a stored compaction block goes back as the block itself."""
    return {"role": message["role"], "content": [format_native_block(block) or block for block in message["content"]]}


def _assistant(response: dict[str, Any]) -> Message:
    content = [{key: value for key, value in block.items() if value is not None} for block in response["content"]]
    return Message(role="assistant", content=content)


def _tool_result(assistant: Message) -> Message:
    use = next(block for block in assistant["content"] if block.get("type") == "tool_use")
    n = int(use["input"]["n"])
    assert use["input"]["codeword"] == CODEWORD
    text = f"step {n}: the value is the x in 1..52 with (11 * x) mod 53 == {(n * 7 * 11) % 53}"
    return Message(role="user", content=[{"type": "tool_result", "tool_use_id": use["id"], "content": text}])


def _thinks(message: Message) -> bool:
    return any(block.get("type") in THINKING_TYPES for block in message["content"])


def _transformations(response: dict[str, Any]) -> Any:
    return (response.get("usage") or {}).get("input_transformations")


def _compact(client: Any, messages: Messages) -> Messages:
    """Compact everything before the last assistant turn; keep that turn, thinking included, after the block."""
    covered, kept = messages[:-2], messages[-2:]
    params = compaction_params(_conversation_body(covered), INSTRUCTIONS)
    body = {**{k: v for k, v in params.items() if k != "extra_body"}, **params["extra_body"]}
    response = _invoke(client, SUMMARIZER_MODEL_ID, body)
    assert response.get("stop_reason") == "compaction", response.get("stop_reason")
    compacted = read_compaction(response, SUMMARIZER_MODEL_ID)
    assert compacted is not None, "compaction returned no summary"
    block, _ = compacted
    return [
        covered[0],
        Message(role="assistant", content=[block, *kept[0]["content"]]),
        kept[1],
    ]


@pytest.mark.skipif(not _has_aws_credentials(), reason="needs AWS credentials with Bedrock access")
def test_compaction_over_invoke_model_preserves_thinking() -> None:
    config = Config(read_timeout=300, retries={"max_attempts": 4})
    client = boto3.client("bedrock-runtime", region_name=REGION, config=config)

    # Retry the opening until the turn kept after the compaction block thought, so the binding is exercised.
    for _ in range(4):
        messages: Messages = [Message(role="user", content=[{"type": "text", "text": TASK}])]
        for _ in range(COMPACT_AFTER_TURNS):
            assistant = _assistant(_invoke(client, MAIN_MODEL_ID, _conversation_body(messages)))
            messages += [assistant, _tool_result(assistant)]
        if _thinks(messages[-2]):
            break
    else:
        pytest.skip("model never thought on the turn kept after compaction")

    messages = _compact(client, messages)
    post_compaction_thinking = 1  # the kept assistant turn

    final: dict[str, Any] | None = None
    for _ in range(STEPS * 2):
        response = _invoke(client, MAIN_MODEL_ID, _conversation_body(messages))
        assert not _transformations(response), f"thinking was rewritten: {_transformations(response)}"
        assistant = _assistant(response)
        messages.append(assistant)
        post_compaction_thinking += _thinks(assistant)
        if response["stop_reason"] != "tool_use":
            final = response
            break
        messages.append(_tool_result(assistant))

    assert final is not None, "task did not finish"
    text = "".join(block.get("text", "") for block in final["content"] if block.get("type") == "text")
    assert f"DONE {EXPECTED_SUM}" in text, text
    # Later requests replayed thinking from after the block and the model kept thinking.
    assert post_compaction_thinking >= 2, post_compaction_thinking
