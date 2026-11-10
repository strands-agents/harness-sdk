import pytest

from strands.types.tools import ToolResultBlock


@pytest.mark.parametrize("status", ["success", "error"])
def test_tool_result_block_to_dict(status):
    content = [{"text": "Tool output"}, {"json": {"value": 42}}]
    block = ToolResultBlock(tool_use_id="call-1", status=status, content=content)

    tru_content = block.to_dict()
    exp_content = {"toolResult": {"toolUseId": "call-1", "status": status, "content": content}}
    assert tru_content == exp_content
    assert tru_content["toolResult"]["content"] is content
