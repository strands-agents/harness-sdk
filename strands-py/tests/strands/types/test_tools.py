import pytest

from strands.types.tools import ToolContext, ToolResultBlock, ToolSpec


@pytest.mark.parametrize("status", ["success", "error"])
def test_tool_result_block_to_dict(status):
    content = [{"text": "Tool output"}, {"json": {"value": 42}}]
    block = ToolResultBlock(tool_use_id="call-1", status=status, content=content)

    tru_content = block.to_dict()
    exp_content = {"toolResult": {"toolUseId": "call-1", "status": status, "content": content}}
    assert tru_content == exp_content
    assert tru_content["toolResult"]["content"] is content


def test_foreground_tool_context_progress_and_message_are_inert() -> None:
    context = ToolContext(
        tool_use={"name": "work", "toolUseId": "call-1", "input": {}}, agent=None, invocation_state={}
    )
    context.report_progress("working")
    unregister = context.on_message(lambda message, **kwargs: None)
    unregister()


def test_tool_spec_preserves_runtime_optional_keys() -> None:
    tru_keys = ToolSpec.__optional_keys__
    exp_keys = frozenset({"outputSchema", "annotations"})
    assert tru_keys == exp_keys
