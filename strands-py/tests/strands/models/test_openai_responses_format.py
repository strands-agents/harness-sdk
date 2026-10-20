import base64

import pytest

from strands.models._openai_responses_format import (
    _MAX_MEDIA_SIZE_BYTES,
    encode_media_to_data_url,
    format_function_call_output,
    format_function_tool,
)


def test_encode_media_to_data_url():
    tru_url = encode_media_to_data_url(b"png-bytes", "png")
    exp_url = f"data:image/png;base64,{base64.b64encode(b'png-bytes').decode()}"
    assert tru_url == exp_url


def test_encode_media_to_data_url_unknown_format():
    tru_url = encode_media_to_data_url(b"data", "unknownext")
    exp_url = f"data:application/octet-stream;base64,{base64.b64encode(b'data').decode()}"
    assert tru_url == exp_url


def test_encode_media_to_data_url_too_large():
    with pytest.raises(ValueError, match="Document size"):
        encode_media_to_data_url(b"x" * (_MAX_MEDIA_SIZE_BYTES + 1), "pdf", "document")


def test_format_function_tool():
    tool_spec = {
        "name": "lookup",
        "description": "Look up an order",
        "inputSchema": {"json": {"type": "object", "properties": {"id": {"type": "string"}}}},
    }
    tru_tool = format_function_tool(tool_spec)
    exp_tool = {
        "type": "function",
        "name": "lookup",
        "description": "Look up an order",
        "parameters": {"type": "object", "properties": {"id": {"type": "string"}}},
    }
    assert tru_tool == exp_tool


def test_format_function_tool_without_description():
    tool_spec = {"name": "noop", "inputSchema": {"json": {"type": "object"}}}
    tru_tool = format_function_tool(tool_spec)
    exp_tool = {"type": "function", "name": "noop", "description": "", "parameters": {"type": "object"}}
    assert tru_tool == exp_tool


def test_format_function_call_output_text_and_json():
    tool_result = {
        "toolUseId": "call_1",
        "status": "success",
        "content": [{"text": "café"}, {"json": {"ok": True, "name": "Zoë"}}],
    }
    tru_item = format_function_call_output(tool_result)
    exp_item = {"type": "function_call_output", "call_id": "call_1", "output": 'café\n{"ok": true, "name": "Zoë"}'}
    assert tru_item == exp_item


def test_format_function_call_output_empty():
    tru_item = format_function_call_output({"toolUseId": "call_1", "status": "success", "content": []})
    exp_item = {"type": "function_call_output", "call_id": "call_1", "output": ""}
    assert tru_item == exp_item


def test_format_function_call_output_media():
    tool_result = {
        "toolUseId": "call_1",
        "status": "success",
        "content": [
            {"text": "chart"},
            {"image": {"format": "png", "source": {"bytes": b"img"}}},
            {"document": {"format": "pdf", "name": "report", "source": {"bytes": b"doc"}}},
        ],
    }
    tru_item = format_function_call_output(tool_result)
    exp_item = {
        "type": "function_call_output",
        "call_id": "call_1",
        "output": [
            {"type": "input_text", "text": "chart"},
            {"type": "input_image", "image_url": f"data:image/png;base64,{base64.b64encode(b'img').decode()}"},
            {
                "type": "input_file",
                "filename": "report.pdf",
                "file_data": f"data:application/pdf;base64,{base64.b64encode(b'doc').decode()}",
            },
        ],
    }
    assert tru_item == exp_item
