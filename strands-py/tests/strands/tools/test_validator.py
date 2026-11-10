from strands.tools import _validator
from strands.types.content import Message


def test_validate_and_prepare_tools():
    message: Message = {
        "role": "assistant",
        "content": [
            {"text": "value"},
            {"toolUse": {"toolUseId": "t1", "name": "test_tool", "input": {"key": "value"}}},
            {"toolUse": {"toolUseId": "t2-invalid"}},
        ],
    }

    tool_uses = []
    tool_results = []
    invalid_tool_use_ids = []

    _validator.validate_and_prepare_tools(message, tool_uses, tool_results, invalid_tool_use_ids)

    tru_tool_uses, tru_tool_results, tru_invalid_tool_use_ids = tool_uses, tool_results, invalid_tool_use_ids
    exp_tool_uses = [
        {
            "input": {
                "key": "value",
            },
            "name": "test_tool",
            "toolUseId": "t1",
        },
        {
            # This now happens in stream_messages
            # "name": "INVALID_TOOL_NAME",
            "toolUseId": "t2-invalid",
        },
    ]
    exp_tool_results = [
        {
            "content": [
                {
                    "text": "Error: tool name missing",
                },
            ],
            "status": "error",
            "toolUseId": "t2-invalid",
        },
    ]
    exp_invalid_tool_use_ids = ["t2-invalid"]

    assert tru_tool_uses == exp_tool_uses
    assert tru_tool_results == exp_tool_results
    assert tru_invalid_tool_use_ids == exp_invalid_tool_use_ids
