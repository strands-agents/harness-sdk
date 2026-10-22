from pydantic import BaseModel
from typing_extensions import assert_type

from strands import Agent
from strands.agent import AgentResult


class Weather(BaseModel):
    temperature: int


def accepts_bare_result(result: AgentResult) -> None: ...


def sync_invocation(agent: Agent) -> None:
    result = agent("prompt", structured_output_model=Weather)
    assert_type(result, AgentResult[Weather])
    assert_type(result.structured_output, Weather | None)
    accepts_bare_result(result)

    assert_type(agent("prompt"), AgentResult)
    assert_type(agent("prompt").structured_output, BaseModel | None)

    bare: AgentResult = agent("prompt")
    bare = result
    accepts_bare_result(bare)


async def async_invocation(agent: Agent) -> None:
    result = await agent.invoke_async("prompt", structured_output_model=Weather)
    assert_type(result, AgentResult[Weather])
    assert_type(result.structured_output, Weather | None)

    assert_type(await agent.invoke_async("prompt"), AgentResult[BaseModel])
