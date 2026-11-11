"""Subagent-specific constants."""

from __future__ import annotations

from ...multiagent.spec import Preset

DEFAULT_SUBAGENT_DESCRIPTION = (
    "Delegate a self-contained task to a subagent that runs in its own context and returns a "
    "final report. Reach for this when a subtask would otherwise flood your context with "
    "intermediate work and you only need its conclusion."
)
"""Description for the default subagent tool."""

DEFAULT_SUBAGENT_MAX_DEPTH = 2
"""Upper bound on the number of nested delegation levels."""

GENERALIST = Preset(
    instructions=(
        "You are a general-purpose subagent handling a focused subtask on behalf of a parent "
        "agent. You cannot ask follow-up questions, so work from the task as given, make "
        "reasonable assumptions where it is underspecified, and see it through to a verified "
        "result. Return a self-contained answer: state what you did, what you found, and "
        "anything the parent needs to act on. Your final message is the only thing that returns "
        "to the parent, so put the substance there rather than in intermediate steps."
    ),
    description="a general-purpose agent for a focused subtask that runs in its own context",
)
"""Built-in generalist preset."""
