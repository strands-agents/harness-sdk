"""The tool-spec cache must not pin dynamically created output models.

``StructuredOutputTool`` caches the converted ``ToolSpec`` per output-model
class in a module-level cache. Applications (and the SDK's own decision
models) build output models with ``pydantic.create_model`` per call; the
cache must release those classes with their last strong reference instead of
keeping every class — and its spec — alive for the life of the process.
"""

import gc
import weakref

from pydantic import create_model

from strands.tools.structured_output.structured_output_tool import (
    _TOOL_SPEC_CACHE,
    StructuredOutputTool,
)


def test_tool_spec_cache_is_used_for_repeated_classes():
    output_model = create_model("CachedOutputModel", answer=(str, ...))
    tool = StructuredOutputTool(output_model)
    assert output_model in _TOOL_SPEC_CACHE

    # A second tool for the same class reuses the cached spec.
    again = StructuredOutputTool(output_model)
    assert again.tool_name == tool.tool_name


def test_tool_spec_cache_releases_dynamic_output_models():
    output_model = create_model("DynamicOutputModel", answer=(str, ...))
    StructuredOutputTool(output_model)
    assert output_model in _TOOL_SPEC_CACHE

    ref = weakref.ref(output_model)
    del output_model
    gc.collect()

    assert ref() is None, (
        "StructuredOutputTool's module-level spec cache is keeping dynamically "
        "created pydantic model classes alive after their last use"
    )
