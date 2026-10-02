"""LLMDecisionModel answers from token logprobs: probabilities and confidence from the value token.

The fixtures are real Bedrock Converse responses (forced tool, ``top_logprobs=20``) from Qwen3-32B and Ministral 3 8B;
only ``-9999`` entries are dropped.
"""

import json
import math
import pathlib
import unittest.mock
from typing import Annotated, Literal

import pytest

import strands.models.bedrock
from strands.experimental.decisions import (
    Choice,
    ChoiceAnswer,
    DecisionAgent,
    DecisionSchema,
    DecisionStrategy,
    LLMDecisionModel,
    Score,
    ScoreAnswer,
    YesNo,
    YesNoAnswer,
)
from strands.experimental.decisions._logprobs import label_logits, logprob_tokens
from strands.models.bedrock import BedrockModel
from tests.fixtures.mocked_model_provider import MockedModelProvider

_FIXTURES = pathlib.Path(__file__).parent / "fixtures"


def _fixture(name):
    return json.loads((_FIXTURES / f"converse_logprobs_{name}.json").read_text())


class Ticket(DecisionSchema):
    dept: Annotated[Literal["billing", "shipping", "technical"], Choice("Which department?")]
    anger: Annotated[float, Score("How angry?", levels=["calm", "annoyed", "frustrated", "angry", "furious"])]
    cancel: Annotated[bool, YesNo("Threatens to cancel?")]


class _LogprobModel(MockedModelProvider):
    """Replies with the answer tool call; its Converse ``messageStop`` carries ``content`` logprobs."""

    def __init__(self, values, content, *, fields=None):
        tool = {"toolUse": {"toolUseId": "t1", "name": "DecisionAnswers", "input": values}}
        super().__init__([{"role": "assistant", "content": [tool]}])
        self.fields = {"choices": [{"logprobs": {"content": content}}]} if fields is None else fields

    async def stream(self, messages, tool_specs=None, system_prompt=None, tool_choice=None, **kwargs):
        async for event in super().stream(messages, tool_specs, system_prompt, tool_choice, **kwargs):
            if "messageStop" in event:
                event = {"messageStop": {**event["messageStop"], "additionalModelResponseFields": self.fields}}
            yield event


def _recorded(name, **overrides):
    recorded = _fixture(name)
    return _LogprobModel({**recorded["tool_input"], **overrides}, recorded["content"])


def _tokens(*pieces):
    """Generated tokens; a piece is ``text`` or ``(text, [(alternative, logprob), ...])``."""
    tokens = []
    for piece in pieces:
        text, top = piece if isinstance(piece, tuple) else (piece, [(piece, 0.0)])
        tokens.append(
            {"token": text, "logprob": top[0][1], "top_logprobs": [{"token": t, "logprob": p} for t, p in top]}
        )
    return tokens


@pytest.mark.asyncio
async def test_logprobs_give_every_answer_probabilities_and_a_confidence():
    tru_decision = await LLMDecisionModel(_recorded("qwen3_32b")).decide(
        Ticket, state="parcel late, refund or I cancel"
    )

    assert (tru_decision.output.dept, tru_decision.output.cancel) == ("shipping", True)
    assert tru_decision.output.anger == pytest.approx(2.77, abs=0.01)  # probability-weighted level, not the argmax
    dept, anger, cancel = (tru_decision.answers[name] for name in ("dept", "anger", "cancel"))
    assert isinstance(dept, ChoiceAnswer) and isinstance(anger, ScoreAnswer) and isinstance(cancel, YesNoAnswer)
    assert dept.probabilities == pytest.approx({"billing": 0.2223, "shipping": 0.7760, "technical": 0.0017}, abs=1e-4)
    assert sum(dept.probabilities.values()) == pytest.approx(1.0)
    assert dept.confidence == pytest.approx(dept.probabilities["shipping"])
    assert anger.probabilities[3] == pytest.approx(0.7567, abs=1e-4)
    assert anger.confidence == pytest.approx(max(anger.probabilities.values()))
    assert cancel.probability == pytest.approx(0.9994, abs=1e-4)
    assert cancel.confidence == pytest.approx(abs(2 * cancel.probability - 1))


@pytest.mark.asyncio
async def test_first_token_keys_a_multi_token_label():
    # Ministral spells "billing" as "b" + "illing": the option is keyed by its first token.
    tru_response = await LLMDecisionModel(_recorded("ministral_3_8b")).ask(
        "s",
        {
            "dept": Choice("?", options=dict.fromkeys(["billing", "shipping", "technical"])),
            "anger": Score("?", levels=["0", "1", "2", "3", "4"]),
            "cancel": YesNo("?"),
        },
    )

    dept = tru_response.answers["dept"]
    assert dept.choice == "billing"
    assert dept.probabilities == pytest.approx({"billing": 0.9241, "shipping": 0.0759, "technical": 0.0}, abs=1e-4)
    assert tru_response.answers["anger"].probabilities[4] == pytest.approx(0.7865, abs=1e-4)


@pytest.mark.asyncio
async def test_confidence_gates_route_on_logprob_confidence():
    strategy_engine = LLMDecisionModel(_recorded("qwen3_32b"))
    agent = DecisionAgent(
        strategy_engine,
        Ticket,
        route_on="dept",
        routes={name: (lambda n: lambda d, p: n)(name) for name in ("billing", "shipping", "technical")},
        min_confidence=0.9,
        fallback=lambda decision, prompt: "general",
    )

    result = await agent.invoke_async("parcel late")

    assert str(result).strip() == "general"  # shipping at 0.776 is below the 0.9 gate
    DecisionStrategy(LLMDecisionModel(_recorded("qwen3_32b")), min_confidence=0.7)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fields",
    [
        None,
        {},
        {"choices": []},
        {"choices": [{}]},
        {"choices": [{"logprobs": None}]},
        {"choices": [{"logprobs": {"content": []}}]},
        {"choices": [{"logprobs": {"content": [{"logprob": -0.1}]}}]},
        "not-a-mapping",
    ],
)
async def test_absent_or_malformed_logprobs_answer_one_hot_without_confidence(fields):
    llm = _LogprobModel({"q_ok": True, "q_team": "billing"}, [], fields=fields)

    tru_response = await LLMDecisionModel(llm).ask(
        "s", {"ok": YesNo("?"), "team": Choice("?", options=dict.fromkeys(["billing", "technical"]))}
    )

    assert tru_response.answers["ok"] == YesNoAnswer(probability=1.0)
    assert tru_response.answers["team"] == ChoiceAnswer("billing", {"billing": 1.0, "technical": 0.0})


@pytest.mark.asyncio
async def test_no_logprob_event_at_all_answers_one_hot_like_before():
    plain = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [{"toolUse": {"toolUseId": "t1", "name": "DecisionAnswers", "input": {"q_level": 1}}}],
            }
        ]
    )

    tru_response = await LLMDecisionModel(plain).ask("s", {"level": Score("?", levels=["a", "b"])})

    assert tru_response.answers["level"] == ScoreAnswer(score=1.0, probabilities={0: 0.0, 1: 1.0})


@pytest.mark.asyncio
async def test_an_unreadable_field_answers_one_hot_while_others_keep_confidence():
    tokens = _tokens(
        '{"',
        "q_team",
        '":',
        ' "',
        ("bill", [("bill", -0.1), ("tech", -2.4)]),
        'ing", "q_ok":',
        (" false", [(" false", -0.2), (" true", -1.8)]),
        "}",
    )
    llm = _LogprobModel({"q_team": "billing", "q_ok": False}, tokens)

    tru_response = await LLMDecisionModel(llm).ask(
        "s", {"team": Choice("?", options=dict.fromkeys(["billing", "billboard"])), "ok": YesNo("?")}
    )

    team = tru_response.answers["team"]
    assert team == ChoiceAnswer("billing", {"billing": 1.0, "billboard": 0.0})  # "bill" begins both options
    ok = tru_response.answers["ok"]
    assert ok.probability == pytest.approx(math.exp(-1.8) / (math.exp(-0.2) + math.exp(-1.8)))
    assert ok.confidence is not None


def test_value_token_is_the_first_one_after_the_field_key():
    tokens = _tokens(
        '{"', "q", "_team", '":', ' "', ("ship", [("ship", -0.2), ("bill", -1.8), (" ship", -3.0)]), 'ping"}'
    )

    read = label_logits(tokens, "q_team", Choice("?", options=dict.fromkeys(["billing", "shipping"])), "shipping")

    assert read.logits == pytest.approx({"shipping": math.log(math.exp(-0.2) + math.exp(-3.0)), "billing": -1.8})
    assert read.label_mass == pytest.approx(math.exp(-0.2) + math.exp(-3.0) + math.exp(-1.8))


def test_value_token_inside_the_colon_token_is_found():
    # Some tokenizers fuse the colon and the value: '":"' or '": true'.
    tokens = _tokens('{"q_ok', ('": true', [('": true', -0.1), ('": false', -2.5)]), "}")

    read = label_logits(tokens, "q_ok", YesNo("?"), True)

    assert read.logits == {True: -0.1, False: -2.5}


def test_the_last_occurrence_of_the_field_key_is_used():
    # The field name can also appear earlier (for example inside a reasoning channel).
    tokens = _tokens("q_ok", '":', " maybe", ' {"q_ok":', (" false", [(" false", -0.3), (" true", -1.4)]), "}")

    read = label_logits(tokens, "q_ok", YesNo("?"), False)

    assert read.logits == {False: -0.3, True: -1.4}


@pytest.mark.parametrize(
    ("tokens", "question", "value", "reason"),
    [
        (
            _tokens('{"q_x":', ' "', ("c", [("c", -0.1), ("b", -2.0)]), '"}'),
            Choice("?", options=dict.fromkeys(["a", "b", "c"])),
            "c",
            "label_outside_top_k",
        ),
        (
            _tokens('{"q_x":', ' "', ("b", [("b", -0.1), ("a", -2.0)]), '"}'),
            Choice("?", options=dict.fromkeys(["a", "b"])),
            "a",
            "value_mismatch",
        ),
        (
            _tokens('{"q_x":', " ", ("2", [("2", -0.1), ("1", -2.0), ("0", -5.0)]), "}"),
            Score("?", levels=["a", "b", "c"]),
            2,
            None,
        ),
        (
            _tokens('{"q_x":', " ", ("1", [("1", -0.1), ("10", -2.0)])),
            Score("?", levels=[str(i) for i in range(11)]),
            1,
            "shared_first_token",
        ),
        (_tokens('{"q_x":', "   "), YesNo("?"), True, "field_not_found"),
        (_tokens('{"q_y": true}'), YesNo("?"), True, "field_not_found"),
    ],
)
def test_unreadable_value_tokens_are_reported_not_raised(tokens, question, value, reason):
    read = label_logits(tokens, "q_x", question, value)

    assert read == reason if reason else set(read.logits) == {0, 1, 2}


def test_an_alternative_that_begins_two_labels_refuses_the_logits():
    tokens = _tokens('{"q_x":', ' "', ("ship", [("ship", -0.1), ("bill", -2.0)]), 'ping"}')
    question = Choice("?", options=dict.fromkeys(["billing", "billboard", "shipping"]))

    assert label_logits(tokens, "q_x", question, "shipping") == "shared_first_token"


def test_forbidden_and_malformed_alternatives_are_ignored():
    tokens = _tokens('{"q_ok":', (" true", [(" true", -0.1), (" false", -9999.0), (" True", -3.0)]), "}")
    tokens[1]["top_logprobs"] += [{"token": " false", "logprob": "x"}, {"token": 5, "logprob": -1.0}, "junk"]

    assert label_logits(tokens, "q_ok", YesNo("?"), True) == "label_outside_top_k"

    tokens[1]["top_logprobs"].append({"token": "false", "logprob": -4.0})
    read = label_logits(tokens, "q_ok", YesNo("?"), True)
    assert read.logits == pytest.approx({True: math.log(math.exp(-0.1) + math.exp(-3.0)), False: -4.0})


def test_a_token_without_top_logprobs_uses_its_own_logprob():
    tokens = [{"token": '{"q_ok":'}, {"token": " true", "logprob": -0.01}]

    assert label_logits(tokens, "q_ok", YesNo("?"), True) == "label_outside_top_k"


def test_logprob_tokens_reads_only_a_converse_message_stop():
    content = [{"token": "a", "logprob": -0.1}]
    event = {
        "event": {"messageStop": {"additionalModelResponseFields": {"choices": [{"logprobs": {"content": content}}]}}}
    }

    assert logprob_tokens(event) == content
    assert logprob_tokens({"event": {"contentBlockStop": {}}}) is None
    assert logprob_tokens({"output": object()}) is None
    assert logprob_tokens({"event": "x"}) is None


@pytest.mark.asyncio
async def test_bedrock_model_non_streaming_passes_logprobs_through_to_the_answers():
    recorded = _fixture("qwen3_32b")
    with unittest.mock.patch.object(strands.models.bedrock.boto3, "Session") as session_cls:
        client = session_cls.return_value.client.return_value
        client.meta.region_name = "us-west-2"
        client.converse.return_value = {
            "output": {
                "message": {
                    "role": "assistant",
                    "content": [
                        {"toolUse": {"toolUseId": "t1", "name": "DecisionAnswers", "input": recorded["tool_input"]}}
                    ],
                }
            },
            "stopReason": "tool_use",
            "usage": {"inputTokens": 384, "outputTokens": 34, "totalTokens": 418},
            "metrics": {"latencyMs": 308},
            "additionalModelResponseFields": {"choices": [{"logprobs": {"content": recorded["content"]}}]},
        }
        bedrock = BedrockModel(
            model_id="qwen.qwen3-32b-v1:0",
            streaming=False,
            additional_request_fields={"logprobs": True, "top_logprobs": 20},
            additional_response_field_paths=["/choices/0/logprobs"],
        )

        tru_decision = await LLMDecisionModel(bedrock).decide(Ticket, state="parcel late")

    request = client.converse.call_args.kwargs
    assert request["toolConfig"]["toolChoice"] == {"auto": {}}
    assert request["additionalModelRequestFields"] == {"logprobs": True, "top_logprobs": 20}
    assert request["additionalModelResponseFieldPaths"] == ["/choices/0/logprobs"]
    assert tru_decision.answers["dept"].probabilities["shipping"] == pytest.approx(0.7760, abs=1e-4)
    assert tru_decision.answers["dept"].confidence == pytest.approx(0.7760, abs=1e-4)
    assert tru_decision.usage["outputTokens"] == 34
