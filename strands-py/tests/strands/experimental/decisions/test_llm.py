from typing import Annotated, Literal
from unittest import mock

import pytest
from pydantic import BaseModel

from strands.experimental.decisions import (
    Choice,
    ChoiceAnswer,
    LLMDecisionModel,
    Score,
    ScoreAnswer,
    YesNo,
    YesNoAnswer,
)
from tests.fixtures.mocked_model_provider import MockedModelProvider


class _StructuredModel(MockedModelProvider):
    """Replies with one ``DecisionAnswers`` tool call carrying ``values``, and records each stream request."""

    def __init__(self, values, *, usage=None, name="DecisionAnswers"):
        tool = {"toolUse": {"toolUseId": "t1", "name": name, "input": values}}
        super().__init__([{"role": "assistant", "content": [tool]}], usages=[usage] if usage else None)
        self.calls = []

    async def stream(self, messages, tool_specs=None, system_prompt=None, tool_choice=None, **kwargs):
        self.calls.append((tool_specs, messages, system_prompt, tool_choice))
        async for event in super().stream(messages, tool_specs, system_prompt, tool_choice, **kwargs):
            yield event


class Triage(BaseModel):
    department: Annotated[Literal["billing", "technical"], Choice("Which team?")]
    urgent: Annotated[bool, YesNo("Urgent?")]
    frustration: Annotated[float, Score("How frustrated?", levels=["calm", "upset", "angry"])]


@pytest.mark.asyncio
async def test_decide_runs_the_same_schema_on_an_llm_with_one_hot_answers():
    llm = _StructuredModel({"q_department": "technical", "q_urgent": True, "q_frustration": 2})
    engine = LLMDecisionModel(llm)

    tru_decision = await engine.decide(Triage, state={"ticket": "site down"})

    assert tru_decision.output == Triage(department="technical", urgent=True, frustration=2.0)
    assert tru_decision.answers == {
        "department": ChoiceAnswer(choice="technical", probabilities={"billing": 0.0, "technical": 1.0}),
        "urgent": YesNoAnswer(probability=1.0),
        "frustration": ScoreAnswer(score=2.0, probabilities={0: 0.0, 1: 0.0, 2: 1.0}),
    }
    assert all(answer.confidence is None for answer in tru_decision.answers.values())
    tool_specs, prompt, _, tool_choice = llm.calls[0]
    assert set(tool_specs[0]["inputSchema"]["json"]["properties"]) == {"q_department", "q_urgent", "q_frustration"}
    assert "site down" in prompt[0]["content"][0]["text"]
    assert tool_choice == {"auto": {}}  # models that reject a forced tool choice still work


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reply",
    [
        {"role": "assistant", "content": [{"text": "I think it is urgent."}]},
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": "other", "input": {}}}]},
    ],
    ids=["text_only", "wrong_tool"],
)
async def test_ask_raises_when_llm_does_not_call_the_answer_tool(reply):
    with pytest.raises(ValueError, match="no structured decision"):
        await LLMDecisionModel(MockedModelProvider([reply])).ask("s", {"q": YesNo("?")})


@pytest.mark.asyncio
async def test_ask_reports_usage_from_the_stream():
    usage = {"inputTokens": 30, "outputTokens": 4, "totalTokens": 34}
    tru_response = await LLMDecisionModel(_StructuredModel({"q_ok": True}, usage=usage)).ask("s", {"ok": YesNo("?")})

    assert tru_response.usage == {"inputTokens": 30, "outputTokens": 4, "totalTokens": 34}


def test_init_rejects_non_model():
    with pytest.raises(TypeError, match="needs a strands Model"):
        LLMDecisionModel(object())  # type: ignore[arg-type]


def test_update_config_routes_system_prompt_and_model_keys():
    llm = _StructuredModel({})
    engine = LLMDecisionModel(llm)

    with mock.patch.object(llm, "update_config") as model_update:
        engine.update_config(system_prompt="decide carefully")

    assert engine.get_config()["system_prompt"] == "decide carefully"
    model_update.assert_not_called()  # only the system prompt changed; the wrapped model is left alone

    with mock.patch.object(llm, "update_config") as model_update:
        engine.update_config(model_id="m2")

    model_update.assert_called_once_with(model_id="m2")
    assert engine.get_config()["system_prompt"] == "decide carefully"  # untouched by a model-only update
