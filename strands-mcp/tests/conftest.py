import pytest


@pytest.fixture(scope="module")
def api_reference_doc():
    """Large API reference doc with multiple ## classes and ### methods.

    IMPORTANT: Must exceed SMALL_DOC_THRESHOLD (8192 bytes) so fetch_doc
    takes the TOC path instead of the small-doc shortcut.
    """
    # Base structure with real section content
    base = (
        "# strands.hooks.events\n\n"
        "Experimental hook events.\n\n"
        "## AfterModelCallEvent\n\n"
        "Event triggered after the model invocation completes.\n\n"
        "Supports retry logic via retry_model flag. When retry_model is set to True "
        "by a hook callback, the agent will discard the current model response and "
        "invoke the model again.\n\n"
        "```python\n"
        "@dataclass\n"
        "class AfterModelCallEvent(HookEvent):\n"
        "    invocation_state: dict[str, Any] = field(default_factory=dict)\n"
        "    stop_response: ModelStopResponse | None = None\n"
        "    exception: Exception | None = None\n"
        "    retry: bool = False\n"
        "```\n\n"
        "### should_reverse_callbacks\n\n"
        "True to invoke callbacks in reverse order.\n\n"
        "### ModelStopResponse\n\n"
        "Model response data from successful invocation.\n\n"
        "```python\n"
        "@dataclass\n"
        "class ModelStopResponse:\n"
        "    message: Message\n"
        "    stop_reason: StopReason\n"
        "```\n\n"
        "## AfterToolCallEvent\n\n"
        "Event triggered after a tool invocation completes. This event is fired "
        "after the agent has finished executing a tool, regardless of whether the "
        "execution was successful or resulted in an error.\n\n"
        "### should_reverse_callbacks\n\n"
        "True to invoke callbacks in reverse order.\n\n"
        "## AgentTool\n\n"
        "Base class for tools that can be used by agents. Provides the interface "
        "for tool registration, execution, and streaming.\n\n"
        "### __init__()\n\n"
        "Initialize the tool with name, spec, and handler function.\n\n"
        "### stream()\n\n"
        "Stream tool results back to the caller.\n\n"
    )
    # Pad to ensure we exceed 8192 bytes while keeping valid markdown
    padding = "<!-- padding -->\n" * 500
    return base + padding


@pytest.fixture(scope="module")
def small_doc():
    """Small document under the 8KB threshold."""
    return "# UTCP\n\nCommunity contribution.\n\n## Installation\n\npip install strands-utcp\n"


@pytest.fixture(scope="module")
def headers_in_code_blocks_doc():
    """Document with markdown headers inside fenced code blocks."""
    return (
        "# Guide\n\n"
        "## Configuration\n\n"
        "Here is an example:\n\n"
        "```python\n"
        "# This is a comment\n"
        "## This should NOT be a header\n"
        "```\n\n"
        "## Next Section\n\n"
        "Real content here.\n\n"
    )


@pytest.fixture(scope="module")
def no_h2_doc():
    """Document with only # and ### headers, no ## sections.

    Used by both parse_sections() unit tests and fetch_doc server tests.
    Padded above SMALL_DOC_THRESHOLD so fetch_doc takes the TOC/fallback path.
    """
    return "# Title\n\n" + "Some content.\n\n" * 600 + "### Subsection\n\nMore content.\n"


@pytest.fixture(scope="module")
def skipped_levels_doc():
    """Document with inconsistent header levels (## jumps to ####)."""
    return (
        "# Title\n\n"
        "## Section One\n\n"
        "Content.\n\n"
        "#### Deep Child\n\n"
        "Skipped ### level.\n\n"
        "## Section Two\n\n"
        "More content.\n\n"
    )


@pytest.fixture(scope="module")
def empty_section_doc():
    """Document with a ## header that has no content before the next ##."""
    return "# Title\n\n## Empty\n\n## Has Content\n\nSome text here.\n"


@pytest.fixture(scope="module")
def duplicate_children_doc():
    """Document with duplicate child header names across different parents."""
    base = (
        "# API Reference\n\n"
        "## ClassA\n\n"
        "First class.\n\n"
        "### __init__()\n\n"
        "Init for ClassA.\n\n"
        "### process()\n\n"
        "Process for ClassA.\n\n"
        "## ClassB\n\n"
        "Second class.\n\n"
        "### __init__()\n\n"
        "Init for ClassB.\n\n"
        "### process()\n\n"
        "Process for ClassB.\n\n"
    )
    # Pad above threshold for server tests
    padding = "<!-- padding -->\n" * 500
    return base + padding
