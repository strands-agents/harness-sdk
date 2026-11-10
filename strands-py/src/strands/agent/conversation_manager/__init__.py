"""This package provides classes for managing conversation history during agent execution.

It includes:

- ConversationManager: Abstract base class defining the conversation management interface
- ProactiveCompressionConfig: Configuration type for proactive compression settings
- NullConversationManager: A no-op implementation that does not modify conversation history
- SlidingWindowConversationManager: An implementation that maintains a sliding window of messages to control context
  size while preserving conversation coherence
- SummarizingConversationManager: An implementation that summarizes older context instead
  of simply trimming it

Conversation managers help control memory usage and context length while maintaining relevant conversation state, which
is critical for effective agent interactions.
"""

from .conversation_manager import ConversationManager, ProactiveCompressionConfig
from .null_conversation_manager import NullConversationManager
from .sliding_window_conversation_manager import SlidingWindowConversationManager
from .summarizing_conversation_manager import SummarizingConversationManager

__all__ = [
    "ConversationManager",
    "NullConversationManager",
    "ProactiveCompressionConfig",
    "SlidingWindowConversationManager",
    "SummarizingConversationManager",
]
