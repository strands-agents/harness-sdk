import pytest

import strands


@pytest.fixture
def agent():
    return strands.Agent()


@pytest.mark.asyncio
async def test_stream_async(agent):
    stream = agent.stream_async("hello")

    exp_message = ""
    async for event in stream:
        if "event" in event and "contentBlockDelta" in event["event"]:
            exp_message += event["event"]["contentBlockDelta"]["delta"]["text"]

    tru_message = agent.messages[-1]["content"][0]["text"]

    assert tru_message == exp_message
