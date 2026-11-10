#!/usr/bin/env python3
"""
Test script for function-based tools
"""

import logging

from strands import Agent, tool

logging.getLogger("strands").setLevel(logging.DEBUG)
logging.basicConfig(format="%(levelname)s | %(name)s | %(message)s", handlers=[logging.StreamHandler()])


@tool
def word_counter(text: str) -> str:
    """
    Count words in text.

    Args:
        text: Text to analyze
    """
    count = len(text.split())
    return f"Word count: {count}"


@tool(name="count_chars", description="Count characters in text")
def count_chars(text: str, include_spaces: bool | None = True) -> str:
    """
    Count characters in text.

    Args:
        text: Text to analyze
        include_spaces: Whether to include spaces in the count
    """
    if not include_spaces:
        text = text.replace(" ", "")
    return f"Character count: {len(text)}"


# Initialize agent with function tools
agent = Agent(tools=[word_counter, count_chars])

print("\n===== Testing Direct Tool Access =====")
# Use the tools directly
word_result = agent.tool.word_counter(text="Hello world, this is a test")
print(f"\nWord counter result: {word_result}")

char_result = agent.tool.count_chars(text="Hello world!", include_spaces=False)
print(f"\nCharacter counter result: {char_result}")

print("\n===== Testing Natural Language Access =====")
# Use through natural language
nl_result = agent("Count the words in this sentence: 'The quick brown fox jumps over the lazy dog'")
print(f"\nNL Result: {nl_result}")
