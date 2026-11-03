"""Live: summarization on preserved-thinking Claude models over first-party Anthropic.

Needs ANTHROPIC_API_KEY, and runs only in GitHub Actions or with STRANDS_INTEG_NATIVE_COMPACTION=1, because the
integ setup also loads keys from AWS Secrets Manager and a local aggregate run must not start paid requests.
Bounded: one task of 7 tool turns and 2 forced summary passes per run, three runs.
"""

import dataclasses
import os
import re
from typing import Any

import pytest

from tests_integ import _native_compaction as harness
from tests_integ.models import providers

_OPTED_IN = os.environ.get("GITHUB_ACTIONS") == "true" or os.environ.get("STRANDS_INTEG_NATIVE_COMPACTION") == "1"
_MAIN_MODEL_ID = os.environ.get("STRANDS_INTEG_MAIN_MODEL_ID", harness.SONNET_5_5)
_SUMMARIZER_MODEL_ID = os.environ.get("STRANDS_INTEG_SUMMARIZER_MODEL_ID", harness.HAIKU_5_5)

pytestmark = [
    providers.anthropic.mark,
    pytest.mark.skipif(not _OPTED_IN, reason="set STRANDS_INTEG_NATIVE_COMPACTION=1 to run paid compaction requests"),
    pytest.mark.timeout(600),
]


def _options(**overrides: Any) -> harness.HarnessOptions:
    options = harness.HarnessOptions(
        api_key=os.environ["ANTHROPIC_API_KEY"],
        main_model_id=_MAIN_MODEL_ID,
        summarizer_model_id=_SUMMARIZER_MODEL_ID,
        server_side_compaction=True,
        thinking=harness.STRICT_THINKING,
        pass_before_calls=harness.PASSES,
    )
    return dataclasses.replace(options, **overrides)


def _assert_first_attempts_succeeded(report: harness.HarnessReport) -> None:
    """Every request succeeded on its first attempt: no 400, no reactive drop_block retry."""
    assert [exchange.status for exchange in report.exchanges if exchange.status != 200] == []
    assert report.drop_block_warnings == []


def _assert_every_pass_compacted_natively(report: harness.HarnessReport) -> None:
    """Every pass called native compaction on the summarizer, and none fell back to a client-side summary."""
    compactions = report.of_kind("compaction")
    assert report.passes == len(harness.PASSES)
    assert len(compactions) == len(harness.PASSES)
    assert report.of_kind("summarizer") == []
    assert all(exchange.model == _SUMMARIZER_MODEL_ID for exchange in compactions)


def _assert_task_finished(report: harness.HarnessReport) -> None:
    assert f"DONE {harness.EXPECTED_SUM}" in report.final_text


@pytest.mark.asyncio
async def test_compacts_every_pass_replays_each_block_unchanged_and_keeps_tail_thinking() -> None:
    report = await harness.run_compaction_task(_options())
    print(f"native run | {harness.describe_report(report)}")

    _assert_first_attempts_succeeded(report)
    _assert_every_pass_compacted_natively(report)

    # The opening run was compacted natively: its summary keeps the compaction block as Anthropic provider data.
    assert report.message_one_after.startswith("assistant:text+anthropic")

    # Each returned block is replayed exactly as returned on every later request, as the only compaction block.
    compactions = report.of_kind("compaction")
    conversations = report.of_kind("conversation")
    for compaction in compactions:
        assert len(compaction.returned) == 1
        block = compaction.returned[0]
        later = [
            exchange
            for exchange in conversations
            if any(sent.get("signature") == block.get("signature") for sent in exchange.sent_compaction)
        ]
        assert later
        assert all(exchange.sent_compaction == [block] for exchange in later)

    # Every replayed thinking block was returned earlier, thinking was replayed next to a compaction block, and
    # the API dropped no thinking block.
    returned_thinking = {signature for exchange in conversations for signature in exchange.returned_thinking}
    assert all(sent in returned_thinking for exchange in conversations for sent in exchange.sent_thinking)
    assert any(exchange.sent_compaction and exchange.sent_thinking for exchange in conversations)
    assert [entry for exchange in conversations for entry in exchange.input_transformations or []] == []
    # The field must have been seen on main-model responses, or the absence above proves nothing.
    assert any(exchange.input_transformations is not None for exchange in conversations)

    # The task survived the compaction of message 0, which stays verbatim, and finished.
    message_zero = report.message_zero_after
    assert (message_zero["role"], message_zero["content"]) == ("user", [{"text": harness.TASK}])
    for codewords in report.codewords_after_pass:
        assert codewords
        assert all(codeword == harness.CODEWORD for codeword in codewords)
    _assert_task_finished(report)
    assert report.total_tokens > 0


@pytest.mark.asyncio
async def test_compacts_up_to_a_pinned_message_and_never_past_it() -> None:
    report = await harness.run_compaction_task(_options(pin_before_first_pass=3))
    print(f"native pinned run | {harness.describe_report(report)}")

    _assert_first_attempts_succeeded(report)
    # The first pass compacts the messages before the pinned tool use; the second can't compact past it.
    assert len(report.of_kind("compaction")) == 1
    assert report.of_kind("summarizer") == []
    # The pinned tool use follows the summary in message 1, where it stood after the covered messages.
    assert re.match(r"^assistant:text\+anthropic,.*toolUse", report.message_one_after)
    conversations = report.of_kind("conversation")
    returned_thinking = {signature for exchange in conversations for signature in exchange.returned_thinking}
    assert all(sent in returned_thinking for exchange in conversations for sent in exchange.sent_thinking)
    assert [entry for exchange in conversations for entry in exchange.input_transformations or []] == []
    _assert_task_finished(report)


@pytest.mark.asyncio
async def test_takes_the_client_side_path_when_the_capability_is_unset() -> None:
    report = await harness.run_compaction_task(_options(server_side_compaction=None, thinking=harness.BASE_THINKING))
    print(f"base control | {harness.describe_report(report)}")

    assert report.of_kind("compaction") == []
    assert len(report.of_kind("summarizer")) == len(harness.PASSES)
    assert all(exchange.sent_compaction == [] for exchange in report.exchanges)
    assert not report.message_one_after.startswith("assistant:text+anthropic")
    _assert_task_finished(report)
