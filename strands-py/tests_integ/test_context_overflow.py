from strands import Agent
from strands.types.content import Messages


def test_context_window_overflow():
    messages: Messages = [
        {"role": "user", "content": [{"text": "Too much text!" * 300000}]},
        {"role": "assistant", "content": [{"text": "That was a lot of text!"}]},
    ]

    agent = Agent(messages=messages, load_tools_from_directory=False)
    agent("Hi!")
    assert len(agent.messages) == 2
