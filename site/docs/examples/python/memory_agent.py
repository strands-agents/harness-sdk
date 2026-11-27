#!/usr/bin/env python3
"""Persist user notes in agent state with the SDK-vended notebook tool."""

from strands import Agent
from strands.vended_tools import notebook

memory_agent = Agent(
    system_prompt=(
        "Use the preferences notebook to store and retrieve user preferences. "
        "Always consult it before answering a preference question."
    ),
    tools=[notebook],
)

if __name__ == "__main__":
    memory_agent('Create a notebook named "preferences" and add "Prefers tea."')
    memory_agent("What drink does the user prefer?")
