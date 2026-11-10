"""Context injection for Strands Agents.

This package provides the configuration types for context injection — folding just-in-time text
into the model input before a call without touching durable history. The delivery primitives
(in ``_message_injection``) are internal; reach injection through the ``ContextInjector`` plugin
or the ``MemoryManager`` rather than using them directly.
"""

from .types import InjectionConfig, InjectionContext, InjectionTrigger

__all__ = [
    "InjectionConfig",
    "InjectionContext",
    "InjectionTrigger",
]
