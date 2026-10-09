"""Default configuration for the harness."""

from strands_harness.types.agent import BuiltinPluginName, BuiltinToolName

DEFAULT_MODEL = "bedrock/global.anthropic.claude-opus-5"

DEFAULT_EFFORT = "auto"

DEFAULT_CONTEXT_MANAGER = "auto"

DEFAULT_CACHING = "auto"

BUILTIN_TOOL_NAMES: tuple[BuiltinToolName, ...] = (
    "shell",
    "read",
    "write",
    "edit",
    "web_fetch",
    "web_search",
    "programmatic_tool_caller",
    "subagent",
)
"""Every built-in tool name, in the order the harness registers them."""

DEFAULT_BUILTIN_TOOLS: tuple[BuiltinToolName, ...] = BUILTIN_TOOL_NAMES
"""Built-in tools enabled when ``builtin_tools`` is omitted (``web_search`` only where the model has native search)."""

BUILTIN_PLUGIN_NAMES: tuple[BuiltinPluginName, ...] = ("todos", "environment")
"""Every built-in plugin name."""

DEFAULT_BUILTIN_PLUGINS: tuple[BuiltinPluginName, ...] = BUILTIN_PLUGIN_NAMES

DEFAULT_SUBAGENT_MAX_DEPTH = 2

DEFAULT_SESSION_DIR = "./.agent/sessions"

DEFAULT_SKILLS_DIR = "./.agent/skills"

DEFAULT_MEMORY_DIR = "./.agent/memory"
