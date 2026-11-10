# Copyright (c) Meta Platforms, Inc. and affiliates
import os

import pytest

import strands
from strands import Agent
from strands.models.llamaapi import LlamaAPIModel
from tests_integ.models import providers

# these tests only run if we have the llama api key
pytestmark = providers.llama.mark


@pytest.fixture
def model():
    return LlamaAPIModel(
        model_id="Llama-4-Maverick-17B-128E-Instruct-FP8",
        client_args={
            "api_key": os.getenv("LLAMA_API_KEY"),
        },
    )


@pytest.fixture
def tools():
    @strands.tool
    def tool_time() -> str:
        return "12:00"

    @strands.tool
    def tool_weather() -> str:
        return "sunny"

    return [tool_time, tool_weather]


@pytest.fixture
def agent(model, tools):
    return Agent(model=model, tools=tools)


def test_agent(agent):
    result = agent("What is the time and weather in New York?")
    text = result.message["content"][0]["text"].lower()

    assert all(string in text for string in ["12:00", "sunny"])
