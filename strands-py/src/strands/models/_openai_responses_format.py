"""Responses API formatting shared by OpenAI providers.

This module must not import ``openai`` so providers outside the ``openai`` extra can use it.
"""

import base64
import json
import mimetypes
from typing import Any

from ..types.tools import ToolResult, ToolSpec

# Maximum file size for media content in tool results (20MB)
_MAX_MEDIA_SIZE_BYTES = 20 * 1024 * 1024
_MAX_MEDIA_SIZE_LABEL = "20MB"
_DEFAULT_MIME_TYPE = "application/octet-stream"


def encode_media_to_data_url(data: bytes, format_ext: str, media_type: str = "image") -> str:
    """Encode media bytes to a base64 data URL with size validation.

    Args:
        data: Raw bytes of the media content.
        format_ext: File format extension (e.g., "png", "pdf").
        media_type: Type of media for error messages ("image" or "document").

    Returns:
        Base64-encoded data URL string.

    Raises:
        ValueError: If the media size exceeds the maximum allowed size.
    """
    if len(data) > _MAX_MEDIA_SIZE_BYTES:
        raise ValueError(
            f"{media_type.capitalize()} size {len(data)} bytes exceeds maximum of"
            f" {_MAX_MEDIA_SIZE_BYTES} bytes ({_MAX_MEDIA_SIZE_LABEL})"
        )
    mime_type = mimetypes.types_map.get(f".{format_ext}", _DEFAULT_MIME_TYPE)
    encoded_data = base64.b64encode(data).decode("utf-8")
    return f"data:{mime_type};base64,{encoded_data}"


def format_function_tool(tool_spec: ToolSpec) -> dict[str, Any]:
    """Format a Strands tool specification as a Responses function tool.

    Args:
        tool_spec: Tool specification to convert.

    Returns:
        Responses function tool definition.
    """
    return {
        "type": "function",
        "name": tool_spec["name"],
        "description": tool_spec.get("description", ""),
        "parameters": tool_spec["inputSchema"]["json"],
    }


def format_function_call_output(tool_result: ToolResult) -> dict[str, Any]:
    """Format a tool result as a Responses ``function_call_output`` item.

    The output is a string for text-only results, or an array of content parts when the result
    contains images or documents.

    Args:
        tool_result: Tool result collected from a tool execution.

    Returns:
        Responses ``function_call_output`` item.

    Raises:
        ValueError: If the image or document size exceeds the maximum allowed size (20MB).
    """
    output_parts: list[dict[str, Any]] = []
    has_media = False

    for content in tool_result["content"]:
        if "json" in content:
            output_parts.append({"type": "input_text", "text": json.dumps(content["json"], ensure_ascii=False)})
        elif "text" in content:
            output_parts.append({"type": "input_text", "text": content["text"]})
        elif "image" in content:
            has_media = True
            img = content["image"]
            data_url = encode_media_to_data_url(img["source"]["bytes"], img["format"], "image")
            output_parts.append({"type": "input_image", "image_url": data_url})
        elif "document" in content:
            has_media = True
            doc = content["document"]
            data_url = encode_media_to_data_url(doc["source"]["bytes"], doc["format"], "document")
            name = doc.get("name", "document")
            suffix = f".{doc['format']}"
            filename = name if name.endswith(suffix) else f"{name}{suffix}"
            output_parts.append({"type": "input_file", "filename": filename, "file_data": data_url})

    output: list[dict[str, Any]] | str
    if has_media:
        output = output_parts
    else:
        output = "\n".join(part.get("text", "") for part in output_parts) if output_parts else ""

    return {
        "type": "function_call_output",
        "call_id": tool_result["toolUseId"],
        "output": output,
    }
