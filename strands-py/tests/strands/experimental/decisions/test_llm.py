from typing import Annotated, Literal

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
    """Returns ``values`` (field name -> value) as the structured output instance."""

    def __init__(self, values):
        super().__init__([])
        self.values = values
        self.calls = []

    async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
        self.calls.append((output_model, prompt, system_prompt))
        yield {"output": output_model(**self.values)}


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
    assert engine.calibrated is False
    output_model, prompt, _ = llm.calls[0]
    assert set(output_model.model_fields) == {"q_department", "q_urgent", "q_frustration"}
    assert "site down" in prompt[0]["content"][0]["text"]


@pytest.mark.asyncio
async def test_ask_raises_when_llm_returns_no_output():
    class _Silent(_StructuredModel):
        async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
            yield {"not_output": 1}

    with pytest.raises(ValueError, match="no structured decision"):
        await LLMDecisionModel(_Silent({})).ask("s", {"q": YesNo("?")})


@pytest.mark.asyncio
async def test_ask_reports_usage_from_the_structured_output_stop_event():
    class _Metered(_StructuredModel):
        async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
            usage = {"inputTokens": 30, "outputTokens": 4, "totalTokens": 34}
            yield {"stop": ("tool_use", {"role": "assistant", "content": []}, usage, {})}
            yield {"output": output_model(**self.values)}

    tru_response = await LLMDecisionModel(_Metered({"q_ok": True})).ask("s", {"ok": YesNo("?")})

    assert tru_response.usage == {"inputTokens": 30, "outputTokens": 4, "totalTokens": 34}


def test_init_rejects_non_model():
    with pytest.raises(TypeError, match="needs a strands Model"):
        LLMDecisionModel(object())  # type: ignore[arg-type]


def test_update_config_routes_system_prompt_and_model_keys():
    llm = _StructuredModel({})
    engine = LLMDecisionModel(llm)

    engine.update_config(system_prompt="decide carefully")

    assert engine.get_config()["system_prompt"] == "decide carefully"
