"""Integration tests for SummarizingConversationManager with actual AI models.

These tests validate the end-to-end functionality of the SummarizingConversationManager
by testing with real AI models and API calls. They ensure that:

1. **Real summarization** - Tests that actual model-generated summaries work correctly
2. **Context overflow handling** - Validates real context overflow scenarios and recovery
3. **Tool preservation** - Ensures ToolUse/ToolResult pairs survive real summarization
4. **Message structure** - Verifies real model outputs maintain proper message structure
5. **Agent integration** - Tests that conversation managers work with real Agent workflows

These tests require API keys (`ANTHROPIC_API_KEY`) and make real API calls, so they should be run sparingly
and may be skipped in CI environments without proper credentials.
"""

import os

import pytest
from pydantic import BaseModel

import strands
from strands import Agent
from strands.agent.conversation_manager import SummarizingConversationManager
from strands.models.anthropic import AnthropicModel
from tests_integ.models import providers

pytestmark = providers.anthropic.mark


@pytest.fixture
def model():
    """Real Anthropic model for integration testing."""
    return AnthropicModel(
        client_args={
            "api_key": os.getenv("ANTHROPIC_API_KEY"),
        },
        model_id="claude-haiku-4-5-20251001",  # Using Haiku for faster/cheaper tests
        max_tokens=1024,
    )


@pytest.fixture
def summarization_model():
    """Separate model instance for summarization to test dedicated agent functionality."""
    return AnthropicModel(
        client_args={
            "api_key": os.getenv("ANTHROPIC_API_KEY"),
        },
        model_id="claude-haiku-4-5-20251001",
        max_tokens=512,
    )


@pytest.fixture
def tools():
    """Real tools for testing tool preservation during summarization."""

    @strands.tool
    def get_current_time() -> str:
        """Get the current time."""
        return "2024-01-15 14:30:00"

    @strands.tool
    def get_weather(city: str) -> str:
        """Get weather information for a city."""
        return f"The weather in {city} is sunny and 72°F"

    @strands.tool
    def calculate_sum(a: int, b: int) -> int:
        """Calculate the sum of two numbers."""
        return a + b

    return [get_current_time, get_weather, calculate_sum]


def test_summarization_with_context_overflow(model):
    """Test that summarization works when context overflow occurs."""
    # Mock conversation data to avoid API calls
    greeting_response = """
    Hello! I'm here to help you test your conversation manager. What specifically would you like 
    me to do as part of this test? I can respond to different types of prompts, maintain context 
    throughout our conversation, or demonstrate other capabilities of the AI assistant. Just let 
    me know what aspects you'd like to evaluate.
    """.strip()

    computer_history_response = """
    # History of Computers

    The history of computers spans many centuries, evolving from simple calculating tools to 
    the powerful machines we use today.

    ## Early Computing Devices
    - **Ancient abacus** (3000 BCE): One of the earliest computing devices used for arithmetic calculations
    - **Pascaline** (1642): Mechanical calculator invented by Blaise Pascal
    - **Difference Engine** (1822): Designed by Charles Babbage to compute polynomial functions
    - **Analytical Engine**: Babbage's more ambitious design, considered the first general-purpose computer concept
    - **Hollerith's Tabulating Machine** (1890s): Used punch cards to process data for the US Census

    ## Early Electronic Computers
    - **ENIAC** (1945): First general-purpose electronic computer, weighed 30 tons
    - **EDVAC** (1949): Introduced the stored program concept
    - **UNIVAC I** (1951): First commercial computer in the United States
    """.strip()

    first_computers_response = """
    # The First Computers

    Early computers were dramatically different from today's machines in almost every aspect:

    ## Physical Characteristics
    - **Enormous size**: Room-filling or even building-filling machines
    - **ENIAC** (1945) weighed about 30 tons, occupied 1,800 square feet
    - Consisted of large metal frames or cabinets filled with components
    - Required special cooling systems due to excessive heat generation

    ## Technology and Components
    - **Vacuum tubes**: Thousands of fragile glass tubes served as switches and amplifiers
    - ENIAC contained over 17,000 vacuum tubes
    - Generated tremendous heat and frequently failed
    - **Memory**: Limited storage using delay lines, cathode ray tubes, or magnetic drums
    """.strip()

    messages = [
        {"role": "user", "content": [{"text": "Hello, I'm testing a conversation manager."}]},
        {"role": "assistant", "content": [{"text": greeting_response}]},
        {"role": "user", "content": [{"text": "Can you tell me about the history of computers?"}]},
        {"role": "assistant", "content": [{"text": computer_history_response}]},
        {"role": "user", "content": [{"text": "What were the first computers like?"}]},
        {"role": "assistant", "content": [{"text": first_computers_response}]},
    ]

    # Create agent with very aggressive summarization settings and pre-built conversation
    agent = Agent(
        model=model,
        conversation_manager=SummarizingConversationManager(
            summary_ratio=0.5,  # Summarize 50% of messages
            preserve_recent_messages=2,  # Keep only 2 recent messages
        ),
        load_tools_from_directory=False,
        messages=messages,
    )

    # Should have the pre-built conversation history
    initial_message_count = len(agent.messages)
    assert initial_message_count == 6  # 3 user + 3 assistant messages

    # Store the last 2 messages before summarization to verify they're preserved
    messages_before_summary = agent.messages[-2:].copy()

    # Now manually trigger context reduction to test summarization
    agent.conversation_manager.reduce_context(agent)

    # Verify summarization occurred
    assert len(agent.messages) < initial_message_count
    # Should have: 1 summary + remaining messages
    # With 6 messages, summary_ratio=0.5, preserve_recent_messages=2:
    # messages_to_summarize = min(6 * 0.5, 6 - 2) = min(3, 4) = 3
    # So we summarize 3 messages, leaving 3 remaining + 1 summary = 4 total
    expected_total_messages = 4
    assert len(agent.messages) == expected_total_messages

    # First message should be the summary (assistant message)
    summary_message = agent.messages[0]
    assert summary_message["role"] == "user"
    assert len(summary_message["content"]) > 0

    # Verify the summary contains actual text content
    summary_content = None
    for content_block in summary_message["content"]:
        if "text" in content_block:
            summary_content = content_block["text"]
            break

    assert summary_content is not None
    assert len(summary_content) > 50  # Should be a substantial summary

    # Recent messages should be preserved - verify they're exactly the same
    recent_messages = agent.messages[-2:]  # Last 2 messages should be preserved
    assert len(recent_messages) == 2
    assert recent_messages == messages_before_summary, "The last 2 messages should be preserved exactly as they were"

    # Agent should still be functional after summarization
    post_summary_result = agent("That's very interesting, thank you!")
    assert post_summary_result.message["role"] == "assistant"


def test_tool_preservation_during_summarization(model, tools):
    """Test that ToolUse/ToolResult pairs are preserved during summarization."""
    agent = Agent(
        model=model,
        tools=tools,
        conversation_manager=SummarizingConversationManager(
            summary_ratio=0.6,  # Aggressive summarization
            preserve_recent_messages=3,
        ),
        load_tools_from_directory=False,
    )

    # Mock conversation with tool usage to avoid API calls and speed up tests
    greeting_text = """
    Hello! I'd be happy to help you with calculations. I have access to tools that can 
    help with math, time, and weather information. What would you like me to calculate for you?
    """.strip()

    weather_response = "The weather in San Francisco is sunny and 72°F. Perfect weather for being outside!"

    tool_conversation_data = [
        # Initial greeting exchange
        {"role": "user", "content": [{"text": "Hello, can you help me with some calculations?"}]},
        {"role": "assistant", "content": [{"text": greeting_text}]},
        # Time query with tool use/result pair
        {"role": "user", "content": [{"text": "What's the current time?"}]},
        {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": "time_001", "name": "get_current_time", "input": {}}}],
        },
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "time_001",
                        "content": [{"text": "2024-01-15 14:30:00"}],
                        "status": "success",
                    }
                }
            ],
        },
        {"role": "assistant", "content": [{"text": "The current time is 2024-01-15 14:30:00."}]},
        # Math calculation with tool use/result pair
        {"role": "user", "content": [{"text": "What's 25 + 37?"}]},
        {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": "calc_001", "name": "calculate_sum", "input": {"a": 25, "b": 37}}}],
        },
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "calc_001", "content": [{"text": "62"}], "status": "success"}}],
        },
        {"role": "assistant", "content": [{"text": "25 + 37 = 62"}]},
        # Weather query with tool use/result pair
        {"role": "user", "content": [{"text": "What's the weather like in San Francisco?"}]},
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "weather_001", "name": "get_weather", "input": {"city": "San Francisco"}}}
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "weather_001",
                        "content": [{"text": "The weather in San Francisco is sunny and 72°F"}],
                        "status": "success",
                    }
                }
            ],
        },
        {"role": "assistant", "content": [{"text": weather_response}]},
    ]

    # Add all the mocked conversation messages to avoid real API calls
    agent.messages.extend(tool_conversation_data)

    # Force summarization
    agent.conversation_manager.reduce_context(agent)

    # Verify tool pairs are still balanced after summarization
    post_summary_tool_use_count = 0
    post_summary_tool_result_count = 0

    for message in agent.messages:
        for content in message.get("content", []):
            if "toolUse" in content:
                post_summary_tool_use_count += 1
            if "toolResult" in content:
                post_summary_tool_result_count += 1

    # Tool uses and results should be balanced (no orphaned tools)
    assert post_summary_tool_use_count == post_summary_tool_result_count, (
        "Tool use and tool result counts should be balanced after summarization"
    )

    # Agent should still be able to use tools after summarization
    agent("Calculate 15 + 28 for me.")

    # Should have triggered the calculate_sum tool
    found_calculation = False
    for message in agent.messages[-2:]:  # Check recent messages
        for content in message.get("content", []):
            if "toolResult" in content and "43" in str(content):  # 15 + 28 = 43
                found_calculation = True
                break

    assert found_calculation, "Tool should still work after summarization"


def test_dedicated_summarization_agent(model, summarization_model):
    """Test that a dedicated summarization agent works correctly."""
    # Create a dedicated summarization agent
    summarization_agent = Agent(
        model=summarization_model,
        system_prompt="You are a conversation summarizer. Create concise, structured summaries.",
        load_tools_from_directory=False,
    )

    # Create main agent with dedicated summarization agent
    agent = Agent(
        model=model,
        conversation_manager=SummarizingConversationManager(
            summary_ratio=0.5,
            preserve_recent_messages=2,
            summarization_agent=summarization_agent,
        ),
        load_tools_from_directory=False,
    )

    # Mock conversation data for space exploration topic
    space_intro_response = """
    Space exploration has been one of humanity's greatest achievements, beginning with early 
    satellite launches in the 1950s and progressing to human spaceflight, moon landings, and now 
    commercial space ventures.
    """.strip()

    space_milestones_response = """
    Key milestones include Sputnik 1 (1957), Yuri Gagarin's first human spaceflight (1961), 
    the Apollo 11 moon landing (1969), the Space Shuttle program, and the International Space 
    Station construction.
    """.strip()

    apollo_missions_response = """
    The Apollo program was NASA's lunar exploration program from 1961-1975. Apollo 11 achieved 
    the first moon landing in 1969 with Neil Armstrong and Buzz Aldrin, followed by five more 
    successful lunar missions through Apollo 17.
    """.strip()

    spacex_response = """
    SpaceX has revolutionized space travel with reusable rockets, reducing launch costs dramatically. 
    They've achieved crew transportation to the ISS, satellite deployments, and are developing 
    Starship for Mars missions.
    """.strip()

    conversation_pairs = [
        ("I'm interested in learning about space exploration.", space_intro_response),
        ("What were the key milestones in space exploration?", space_milestones_response),
        ("Tell me about the Apollo missions.", apollo_missions_response),
        ("What about modern space exploration with SpaceX?", spacex_response),
    ]

    # Manually build the conversation history to avoid real API calls
    for user_input, assistant_response in conversation_pairs:
        agent.messages.append({"role": "user", "content": [{"text": user_input}]})
        agent.messages.append({"role": "assistant", "content": [{"text": assistant_response}]})

    # Force summarization
    original_length = len(agent.messages)
    agent.conversation_manager.reduce_context(agent)

    # Verify summarization occurred
    assert len(agent.messages) < original_length

    # Get the summary message
    summary_message = agent.messages[0]
    assert summary_message["role"] == "user"

    # Extract summary text
    summary_text = None
    for content in summary_message["content"]:
        if "text" in content:
            summary_text = content["text"]
            break

    assert summary_text


def test_summarization_with_tool_messages_and_no_tools():
    agent = Agent(
        messages=[
            {"role": "user", "content": [{"text": "What is the current time?"}]},
            {
                "role": "assistant",
                "content": [{"toolUse": {"toolUseId": "t1", "name": "time_tool", "input": {}}}],
            },
            {
                "role": "user",
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": "t1",
                            "content": [{"text": "12:00"}],
                            "status": "success",
                        }
                    }
                ],
            },
            {"role": "assistant", "content": [{"text": "The current time is 12:00."}]},
            {"role": "user", "content": [{"text": "Thank you"}]},
            {"role": "assistant", "content": [{"text": "You are welcome."}]},
        ],
    )

    conversation_manager = SummarizingConversationManager(summary_ratio=1, preserve_recent_messages=2)
    conversation_manager.reduce_context(agent)

    assert len(agent.tool_names) == 0
    assert len(agent.messages) == 3

    summary = str(agent.messages[0]).lower()
    assert "12:00" in summary


def test_dedicated_summarization_agent_with_structured_output(model, summarization_model):
    """Test that summarization works when the summarization agent has structured_output_model configured.

    When structured_output_model is set on the summarization agent, the response would contain toolUse
    blocks. Since the summary is converted to a user message, those blocks would cause a
    ValidationException. This test verifies that structured output is properly disabled during
    summarization.
    """

    class SummaryOutput(BaseModel):
        topics: list[str]
        key_points: list[str]

    # Create a summarization agent with structured_output_model configured
    summarization_agent = Agent(
        model=summarization_model,
        system_prompt="You are a conversation summarizer. Create concise, structured summaries.",
        structured_output_model=SummaryOutput,
        load_tools_from_directory=False,
    )

    agent = Agent(
        model=model,
        conversation_manager=SummarizingConversationManager(
            summary_ratio=0.5,
            preserve_recent_messages=2,
            summarization_agent=summarization_agent,
        ),
        load_tools_from_directory=False,
    )

    # Build conversation history
    agent.messages.extend(
        [
            {"role": "user", "content": [{"text": "Tell me about Python programming."}]},
            {"role": "assistant", "content": [{"text": "Python is a high-level programming language."}]},
            {"role": "user", "content": [{"text": "What about its type system?"}]},
            {"role": "assistant", "content": [{"text": "Python uses dynamic typing with optional type hints."}]},
            {"role": "user", "content": [{"text": "How does async work in Python?"}]},
            {"role": "assistant", "content": [{"text": "Python uses asyncio with async/await syntax."}]},
            {"role": "user", "content": [{"text": "What about decorators?"}]},
            {"role": "assistant", "content": [{"text": "Decorators are functions that modify other functions."}]},
        ]
    )

    original_length = len(agent.messages)
    agent.conversation_manager.reduce_context(agent)

    assert len(agent.messages) < original_length

    summary_message = agent.messages[0]
    assert summary_message["role"] == "user"

    # Summary should contain only valid user message content (no toolUse blocks)
    for content_block in summary_message["content"]:
        assert "toolUse" not in content_block, "Summary user message should not contain toolUse blocks"

    # Should have text content
    assert any("text" in cb for cb in summary_message["content"])

    # Invoke the agent with the summarized messages to verify the provider accepts them
    result = agent("Thanks for the overview!")
    assert result.message["role"] == "assistant"
