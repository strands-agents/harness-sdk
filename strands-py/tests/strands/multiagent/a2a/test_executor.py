"""Tests for the StrandsA2AExecutor class."""

import base64
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from a2a.types import DataPart, FilePart, InternalError, InvalidParamsError, TextPart, UnsupportedOperationError
from a2a.utils.errors import ServerError

from strands.agent.agent_result import AgentResult as SAAgentResult
from strands.multiagent.a2a.executor import StrandsA2AExecutor, _StreamState
from strands.types.content import ContentBlock

# Suppress A2A compliance warnings for legacy streaming mode tests, and the single-agent
# deprecation warning for tests that intentionally exercise the deprecated template path.
pytestmark = [
    pytest.mark.filterwarnings("ignore:The default A2A response stream.*:UserWarning"),
    pytest.mark.filterwarnings("ignore:Passing a single 'agent'.*:DeprecationWarning"),
]

# Test data constants
VALID_PNG_BYTES = b"fake_png_data"
VALID_MP4_BYTES = b"fake_mp4_data"
VALID_DOCUMENT_BYTES = b"fake_document_data"


def test_executor_initialization(mock_strands_agent):
    """Test that StrandsA2AExecutor initializes correctly."""
    executor = StrandsA2AExecutor(mock_strands_agent)

    assert executor.agent == mock_strands_agent


def test_classify_file_type():
    """Test file type classification based on MIME type."""
    executor = StrandsA2AExecutor(MagicMock())

    # Test image types
    assert executor._get_file_type_from_mime_type("image/jpeg") == "image"
    assert executor._get_file_type_from_mime_type("image/png") == "image"

    # Test video types
    assert executor._get_file_type_from_mime_type("video/mp4") == "video"
    assert executor._get_file_type_from_mime_type("video/mpeg") == "video"

    # Test document types
    assert executor._get_file_type_from_mime_type("text/plain") == "document"
    assert executor._get_file_type_from_mime_type("application/pdf") == "document"
    assert executor._get_file_type_from_mime_type("application/json") == "document"

    # Test unknown/edge cases
    assert executor._get_file_type_from_mime_type("audio/mp3") == "unknown"
    assert executor._get_file_type_from_mime_type(None) == "unknown"
    assert executor._get_file_type_from_mime_type("") == "unknown"


def test_get_file_format_from_mime_type():
    """Test file format extraction from MIME type using mimetypes library."""
    executor = StrandsA2AExecutor(MagicMock())
    assert executor._get_file_format_from_mime_type("image/jpeg", "image") == "jpeg"
    assert executor._get_file_format_from_mime_type("image/png", "image") == "png"
    assert executor._get_file_format_from_mime_type("image/unknown", "image") == "png"

    # Test video formats
    assert executor._get_file_format_from_mime_type("video/mp4", "video") == "mp4"
    assert executor._get_file_format_from_mime_type("video/3gpp", "video") == "three_gp"
    assert executor._get_file_format_from_mime_type("video/unknown", "video") == "mp4"

    # Test document formats
    assert executor._get_file_format_from_mime_type("application/pdf", "document") == "pdf"
    assert executor._get_file_format_from_mime_type("text/plain", "document") == "txt"
    assert executor._get_file_format_from_mime_type("application/unknown", "document") == "txt"

    # Test None/empty cases
    assert executor._get_file_format_from_mime_type(None, "image") == "png"
    assert executor._get_file_format_from_mime_type("", "video") == "mp4"


def test_strip_file_extension():
    """Test file extension stripping."""
    executor = StrandsA2AExecutor(MagicMock())

    assert executor._strip_file_extension("test.txt") == "test"
    assert executor._strip_file_extension("document.pdf") == "document"
    assert executor._strip_file_extension("image.jpeg") == "image"
    assert executor._strip_file_extension("no_extension") == "no_extension"
    assert executor._strip_file_extension("multiple.dots.file.ext") == "multiple.dots.file"


def test_convert_a2a_parts_to_content_blocks_text_part():
    """Test conversion of TextPart to ContentBlock."""
    from a2a.types import TextPart

    executor = StrandsA2AExecutor(MagicMock())

    # Mock TextPart with proper spec
    text_part = MagicMock(spec=TextPart)
    text_part.text = "Hello, world!"

    # Mock Part with TextPart root
    part = MagicMock()
    part.root = text_part

    result = executor._convert_a2a_parts_to_content_blocks([part])

    assert len(result) == 1
    assert result[0] == ContentBlock(text="Hello, world!")


def test_convert_a2a_parts_to_content_blocks_file_part_image_bytes():
    """Test conversion of FilePart with image bytes to ContentBlock."""
    executor = StrandsA2AExecutor(MagicMock())

    base64_bytes = base64.b64encode(VALID_PNG_BYTES).decode("utf-8")

    # Mock file object
    file_obj = MagicMock()
    file_obj.name = "test_image.png"
    file_obj.mime_type = "image/png"
    file_obj.bytes = base64_bytes
    file_obj.uri = None

    # Mock FilePart with proper spec
    file_part = MagicMock(spec=FilePart)
    file_part.file = file_obj

    # Mock Part with FilePart root
    part = MagicMock()
    part.root = file_part

    result = executor._convert_a2a_parts_to_content_blocks([part])

    assert len(result) == 1
    content_block = result[0]
    assert "image" in content_block
    assert content_block["image"]["format"] == "png"
    assert content_block["image"]["source"]["bytes"] == VALID_PNG_BYTES


def test_convert_a2a_parts_to_content_blocks_file_part_video_bytes():
    """Test conversion of FilePart with video bytes to ContentBlock."""
    executor = StrandsA2AExecutor(MagicMock())

    base64_bytes = base64.b64encode(VALID_MP4_BYTES).decode("utf-8")

    # Mock file object
    file_obj = MagicMock()
    file_obj.name = "test_video.mp4"
    file_obj.mime_type = "video/mp4"
    file_obj.bytes = base64_bytes
    file_obj.uri = None

    # Mock FilePart with proper spec
    file_part = MagicMock(spec=FilePart)
    file_part.file = file_obj

    # Mock Part with FilePart root
    part = MagicMock()
    part.root = file_part

    result = executor._convert_a2a_parts_to_content_blocks([part])

    assert len(result) == 1
    content_block = result[0]
    assert "video" in content_block
    assert content_block["video"]["format"] == "mp4"
    assert content_block["video"]["source"]["bytes"] == VALID_MP4_BYTES


def test_convert_a2a_parts_to_content_blocks_file_part_document_bytes():
    """Test conversion of FilePart with document bytes to ContentBlock."""
    executor = StrandsA2AExecutor(MagicMock())

    base64_bytes = base64.b64encode(VALID_DOCUMENT_BYTES).decode("utf-8")

    # Mock file object
    file_obj = MagicMock()
    file_obj.name = "test_document.pdf"
    file_obj.mime_type = "application/pdf"
    file_obj.bytes = base64_bytes
    file_obj.uri = None

    # Mock FilePart with proper spec
    file_part = MagicMock(spec=FilePart)
    file_part.file = file_obj

    # Mock Part with FilePart root
    part = MagicMock()
    part.root = file_part

    result = executor._convert_a2a_parts_to_content_blocks([part])

    assert len(result) == 1
    content_block = result[0]
    assert "document" in content_block
    assert content_block["document"]["format"] == "pdf"
    assert content_block["document"]["name"] == "test_document"
    assert content_block["document"]["source"]["bytes"] == VALID_DOCUMENT_BYTES


def test_convert_a2a_parts_to_content_blocks_file_part_uri():
    """Test conversion of FilePart with URI to ContentBlock."""
    from a2a.types import FilePart

    executor = StrandsA2AExecutor(MagicMock())

    # Mock file object with URI
    file_obj = MagicMock()
    file_obj.name = "test_image.png"
    file_obj.mime_type = "image/png"
    file_obj.bytes = None
    file_obj.uri = "https://example.com/image.png"

    # Mock FilePart with proper spec
    file_part = MagicMock(spec=FilePart)
    file_part.file = file_obj

    # Mock Part with FilePart root
    part = MagicMock()
    part.root = file_part

    result = executor._convert_a2a_parts_to_content_blocks([part])

    assert len(result) == 1
    content_block = result[0]
    assert "text" in content_block
    assert "test_image" in content_block["text"]
    assert "https://example.com/image.png" in content_block["text"]


def test_convert_a2a_parts_to_content_blocks_file_part_with_bytes():
    """Test conversion of FilePart with bytes data."""
    executor = StrandsA2AExecutor(MagicMock())

    base64_bytes = base64.b64encode(VALID_PNG_BYTES).decode("utf-8")

    # Mock file object with bytes (no validation needed since no decoding)
    file_obj = MagicMock()
    file_obj.name = "test_image.png"
    file_obj.mime_type = "image/png"
    file_obj.bytes = base64_bytes
    file_obj.uri = None

    # Mock FilePart with proper spec
    file_part = MagicMock(spec=FilePart)
    file_part.file = file_obj

    # Mock Part with FilePart root
    part = MagicMock()
    part.root = file_part

    result = executor._convert_a2a_parts_to_content_blocks([part])

    assert len(result) == 1
    content_block = result[0]
    assert "image" in content_block
    assert content_block["image"]["source"]["bytes"] == VALID_PNG_BYTES


def test_convert_a2a_parts_to_content_blocks_file_part_invalid_base64():
    """Test conversion of FilePart with invalid base64 data raises ValueError."""
    executor = StrandsA2AExecutor(MagicMock())

    # Invalid base64 string - contains invalid characters
    invalid_base64 = "SGVsbG8gV29ybGQ@#$%"

    # Mock file object with invalid base64 bytes
    file_obj = MagicMock()
    file_obj.name = "test.txt"
    file_obj.mime_type = "text/plain"
    file_obj.bytes = invalid_base64
    file_obj.uri = None

    # Mock FilePart
    file_part = MagicMock(spec=FilePart)
    file_part.file = file_obj
    part = MagicMock()
    part.root = file_part

    # Should handle the base64 decode error gracefully and return empty list
    result = executor._convert_a2a_parts_to_content_blocks([part])
    assert isinstance(result, list)
    # The part should be skipped due to base64 decode error
    assert len(result) == 0


def test_convert_a2a_parts_to_content_blocks_data_part():
    """Test conversion of DataPart to ContentBlock."""
    from a2a.types import DataPart

    executor = StrandsA2AExecutor(MagicMock())

    # Mock DataPart with proper spec
    test_data = {"key": "value", "number": 42}
    data_part = MagicMock(spec=DataPart)
    data_part.data = test_data

    # Mock Part with DataPart root
    part = MagicMock()
    part.root = data_part

    result = executor._convert_a2a_parts_to_content_blocks([part])

    assert len(result) == 1
    content_block = result[0]
    assert "text" in content_block
    assert "[Structured Data]" in content_block["text"]
    assert "key" in content_block["text"]
    assert "value" in content_block["text"]


def test_convert_a2a_parts_to_content_blocks_mixed_parts():
    """Test conversion of mixed A2A parts to ContentBlocks."""
    from a2a.types import DataPart, TextPart

    executor = StrandsA2AExecutor(MagicMock())

    # Mock TextPart with proper spec
    text_part = MagicMock(spec=TextPart)
    text_part.text = "Text content"
    text_part_mock = MagicMock()
    text_part_mock.root = text_part

    # Mock DataPart with proper spec
    data_part = MagicMock(spec=DataPart)
    data_part.data = {"test": "data"}
    data_part_mock = MagicMock()
    data_part_mock.root = data_part

    parts = [text_part_mock, data_part_mock]
    result = executor._convert_a2a_parts_to_content_blocks(parts)

    assert len(result) == 2
    assert result[0]["text"] == "Text content"
    assert "[Structured Data]" in result[1]["text"]


@pytest.mark.asyncio
async def test_execute_streaming_mode_with_data_events(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test that execute processes data events correctly in streaming mode."""

    async def mock_stream(content_blocks):
        """Mock streaming function that yields data events."""
        yield {"data": "First chunk"}
        yield {"data": "Second chunk"}
        yield {"result": MagicMock(spec=SAAgentResult)}

    # Setup mock agent streaming
    mock_strands_agent.stream_async = MagicMock(return_value=mock_stream([]))

    # Create executor
    executor = StrandsA2AExecutor(mock_strands_agent)

    # Mock the task creation
    mock_task = MagicMock()
    mock_task.id = "test-task-id"
    mock_task.context_id = "test-context-id"
    mock_request_context.current_task = mock_task

    # Mock message with parts
    from a2a.types import TextPart

    mock_message = MagicMock()
    text_part = MagicMock(spec=TextPart)
    text_part.text = "Test input"
    part = MagicMock()
    part.root = text_part
    mock_message.parts = [part]
    mock_request_context.message = mock_message

    await executor.execute(mock_request_context, mock_event_queue)

    # Verify agent was called with ContentBlock list
    mock_strands_agent.stream_async.assert_called_once()
    call_args = mock_strands_agent.stream_async.call_args[0][0]
    assert isinstance(call_args, list)
    assert len(call_args) == 1
    assert call_args[0]["text"] == "Test input"

    # Verify events were enqueued
    mock_event_queue.enqueue_event.assert_called()


@pytest.mark.asyncio
async def test_execute_streaming_mode_with_result_event(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test that execute processes result events correctly in streaming mode."""

    async def mock_stream(content_blocks):
        """Mock streaming function that yields only result event."""
        yield {"result": MagicMock(spec=SAAgentResult)}

    # Setup mock agent streaming
    mock_strands_agent.stream_async = MagicMock(return_value=mock_stream([]))

    # Create executor
    executor = StrandsA2AExecutor(mock_strands_agent)

    # Mock the task creation
    mock_task = MagicMock()
    mock_task.id = "test-task-id"
    mock_task.context_id = "test-context-id"
    mock_request_context.current_task = mock_task

    # Mock message with parts
    from a2a.types import TextPart

    mock_message = MagicMock()
    text_part = MagicMock(spec=TextPart)
    text_part.text = "Test input"
    part = MagicMock()
    part.root = text_part
    mock_message.parts = [part]
    mock_request_context.message = mock_message

    await executor.execute(mock_request_context, mock_event_queue)

    # Verify agent was called with ContentBlock list
    mock_strands_agent.stream_async.assert_called_once()
    call_args = mock_strands_agent.stream_async.call_args[0][0]
    assert isinstance(call_args, list)
    assert len(call_args) == 1
    assert call_args[0]["text"] == "Test input"

    # Verify events were enqueued
    mock_event_queue.enqueue_event.assert_called()


@pytest.mark.asyncio
async def test_execute_streaming_mode_with_empty_data(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test that execute handles empty data events correctly in streaming mode."""

    async def mock_stream(content_blocks):
        """Mock streaming function that yields empty data."""
        yield {"data": ""}
        yield {"result": MagicMock(spec=SAAgentResult)}

    # Setup mock agent streaming
    mock_strands_agent.stream_async = MagicMock(return_value=mock_stream([]))

    # Create executor
    executor = StrandsA2AExecutor(mock_strands_agent)

    # Mock the task creation
    mock_task = MagicMock()
    mock_task.id = "test-task-id"
    mock_task.context_id = "test-context-id"
    mock_request_context.current_task = mock_task

    # Mock message with parts
    from a2a.types import TextPart

    mock_message = MagicMock()
    text_part = MagicMock(spec=TextPart)
    text_part.text = "Test input"
    part = MagicMock()
    part.root = text_part
    mock_message.parts = [part]
    mock_request_context.message = mock_message

    await executor.execute(mock_request_context, mock_event_queue)

    # Verify agent was called with ContentBlock list
    mock_strands_agent.stream_async.assert_called_once()
    call_args = mock_strands_agent.stream_async.call_args[0][0]
    assert isinstance(call_args, list)
    assert len(call_args) == 1
    assert call_args[0]["text"] == "Test input"

    # Verify events were enqueued
    mock_event_queue.enqueue_event.assert_called()


@pytest.mark.asyncio
async def test_execute_streaming_mode_with_unexpected_event(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test that execute handles unexpected events correctly in streaming mode."""

    async def mock_stream(content_blocks):
        """Mock streaming function that yields unexpected event."""
        yield {"unexpected": "event"}
        yield {"result": MagicMock(spec=SAAgentResult)}

    # Setup mock agent streaming
    mock_strands_agent.stream_async = MagicMock(return_value=mock_stream([]))

    # Create executor
    executor = StrandsA2AExecutor(mock_strands_agent)

    # Mock the task creation
    mock_task = MagicMock()
    mock_task.id = "test-task-id"
    mock_task.context_id = "test-context-id"
    mock_request_context.current_task = mock_task

    # Mock message with parts
    from a2a.types import TextPart

    mock_message = MagicMock()
    text_part = MagicMock(spec=TextPart)
    text_part.text = "Test input"
    part = MagicMock()
    part.root = text_part
    mock_message.parts = [part]
    mock_request_context.message = mock_message

    await executor.execute(mock_request_context, mock_event_queue)

    # Verify agent was called with ContentBlock list
    mock_strands_agent.stream_async.assert_called_once()
    call_args = mock_strands_agent.stream_async.call_args[0][0]
    assert isinstance(call_args, list)
    assert len(call_args) == 1
    assert call_args[0]["text"] == "Test input"

    # Verify events were enqueued
    mock_event_queue.enqueue_event.assert_called()


@pytest.mark.asyncio
async def test_execute_streaming_mode_fallback_to_text_extraction(
    mock_strands_agent, mock_request_context, mock_event_queue
):
    """Test that execute raises ServerError when no A2A parts are available."""

    # Create executor
    executor = StrandsA2AExecutor(mock_strands_agent)

    # Mock the task creation
    mock_task = MagicMock()
    mock_task.id = "test-task-id"
    mock_task.context_id = "test-context-id"
    mock_request_context.current_task = mock_task

    # Mock message without parts attribute
    mock_message = MagicMock()
    delattr(mock_message, "parts")  # Remove parts attribute
    mock_request_context.message = mock_message
    mock_request_context.get_user_input.return_value = "Fallback input"

    with pytest.raises(ServerError) as excinfo:
        await executor.execute(mock_request_context, mock_event_queue)

    # Verify the error is a ServerError containing an InternalError
    assert isinstance(excinfo.value.error, InternalError)


@pytest.mark.asyncio
async def test_execute_creates_task_when_none_exists(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test that execute creates a new task when none exists."""

    async def mock_stream(content_blocks):
        """Mock streaming function that yields data events."""
        yield {"data": "Test chunk"}
        yield {"result": MagicMock(spec=SAAgentResult)}

    # Setup mock agent streaming
    mock_strands_agent.stream_async = MagicMock(return_value=mock_stream([]))

    # Create executor
    executor = StrandsA2AExecutor(mock_strands_agent)

    # Mock no existing task
    mock_request_context.current_task = None

    # Mock message with parts
    from a2a.types import TextPart

    mock_message = MagicMock()
    text_part = MagicMock(spec=TextPart)
    text_part.text = "Test input"
    part = MagicMock()
    part.root = text_part
    mock_message.parts = [part]
    mock_request_context.message = mock_message

    with patch("strands.multiagent.a2a.executor.new_task") as mock_new_task:
        mock_new_task.return_value = MagicMock(id="new-task-id", context_id="new-context-id")

        await executor.execute(mock_request_context, mock_event_queue)

    # Verify task creation and completion events were enqueued
    assert mock_event_queue.enqueue_event.call_count >= 1
    mock_new_task.assert_called_once()


@pytest.mark.asyncio
async def test_execute_streaming_mode_handles_agent_exception(
    mock_strands_agent, mock_request_context, mock_event_queue
):
    """Test that execute transitions to failed state when agent raises exception."""

    # Setup mock agent to raise exception when stream_async is called
    mock_strands_agent.stream_async = MagicMock(side_effect=Exception("Agent error"))

    # Create executor
    executor = StrandsA2AExecutor(mock_strands_agent)

    # Mock the task creation
    mock_task = MagicMock()
    mock_task.id = "test-task-id"
    mock_task.context_id = "test-context-id"
    mock_request_context.current_task = mock_task

    # Mock message with parts
    from a2a.types import TextPart

    mock_message = MagicMock()
    text_part = MagicMock(spec=TextPart)
    text_part.text = "Test input"
    part = MagicMock()
    part.root = text_part
    mock_message.parts = [part]
    mock_request_context.message = mock_message

    # Should NOT raise - instead transitions to failed state
    await executor.execute(mock_request_context, mock_event_queue)

    # Verify agent was called
    mock_strands_agent.stream_async.assert_called_once()

    # Verify a failed status event was enqueued
    enqueued_events = [call[0][0] for call in mock_event_queue.enqueue_event.call_args_list]
    from a2a.types import TaskState, TaskStatusUpdateEvent

    failed_events = [
        e for e in enqueued_events if isinstance(e, TaskStatusUpdateEvent) and e.status.state == TaskState.failed
    ]
    assert len(failed_events) == 1
    assert "Agent execution failed" in failed_events[0].status.message.parts[0].root.text
    executor = StrandsA2AExecutor(mock_strands_agent)

    # Cancel with no current_task raises UnsupportedOperationError
    mock_request_context.current_task = None
    with pytest.raises(ServerError) as excinfo:
        await executor.cancel(mock_request_context, mock_event_queue)

    # Verify the error is a ServerError containing an UnsupportedOperationError
    assert isinstance(excinfo.value.error, UnsupportedOperationError)


@pytest.mark.asyncio
async def test_handle_agent_result_with_none_result(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test that _handle_agent_result handles None result correctly."""
    executor = StrandsA2AExecutor(mock_strands_agent)

    # Mock the task creation
    mock_task = MagicMock()
    mock_task.id = "test-task-id"
    mock_task.context_id = "test-context-id"
    mock_request_context.current_task = mock_task

    # Mock TaskUpdater
    mock_updater = MagicMock()
    mock_updater.complete = AsyncMock()
    mock_updater.add_artifact = AsyncMock()

    # Call _handle_agent_result with None
    await executor._handle_agent_result(None, mock_updater, None)

    # Verify completion was called
    mock_updater.complete.assert_called_once()


@pytest.mark.asyncio
async def test_handle_agent_result_with_result_but_no_message(
    mock_strands_agent, mock_request_context, mock_event_queue
):
    """Test that _handle_agent_result handles result with no message correctly."""
    executor = StrandsA2AExecutor(mock_strands_agent)

    # Mock the task creation
    mock_task = MagicMock()
    mock_task.id = "test-task-id"
    mock_task.context_id = "test-context-id"
    mock_request_context.current_task = mock_task

    # Mock TaskUpdater
    mock_updater = MagicMock()
    mock_updater.complete = AsyncMock()
    mock_updater.add_artifact = AsyncMock()

    # Create result with no message
    mock_result = MagicMock(spec=SAAgentResult)
    mock_result.message = None

    # Call _handle_agent_result
    await executor._handle_agent_result(mock_result, mock_updater, None)

    # Verify completion was called
    mock_updater.complete.assert_called_once()


@pytest.mark.asyncio
async def test_handle_agent_result_with_content(mock_strands_agent):
    """Test that _handle_agent_result handles result with content correctly."""
    executor = StrandsA2AExecutor(mock_strands_agent)

    # Mock TaskUpdater
    mock_updater = MagicMock()
    mock_updater.complete = AsyncMock()
    mock_updater.add_artifact = AsyncMock()

    # Create result with content
    mock_result = MagicMock(spec=SAAgentResult)
    mock_result.__str__ = MagicMock(return_value="Test response content")

    # Call _handle_agent_result
    await executor._handle_agent_result(mock_result, mock_updater, None)

    # Verify artifact was added and task completed
    mock_updater.add_artifact.assert_called_once()
    mock_updater.complete.assert_called_once()

    # Check that the artifact contains the expected content
    call_args = mock_updater.add_artifact.call_args[0][0]
    assert len(call_args) == 1
    assert call_args[0].root.text == "Test response content"


def test_handle_conversion_error():
    """Test that conversion handles errors gracefully."""
    executor = StrandsA2AExecutor(MagicMock())

    # Mock Part that will raise an exception during processing
    problematic_part = MagicMock()
    problematic_part.root = None  # This should cause an AttributeError

    # Should not raise an exception, but return empty list or handle gracefully
    result = executor._convert_a2a_parts_to_content_blocks([problematic_part])

    # The method should handle the error and continue
    assert isinstance(result, list)


def test_convert_a2a_parts_to_content_blocks_empty_list():
    """Test conversion with empty parts list."""
    executor = StrandsA2AExecutor(MagicMock())

    result = executor._convert_a2a_parts_to_content_blocks([])

    assert result == []


def test_convert_a2a_parts_to_content_blocks_file_part_no_name():
    """Test conversion of FilePart with no file name."""
    executor = StrandsA2AExecutor(MagicMock())

    base64_bytes = base64.b64encode(VALID_DOCUMENT_BYTES).decode("utf-8")

    # Mock file object without name
    file_obj = MagicMock()
    delattr(file_obj, "name")  # Remove name attribute
    file_obj.mime_type = "text/plain"
    file_obj.bytes = base64_bytes
    file_obj.uri = None

    # Mock FilePart with proper spec
    file_part = MagicMock(spec=FilePart)
    file_part.file = file_obj

    # Mock Part with FilePart root
    part = MagicMock()
    part.root = file_part

    result = executor._convert_a2a_parts_to_content_blocks([part])

    assert len(result) == 1
    content_block = result[0]
    assert "document" in content_block
    assert content_block["document"]["name"] == "FileNameNotProvided"  # Should use default


def test_convert_a2a_parts_to_content_blocks_file_part_no_mime_type():
    """Test conversion of FilePart with no MIME type."""
    executor = StrandsA2AExecutor(MagicMock())

    base64_bytes = base64.b64encode(VALID_DOCUMENT_BYTES).decode("utf-8")

    # Mock file object without MIME type
    file_obj = MagicMock()
    file_obj.name = "test_file"
    delattr(file_obj, "mime_type")
    file_obj.bytes = base64_bytes
    file_obj.uri = None

    # Mock FilePart with proper spec
    file_part = MagicMock(spec=FilePart)
    file_part.file = file_obj

    # Mock Part with FilePart root
    part = MagicMock()
    part.root = file_part

    result = executor._convert_a2a_parts_to_content_blocks([part])

    assert len(result) == 1
    content_block = result[0]
    assert "document" in content_block  # Should default to document with unknown type
    assert content_block["document"]["format"] == "txt"  # Should use default format for unknown file type


def test_convert_a2a_parts_to_content_blocks_file_part_no_bytes_no_uri():
    """Test conversion of FilePart with neither bytes nor URI."""
    from a2a.types import FilePart

    executor = StrandsA2AExecutor(MagicMock())

    # Mock file object without bytes or URI
    file_obj = MagicMock()
    file_obj.name = "test_file.txt"
    file_obj.mime_type = "text/plain"
    file_obj.bytes = None
    file_obj.uri = None

    # Mock FilePart with proper spec
    file_part = MagicMock(spec=FilePart)
    file_part.file = file_obj

    # Mock Part with FilePart root
    part = MagicMock()
    part.root = file_part

    result = executor._convert_a2a_parts_to_content_blocks([part])

    # Should return empty list since no fallback case exists
    assert len(result) == 0


def test_convert_a2a_parts_to_content_blocks_data_part_serialization_error():
    """Test conversion of DataPart with non-serializable data."""
    from a2a.types import DataPart

    executor = StrandsA2AExecutor(MagicMock())

    # Create non-serializable data (e.g., a function)
    def non_serializable():
        pass

    # Mock DataPart with proper spec
    data_part = MagicMock(spec=DataPart)
    data_part.data = {"function": non_serializable}  # This will cause JSON serialization to fail

    # Mock Part with DataPart root
    part = MagicMock()
    part.root = data_part

    # Should not raise an exception, should handle gracefully
    result = executor._convert_a2a_parts_to_content_blocks([part])

    # The error handling should result in an empty list or the part being skipped
    assert isinstance(result, list)


@pytest.mark.asyncio
async def test_execute_streaming_mode_raises_error_for_empty_content_blocks(
    mock_strands_agent, mock_event_queue, mock_request_context
):
    """Test that execute raises ServerError when content blocks are empty after conversion."""
    executor = StrandsA2AExecutor(mock_strands_agent)

    # Create a mock message with parts that will result in empty content blocks
    # This could happen if all parts fail to convert or are invalid
    mock_message = MagicMock()
    mock_message.parts = [MagicMock()]  # Has parts but they won't convert to valid content blocks
    mock_request_context.message = mock_message

    # Mock the conversion to return empty list
    with patch.object(executor, "_convert_a2a_parts_to_content_blocks", return_value=[]):
        with pytest.raises(ServerError) as excinfo:
            await executor.execute(mock_request_context, mock_event_queue)

        # Verify the error is a ServerError containing an InternalError
        assert isinstance(excinfo.value.error, InternalError)


@pytest.mark.asyncio
async def test_execute_with_mixed_part_types(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test execute with a message containing mixed A2A part types."""

    async def mock_stream(content_blocks):
        """Mock streaming function."""
        yield {"data": "Processing mixed content"}
        yield {"result": MagicMock(spec=SAAgentResult)}

    # Setup mock agent streaming
    mock_strands_agent.stream_async = MagicMock(return_value=mock_stream([]))

    # Create executor
    executor = StrandsA2AExecutor(mock_strands_agent)

    # Mock the task creation
    mock_task = MagicMock()
    mock_task.id = "test-task-id"
    mock_task.context_id = "test-context-id"
    mock_request_context.current_task = mock_task

    # Create mixed parts
    text_part = MagicMock(spec=TextPart)
    text_part.text = "Hello"
    text_part_mock = MagicMock()
    text_part_mock.root = text_part

    # File part with bytes
    file_obj = MagicMock()
    file_obj.name = "image.png"
    file_obj.mime_type = "image/png"
    file_obj.bytes = base64.b64encode(VALID_PNG_BYTES).decode("utf-8")
    file_obj.uri = None
    file_part = MagicMock(spec=FilePart)
    file_part.file = file_obj
    file_part_mock = MagicMock()
    file_part_mock.root = file_part

    # Data part
    data_part = MagicMock(spec=DataPart)
    data_part.data = {"key": "value"}
    data_part_mock = MagicMock()
    data_part_mock.root = data_part

    # Mock message with mixed parts
    mock_message = MagicMock()
    mock_message.parts = [text_part_mock, file_part_mock, data_part_mock]
    mock_request_context.message = mock_message

    await executor.execute(mock_request_context, mock_event_queue)

    # Verify agent was called with ContentBlock list containing all types
    mock_strands_agent.stream_async.assert_called_once()
    call_args = mock_strands_agent.stream_async.call_args[0][0]
    assert isinstance(call_args, list)
    assert len(call_args) == 3  # Should have converted all 3 parts

    # Check that we have text, image, and structured data
    has_text = any("text" in block for block in call_args)
    has_image = any("image" in block for block in call_args)
    has_structured_data = any("text" in block and "[Structured Data]" in block.get("text", "") for block in call_args)

    assert has_text
    assert has_image
    assert has_structured_data


def test_integration_example():
    """Integration test example showing how A2A Parts are converted to ContentBlocks.

    This test serves as documentation for the conversion functionality.
    """
    executor = StrandsA2AExecutor(MagicMock())

    # Example 1: Text content
    text_part = MagicMock(spec=TextPart)
    text_part.text = "Hello, this is a text message"
    text_part_mock = MagicMock()
    text_part_mock.root = text_part

    # Example 2: Image file
    image_bytes = base64.b64encode(VALID_PNG_BYTES).decode("utf-8")
    image_file = MagicMock()
    image_file.name = "photo.jpg"
    image_file.mime_type = "image/jpeg"
    image_file.bytes = image_bytes
    image_file.uri = None

    image_part = MagicMock(spec=FilePart)
    image_part.file = image_file
    image_part_mock = MagicMock()
    image_part_mock.root = image_part

    # Example 3: Document file
    doc_bytes = base64.b64encode(VALID_DOCUMENT_BYTES).decode("utf-8")
    doc_file = MagicMock()
    doc_file.name = "report.pdf"
    doc_file.mime_type = "application/pdf"
    doc_file.bytes = doc_bytes
    doc_file.uri = None

    doc_part = MagicMock(spec=FilePart)
    doc_part.file = doc_file
    doc_part_mock = MagicMock()
    doc_part_mock.root = doc_part

    # Example 4: Structured data
    data_part = MagicMock(spec=DataPart)
    data_part.data = {"user": "john_doe", "action": "upload_file", "timestamp": "2023-12-01T10:00:00Z"}
    data_part_mock = MagicMock()
    data_part_mock.root = data_part

    # Convert all parts to ContentBlocks
    parts = [text_part_mock, image_part_mock, doc_part_mock, data_part_mock]
    content_blocks = executor._convert_a2a_parts_to_content_blocks(parts)

    # Verify conversion results
    assert len(content_blocks) == 4

    # Text part becomes text ContentBlock
    assert content_blocks[0]["text"] == "Hello, this is a text message"

    # Image part becomes image ContentBlock with proper format and bytes
    assert "image" in content_blocks[1]
    assert content_blocks[1]["image"]["format"] == "jpeg"
    assert content_blocks[1]["image"]["source"]["bytes"] == VALID_PNG_BYTES

    # Document part becomes document ContentBlock
    assert "document" in content_blocks[2]
    assert content_blocks[2]["document"]["format"] == "pdf"
    assert content_blocks[2]["document"]["name"] == "report"  # Extension stripped
    assert content_blocks[2]["document"]["source"]["bytes"] == VALID_DOCUMENT_BYTES

    # Data part becomes text ContentBlock with JSON representation
    assert "text" in content_blocks[3]
    assert "[Structured Data]" in content_blocks[3]["text"]
    assert "john_doe" in content_blocks[3]["text"]
    assert "upload_file" in content_blocks[3]["text"]


def test_default_formats_modularization():
    """Test that DEFAULT_FORMATS mapping works correctly for modular format defaults."""
    executor = StrandsA2AExecutor(MagicMock())

    # Test that DEFAULT_FORMATS contains expected mappings
    assert hasattr(executor, "DEFAULT_FORMATS")
    assert executor.DEFAULT_FORMATS["document"] == "txt"
    assert executor.DEFAULT_FORMATS["image"] == "png"
    assert executor.DEFAULT_FORMATS["video"] == "mp4"
    assert executor.DEFAULT_FORMATS["unknown"] == "txt"

    # Test format selection with None mime_type
    assert executor._get_file_format_from_mime_type(None, "document") == "txt"
    assert executor._get_file_format_from_mime_type(None, "image") == "png"
    assert executor._get_file_format_from_mime_type(None, "video") == "mp4"
    assert executor._get_file_format_from_mime_type(None, "unknown") == "txt"
    assert executor._get_file_format_from_mime_type(None, "nonexistent") == "txt"  # fallback

    # Test format selection with empty mime_type
    assert executor._get_file_format_from_mime_type("", "document") == "txt"
    assert executor._get_file_format_from_mime_type("", "image") == "png"
    assert executor._get_file_format_from_mime_type("", "video") == "mp4"


# Tests for enable_a2a_compliant_streaming parameter


@pytest.mark.asyncio
async def test_legacy_mode_emits_deprecation_warning(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test that legacy streaming (default) emits deprecation warning."""
    from a2a.types import TextPart

    executor = StrandsA2AExecutor(mock_strands_agent)  # Default is False

    # Mock stream_async
    async def mock_stream(content_blocks):
        yield {"result": None}

    mock_strands_agent.stream_async = MagicMock(return_value=mock_stream([]))

    # Mock task
    mock_task = MagicMock()
    mock_task.id = "test-task-id"
    mock_task.context_id = "test-context-id"
    mock_request_context.current_task = mock_task

    # Mock message
    mock_text_part = MagicMock(spec=TextPart)
    mock_text_part.text = "test"
    mock_part = MagicMock()
    mock_part.root = mock_text_part
    mock_message = MagicMock()
    mock_message.parts = [mock_part]
    mock_request_context.message = mock_message

    with pytest.warns(UserWarning, match="does not conform to what is expected in the A2A spec"):
        await executor.execute(mock_request_context, mock_event_queue)


@pytest.mark.asyncio
async def test_a2a_compliant_mode_no_warning(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test that A2A-compliant mode does not emit warning."""
    import warnings

    from a2a.types import TextPart

    executor = StrandsA2AExecutor(mock_strands_agent, enable_a2a_compliant_streaming=True)

    # Mock stream_async
    async def mock_stream(content_blocks):
        yield {"result": None}

    mock_strands_agent.stream_async = MagicMock(return_value=mock_stream([]))

    # Mock task
    mock_task = MagicMock()
    mock_task.id = "test-task-id"
    mock_task.context_id = "test-context-id"
    mock_request_context.current_task = mock_task

    # Mock message
    mock_text_part = MagicMock(spec=TextPart)
    mock_text_part.text = "test"
    mock_part = MagicMock()
    mock_part.root = mock_text_part
    mock_message = MagicMock()
    mock_message.parts = [mock_part]
    mock_request_context.message = mock_message

    with warnings.catch_warnings():
        warnings.simplefilter("error")
        try:
            await executor.execute(mock_request_context, mock_event_queue)
        except UserWarning:
            pytest.fail("Should not emit warning")


@pytest.mark.asyncio
async def test_a2a_compliant_mode_uses_add_artifact(mock_strands_agent):
    """Test that A2A-compliant mode uses add_artifact with artifact_id."""
    executor = StrandsA2AExecutor(mock_strands_agent, enable_a2a_compliant_streaming=True)
    stream_state = _StreamState(artifact_id="artifact-123", is_first_chunk=True)

    mock_updater = MagicMock()
    mock_updater.add_artifact = AsyncMock()
    mock_updater.update_status = AsyncMock()

    event = {"data": "content"}
    await executor._handle_streaming_event(event, mock_updater, stream_state)

    mock_updater.add_artifact.assert_called_once()
    assert mock_updater.add_artifact.call_args[1]["artifact_id"] == "artifact-123"
    assert mock_updater.add_artifact.call_args[1]["append"] is False
    mock_updater.update_status.assert_not_called()


@pytest.mark.asyncio
async def test_a2a_compliant_handle_result_first_chunk_with_content(mock_strands_agent):
    """Test that A2A-compliant mode sends a TextPart with content when first chunk and result has content."""
    executor = StrandsA2AExecutor(mock_strands_agent, enable_a2a_compliant_streaming=True)
    stream_state = _StreamState(artifact_id="artifact-456", is_first_chunk=True)

    mock_updater = MagicMock()
    mock_updater.add_artifact = AsyncMock()
    mock_updater.complete = AsyncMock()

    mock_result = MagicMock(spec=SAAgentResult)
    mock_result.__str__ = MagicMock(return_value="Final response")

    await executor._handle_agent_result(mock_result, mock_updater, stream_state)

    mock_updater.add_artifact.assert_called_once()
    parts = mock_updater.add_artifact.call_args[0][0]
    assert len(parts) == 1
    assert parts[0].root.text == "Final response"
    assert mock_updater.add_artifact.call_args[1]["artifact_id"] == "artifact-456"
    assert mock_updater.add_artifact.call_args[1]["last_chunk"] is True
    mock_updater.complete.assert_called_once()


@pytest.mark.asyncio
async def test_a2a_compliant_handle_result_first_chunk_with_none_result(mock_strands_agent):
    """Test that A2A-compliant mode sends a TextPart with empty string when first chunk and result is None.

    Per the A2A spec, parts must contain at least one part, so even with no result
    we should send a TextPart with an empty string rather than an empty list.
    """
    executor = StrandsA2AExecutor(mock_strands_agent, enable_a2a_compliant_streaming=True)
    stream_state = _StreamState(artifact_id="artifact-789", is_first_chunk=True)

    mock_updater = MagicMock()
    mock_updater.add_artifact = AsyncMock()
    mock_updater.complete = AsyncMock()

    await executor._handle_agent_result(None, mock_updater, stream_state)

    mock_updater.add_artifact.assert_called_once()
    parts = mock_updater.add_artifact.call_args[0][0]
    assert len(parts) == 1
    assert parts[0].root.text == ""
    assert mock_updater.add_artifact.call_args[1]["artifact_id"] == "artifact-789"
    assert mock_updater.add_artifact.call_args[1]["last_chunk"] is True
    mock_updater.complete.assert_called_once()


@pytest.mark.asyncio
async def test_a2a_compliant_handle_result_not_first_chunk(mock_strands_agent):
    """Test that A2A-compliant mode sends a TextPart with empty string when not the first chunk.

    Per the A2A spec, parts must contain at least one part, so the final marker
    chunk should include a TextPart with an empty string rather than an empty list.
    """
    executor = StrandsA2AExecutor(mock_strands_agent, enable_a2a_compliant_streaming=True)
    stream_state = _StreamState(artifact_id="artifact-abc", is_first_chunk=False)

    mock_updater = MagicMock()
    mock_updater.add_artifact = AsyncMock()
    mock_updater.complete = AsyncMock()

    mock_result = MagicMock(spec=SAAgentResult)
    mock_result.__str__ = MagicMock(return_value="Some content")

    await executor._handle_agent_result(mock_result, mock_updater, stream_state)

    mock_updater.add_artifact.assert_called_once()
    parts = mock_updater.add_artifact.call_args[0][0]
    assert len(parts) == 1
    assert parts[0].root.text == ""
    assert mock_updater.add_artifact.call_args[1]["artifact_id"] == "artifact-abc"
    assert mock_updater.add_artifact.call_args[1]["append"] is True
    assert mock_updater.add_artifact.call_args[1]["last_chunk"] is True


# Tests for invocation state propagation from A2A request context


def _setup_streaming_context(
    mock_strands_agent: MagicMock,
    mock_request_context: MagicMock,
) -> None:
    """Set up common mocks for invocation state streaming tests.

    Args:
        mock_strands_agent: The mock Strands Agent.
        mock_request_context: The mock RequestContext.
    """

    async def mock_stream(content_blocks: list, **kwargs: Any) -> Any:
        yield {"result": MagicMock(spec=SAAgentResult)}

    mock_strands_agent.stream_async = MagicMock(side_effect=mock_stream)

    # Set up message with a text part
    mock_text_part = MagicMock(spec=TextPart)
    mock_text_part.text = "test input"
    mock_part = MagicMock()
    mock_part.root = mock_text_part
    mock_message = MagicMock()
    mock_message.parts = [mock_part]
    mock_request_context.message = mock_message


@pytest.mark.asyncio
async def test_invocation_state_contains_request_context(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test that the full RequestContext is passed as a2a_request_context in invocation state."""
    mock_task = MagicMock()
    mock_task.id = "task-42"
    mock_task.context_id = "ctx-99"
    mock_request_context.current_task = mock_task
    mock_request_context.metadata = {"caller": "test-client"}

    _setup_streaming_context(mock_strands_agent, mock_request_context)

    executor = StrandsA2AExecutor(mock_strands_agent)
    await executor.execute(mock_request_context, mock_event_queue)

    mock_strands_agent.stream_async.assert_called_once()
    call_kwargs = mock_strands_agent.stream_async.call_args[1]
    invocation_state = call_kwargs["invocation_state"]

    assert invocation_state is not None
    assert invocation_state["a2a_request_context"] is mock_request_context


@pytest.mark.asyncio
async def test_invocation_state_context_exposes_metadata(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test that metadata is accessible through the RequestContext in invocation state."""
    test_metadata = {"caller": "test-client", "session": "abc-123"}
    mock_request_context.metadata = test_metadata
    mock_task = MagicMock()
    mock_task.id = "task-1"
    mock_task.context_id = "ctx-1"
    mock_request_context.current_task = mock_task

    _setup_streaming_context(mock_strands_agent, mock_request_context)

    executor = StrandsA2AExecutor(mock_strands_agent)
    await executor.execute(mock_request_context, mock_event_queue)

    call_kwargs = mock_strands_agent.stream_async.call_args[1]
    context = call_kwargs["invocation_state"]["a2a_request_context"]

    assert context.metadata == test_metadata


@pytest.mark.asyncio
async def test_invocation_state_context_exposes_task_info(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test that task info is accessible through the RequestContext in invocation state."""
    mock_task = MagicMock()
    mock_task.id = "task-100"
    mock_task.context_id = "ctx-200"
    mock_request_context.current_task = mock_task

    _setup_streaming_context(mock_strands_agent, mock_request_context)

    executor = StrandsA2AExecutor(mock_strands_agent)
    await executor.execute(mock_request_context, mock_event_queue)

    call_kwargs = mock_strands_agent.stream_async.call_args[1]
    context = call_kwargs["invocation_state"]["a2a_request_context"]

    assert context.current_task.id == "task-100"
    assert context.current_task.context_id == "ctx-200"


@pytest.mark.asyncio
async def test_invocation_state_context_when_no_task(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test that RequestContext is passed even when there is no current task."""
    mock_request_context.current_task = None
    mock_request_context.metadata = {}

    _setup_streaming_context(mock_strands_agent, mock_request_context)

    executor = StrandsA2AExecutor(mock_strands_agent)

    with patch("strands.multiagent.a2a.executor.new_task") as mock_new_task:
        mock_new_task.return_value = MagicMock(id="generated-id", context_id="generated-ctx")
        await executor.execute(mock_request_context, mock_event_queue)

    call_kwargs = mock_strands_agent.stream_async.call_args[1]
    invocation_state = call_kwargs["invocation_state"]

    assert invocation_state["a2a_request_context"] is mock_request_context


@pytest.mark.asyncio
async def test_invocation_state_with_a2a_compliant_streaming(
    mock_strands_agent, mock_request_context, mock_event_queue
):
    """Test that invocation state is passed correctly in A2A-compliant streaming mode."""
    mock_task = MagicMock()
    mock_task.id = "task-compliant"
    mock_task.context_id = "ctx-compliant"
    mock_request_context.current_task = mock_task

    _setup_streaming_context(mock_strands_agent, mock_request_context)

    executor = StrandsA2AExecutor(mock_strands_agent, enable_a2a_compliant_streaming=True)
    await executor.execute(mock_request_context, mock_event_queue)

    call_kwargs = mock_strands_agent.stream_async.call_args[1]
    invocation_state = call_kwargs["invocation_state"]

    assert invocation_state is not None
    assert invocation_state["a2a_request_context"] is mock_request_context


# =========================================================================
# NEW TESTS: A2A Lifecycle State Support
# =========================================================================


@pytest.mark.asyncio
async def test_execute_transitions_to_failed_on_streaming_error(
    mock_strands_agent, mock_request_context, mock_event_queue
):
    """Test that errors during streaming transition task to failed state."""
    from a2a.types import TaskState, TaskStatusUpdateEvent, TextPart

    async def mock_stream(content_blocks, **kwargs):
        """Mock streaming that raises mid-stream."""
        yield {"data": "partial output"}
        raise RuntimeError("Connection lost")

    mock_strands_agent.stream_async = MagicMock(side_effect=mock_stream)

    executor = StrandsA2AExecutor(mock_strands_agent)

    mock_task = MagicMock()
    mock_task.id = "task-fail"
    mock_task.context_id = "ctx-fail"
    mock_request_context.current_task = mock_task

    mock_text_part = MagicMock(spec=TextPart)
    mock_text_part.text = "test"
    mock_part = MagicMock()
    mock_part.root = mock_text_part
    mock_message = MagicMock()
    mock_message.parts = [mock_part]
    mock_request_context.message = mock_message

    # Should not raise
    await executor.execute(mock_request_context, mock_event_queue)

    # Verify failed state was enqueued
    enqueued_events = [call[0][0] for call in mock_event_queue.enqueue_event.call_args_list]
    failed_events = [
        e for e in enqueued_events if isinstance(e, TaskStatusUpdateEvent) and e.status.state == TaskState.failed
    ]
    assert len(failed_events) == 1
    assert "Agent execution failed" in failed_events[0].status.message.parts[0].root.text


@pytest.mark.asyncio
async def test_cancel_with_valid_task(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test that cancel transitions task to canceled state when task exists."""
    from a2a.types import TaskState, TaskStatusUpdateEvent

    executor = StrandsA2AExecutor(mock_strands_agent)

    mock_task = MagicMock()
    mock_task.id = "task-cancel"
    mock_task.context_id = "ctx-cancel"
    mock_request_context.current_task = mock_task

    await executor.cancel(mock_request_context, mock_event_queue)

    # Verify canceled state was enqueued
    enqueued_events = [call[0][0] for call in mock_event_queue.enqueue_event.call_args_list]
    canceled_events = [
        e for e in enqueued_events if isinstance(e, TaskStatusUpdateEvent) and e.status.state == TaskState.canceled
    ]
    assert len(canceled_events) == 1
    assert "cancelled" in canceled_events[0].status.message.parts[0].root.text.lower()


@pytest.mark.asyncio
async def test_cancel_without_task_raises_unsupported(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test that cancel raises UnsupportedOperationError when no task exists."""
    executor = StrandsA2AExecutor(mock_strands_agent)
    mock_request_context.current_task = None

    with pytest.raises(ServerError) as excinfo:
        await executor.cancel(mock_request_context, mock_event_queue)

    assert isinstance(excinfo.value.error, UnsupportedOperationError)


@pytest.mark.asyncio
async def test_execute_with_interrupt_transitions_to_input_required(
    mock_strands_agent, mock_request_context, mock_event_queue
):
    """Test that agent interrupts map to input_required state."""
    from a2a.types import TaskState, TaskStatusUpdateEvent, TextPart

    from strands.interrupt import Interrupt

    # Create a mock result with interrupts
    mock_result = MagicMock(spec=SAAgentResult)
    mock_result.stop_reason = "interrupt"
    mock_interrupt = Interrupt(id="int-1", name="approval", reason="Need user approval")
    mock_result.interrupts = [mock_interrupt]

    async def mock_stream(content_blocks, **kwargs):
        yield {"data": "Processing..."}
        yield {"result": mock_result}

    mock_strands_agent.stream_async = MagicMock(side_effect=mock_stream)

    executor = StrandsA2AExecutor(mock_strands_agent)

    mock_task = MagicMock()
    mock_task.id = "task-interrupt"
    mock_task.context_id = "ctx-interrupt"
    mock_request_context.current_task = mock_task

    mock_text_part = MagicMock(spec=TextPart)
    mock_text_part.text = "delete file X"
    mock_part = MagicMock()
    mock_part.root = mock_text_part
    mock_message = MagicMock()
    mock_message.parts = [mock_part]
    mock_request_context.message = mock_message

    await executor.execute(mock_request_context, mock_event_queue)

    # Verify input_required state was enqueued
    enqueued_events = [call[0][0] for call in mock_event_queue.enqueue_event.call_args_list]
    input_required_events = [
        e
        for e in enqueued_events
        if isinstance(e, TaskStatusUpdateEvent) and e.status.state == TaskState.input_required
    ]
    assert len(input_required_events) == 1
    msg_text = input_required_events[0].status.message.parts[0].root.text
    assert "approval" in msg_text
    assert "Need user approval" in msg_text


@pytest.mark.asyncio
async def test_execute_with_multiple_interrupts(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test handling of multiple interrupts in a single result."""
    from a2a.types import TaskState, TaskStatusUpdateEvent, TextPart

    from strands.interrupt import Interrupt

    mock_result = MagicMock(spec=SAAgentResult)
    mock_result.stop_reason = "interrupt"
    mock_result.interrupts = [
        Interrupt(id="int-1", name="confirm_delete", reason="Confirm deletion of file X"),
        Interrupt(id="int-2", name="select_backup", reason="Choose backup location"),
    ]

    async def mock_stream(content_blocks, **kwargs):
        yield {"result": mock_result}

    mock_strands_agent.stream_async = MagicMock(side_effect=mock_stream)

    executor = StrandsA2AExecutor(mock_strands_agent)

    mock_task = MagicMock()
    mock_task.id = "task-multi-int"
    mock_task.context_id = "ctx-multi-int"
    mock_request_context.current_task = mock_task

    mock_text_part = MagicMock(spec=TextPart)
    mock_text_part.text = "delete with backup"
    mock_part = MagicMock()
    mock_part.root = mock_text_part
    mock_message = MagicMock()
    mock_message.parts = [mock_part]
    mock_request_context.message = mock_message

    await executor.execute(mock_request_context, mock_event_queue)

    enqueued_events = [call[0][0] for call in mock_event_queue.enqueue_event.call_args_list]
    input_required_events = [
        e
        for e in enqueued_events
        if isinstance(e, TaskStatusUpdateEvent) and e.status.state == TaskState.input_required
    ]
    assert len(input_required_events) == 1
    msg_text = input_required_events[0].status.message.parts[0].root.text
    assert "confirm_delete" in msg_text
    assert "select_backup" in msg_text
    assert "Confirm deletion of file X" in msg_text
    assert "Choose backup location" in msg_text


@pytest.mark.asyncio
async def test_execute_normal_completion_no_interrupts(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test that normal completion (no interrupts) still works as before."""
    from a2a.types import TaskState, TaskStatusUpdateEvent, TextPart

    mock_result = MagicMock(spec=SAAgentResult)
    mock_result.stop_reason = "end_turn"
    mock_result.interrupts = None
    mock_result.__str__ = MagicMock(return_value="Task completed successfully")

    async def mock_stream(content_blocks, **kwargs):
        yield {"data": "Working..."}
        yield {"result": mock_result}

    mock_strands_agent.stream_async = MagicMock(side_effect=mock_stream)

    executor = StrandsA2AExecutor(mock_strands_agent)

    mock_task = MagicMock()
    mock_task.id = "task-normal"
    mock_task.context_id = "ctx-normal"
    mock_request_context.current_task = mock_task

    mock_text_part = MagicMock(spec=TextPart)
    mock_text_part.text = "do something"
    mock_part = MagicMock()
    mock_part.root = mock_text_part
    mock_message = MagicMock()
    mock_message.parts = [mock_part]
    mock_request_context.message = mock_message

    await executor.execute(mock_request_context, mock_event_queue)

    # Verify completed state was enqueued (not input_required)
    enqueued_events = [call[0][0] for call in mock_event_queue.enqueue_event.call_args_list]
    completed_events = [
        e for e in enqueued_events if isinstance(e, TaskStatusUpdateEvent) and e.status.state == TaskState.completed
    ]
    assert len(completed_events) == 1

    # Verify no input_required events
    input_required_events = [
        e
        for e in enqueued_events
        if isinstance(e, TaskStatusUpdateEvent) and e.status.state == TaskState.input_required
    ]
    assert len(input_required_events) == 0


@pytest.mark.asyncio
async def test_execute_setup_failure_raises_server_error(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test that setup failures (missing message) still raise ServerError."""
    executor = StrandsA2AExecutor(mock_strands_agent)

    mock_task = MagicMock()
    mock_task.id = "task-setup-fail"
    mock_task.context_id = "ctx-setup-fail"
    mock_request_context.current_task = mock_task

    # No message at all
    mock_request_context.message = None

    with pytest.raises(ServerError) as excinfo:
        await executor.execute(mock_request_context, mock_event_queue)

    assert isinstance(excinfo.value.error, InternalError)


@pytest.mark.asyncio
async def test_execute_error_when_task_already_terminal(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test that error during execution is handled gracefully when task is already in terminal state."""
    from a2a.types import TextPart

    # Make stream_async raise to trigger the error path
    mock_strands_agent.stream_async = MagicMock(side_effect=Exception("Agent error"))

    executor = StrandsA2AExecutor(mock_strands_agent)

    mock_task = MagicMock()
    mock_task.id = "task-already-done"
    mock_task.context_id = "ctx-already-done"
    mock_request_context.current_task = mock_task

    mock_text_part = MagicMock(spec=TextPart)
    mock_text_part.text = "test"
    mock_part = MagicMock()
    mock_part.root = mock_text_part
    mock_message = MagicMock()
    mock_message.parts = [mock_part]
    mock_request_context.message = mock_message

    # Patch TaskUpdater.failed to raise RuntimeError (simulating task already in terminal state)
    with patch("strands.multiagent.a2a.executor.TaskUpdater") as MockTaskUpdater:
        mock_updater = MagicMock()
        mock_updater.failed = AsyncMock(side_effect=RuntimeError("Task is already in a terminal state"))
        mock_updater.new_agent_message = MagicMock(return_value=MagicMock())
        MockTaskUpdater.return_value = mock_updater

        # Should NOT raise - handles RuntimeError gracefully
        await executor.execute(mock_request_context, mock_event_queue)

        # Verify failed() was attempted
        mock_updater.failed.assert_called_once()


@pytest.mark.asyncio
async def test_cancel_calls_agent_cancel_method(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test that cancel() attempts to call agent.cancel() if available."""
    from a2a.types import TaskState, TaskStatusUpdateEvent

    # Give the agent a cancel method
    mock_strands_agent.cancel = MagicMock()

    executor = StrandsA2AExecutor(mock_strands_agent)

    mock_task = MagicMock()
    mock_task.id = "task-cancel-agent"
    mock_task.context_id = "ctx-cancel-agent"
    mock_request_context.current_task = mock_task

    await executor.cancel(mock_request_context, mock_event_queue)

    # Verify agent.cancel() was called
    mock_strands_agent.cancel.assert_called_once()

    # Verify task state is canceled
    enqueued_events = [call[0][0] for call in mock_event_queue.enqueue_event.call_args_list]
    canceled_events = [
        e for e in enqueued_events if isinstance(e, TaskStatusUpdateEvent) and e.status.state == TaskState.canceled
    ]
    assert len(canceled_events) == 1


@pytest.mark.asyncio
async def test_cancel_handles_agent_cancel_exception(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test that cancel() gracefully handles agent.cancel() raising an exception."""
    from a2a.types import TaskState, TaskStatusUpdateEvent

    # Give the agent a cancel method that raises
    mock_strands_agent.cancel = MagicMock(side_effect=RuntimeError("Cannot cancel"))

    executor = StrandsA2AExecutor(mock_strands_agent)

    mock_task = MagicMock()
    mock_task.id = "task-cancel-err"
    mock_task.context_id = "ctx-cancel-err"
    mock_request_context.current_task = mock_task

    # Should still succeed (agent cancel is best-effort)
    await executor.cancel(mock_request_context, mock_event_queue)

    # Task should still be transitioned to canceled
    enqueued_events = [call[0][0] for call in mock_event_queue.enqueue_event.call_args_list]
    canceled_events = [
        e for e in enqueued_events if isinstance(e, TaskStatusUpdateEvent) and e.status.state == TaskState.canceled
    ]
    assert len(canceled_events) == 1


@pytest.mark.asyncio
async def test_cancel_raises_when_task_already_terminal(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test that cancel() raises ServerError when task is already in a terminal state."""
    executor = StrandsA2AExecutor(mock_strands_agent)

    mock_task = MagicMock()
    mock_task.id = "task-terminal"
    mock_task.context_id = "ctx-terminal"
    mock_request_context.current_task = mock_task

    # Patch TaskUpdater.cancel to raise RuntimeError (task already completed/failed)
    with patch("strands.multiagent.a2a.executor.TaskUpdater") as MockTaskUpdater:
        mock_updater = MagicMock()
        mock_updater.cancel = AsyncMock(side_effect=RuntimeError("Task is already in a terminal state"))
        mock_updater.new_agent_message = MagicMock(return_value=MagicMock())
        MockTaskUpdater.return_value = mock_updater

        with pytest.raises(ServerError) as excinfo:
            await executor.cancel(mock_request_context, mock_event_queue)

        assert isinstance(excinfo.value.error, UnsupportedOperationError)
        mock_updater.cancel.assert_called_once()


# =========================================================================
# DEVIL'S ADVOCATE FINDINGS — Tests addressing review gaps
# =========================================================================


@pytest.mark.asyncio
async def test_execute_handles_asyncio_cancelled_error(mock_strands_agent, mock_request_context, mock_event_queue):
    """Critical Finding 1: asyncio.CancelledError transitions task to canceled state.

    asyncio.CancelledError is a BaseException (not Exception). It's raised when an asyncio
    task is cancelled — e.g., HTTP client disconnect, server shutdown, task group cancellation.
    Without explicit handling, the task would remain stuck in 'working' state forever (zombie).

    This test verifies the task transitions to 'canceled' before re-raising CancelledError.
    """
    import asyncio

    from a2a.types import TaskState, TaskStatusUpdateEvent, TextPart

    async def mock_stream(content_blocks, **kwargs):
        """Mock streaming that gets cancelled mid-stream."""
        yield {"data": "partial output"}
        raise asyncio.CancelledError()

    mock_strands_agent.stream_async = MagicMock(side_effect=mock_stream)

    executor = StrandsA2AExecutor(mock_strands_agent)

    mock_task = MagicMock()
    mock_task.id = "task-cancelled"
    mock_task.context_id = "ctx-cancelled"
    mock_request_context.current_task = mock_task

    mock_text_part = MagicMock(spec=TextPart)
    mock_text_part.text = "test"
    mock_part = MagicMock()
    mock_part.root = mock_text_part
    mock_message = MagicMock()
    mock_message.parts = [mock_part]
    mock_request_context.message = mock_message

    # CancelledError should be re-raised (framework needs to know task was cancelled)
    with pytest.raises(asyncio.CancelledError):
        await executor.execute(mock_request_context, mock_event_queue)

    # But BEFORE re-raising, the task should have been transitioned to canceled
    enqueued_events = [call[0][0] for call in mock_event_queue.enqueue_event.call_args_list]
    canceled_events = [
        e for e in enqueued_events if isinstance(e, TaskStatusUpdateEvent) and e.status.state == TaskState.canceled
    ]
    assert len(canceled_events) == 1
    assert (
        "cancelled" in canceled_events[0].status.message.parts[0].root.text.lower()
        or "connection termination" in canceled_events[0].status.message.parts[0].root.text.lower()
    )


@pytest.mark.asyncio
async def test_execute_asyncio_cancelled_when_task_already_terminal(
    mock_strands_agent, mock_request_context, mock_event_queue
):
    """Test CancelledError handling when task is already in a terminal state.

    If the task completed right before the cancellation arrives, the updater.cancel()
    will raise RuntimeError. We should handle this gracefully and still re-raise CancelledError.
    """
    import asyncio

    from a2a.types import TextPart

    async def mock_stream(content_blocks, **kwargs):
        """Async generator that immediately raises CancelledError."""
        yield {"data": "partial"}  # Must yield to be async generator
        raise asyncio.CancelledError()

    mock_strands_agent.stream_async = MagicMock(side_effect=mock_stream)

    executor = StrandsA2AExecutor(mock_strands_agent)

    mock_task = MagicMock()
    mock_task.id = "task-cancelled-terminal"
    mock_task.context_id = "ctx-cancelled-terminal"
    mock_request_context.current_task = mock_task

    mock_text_part = MagicMock(spec=TextPart)
    mock_text_part.text = "test"
    mock_part = MagicMock()
    mock_part.root = mock_text_part
    mock_message = MagicMock()
    mock_message.parts = [mock_part]
    mock_request_context.message = mock_message

    # Patch TaskUpdater to simulate task already in terminal state
    with patch("strands.multiagent.a2a.executor.TaskUpdater") as MockTaskUpdater:
        mock_updater = MagicMock()
        mock_updater.cancel = AsyncMock(side_effect=RuntimeError("Task is already in a terminal state"))
        mock_updater.update_status = AsyncMock()
        mock_updater.add_artifact = AsyncMock()
        mock_updater.new_agent_message = MagicMock(return_value=MagicMock())
        mock_updater.context_id = "ctx-cancelled-terminal"
        mock_updater.task_id = "task-cancelled-terminal"
        MockTaskUpdater.return_value = mock_updater

        # Should still re-raise CancelledError
        with pytest.raises(asyncio.CancelledError):
            await executor.execute(mock_request_context, mock_event_queue)

        # cancel() was attempted
        mock_updater.cancel.assert_called_once()


@pytest.mark.asyncio
async def test_execute_with_interrupt_empty_list_transitions_to_input_required(
    mock_strands_agent, mock_request_context, mock_event_queue
):
    """Critical Finding 2: stop_reason='interrupt' with empty interrupts list.

    The agent explicitly signaled it needs input (stop_reason="interrupt") but provided
    no interrupt details. This should STILL transition to input_required — the stop_reason
    is the authoritative signal. Previously this would silently complete the task.
    """
    from a2a.types import TaskState, TaskStatusUpdateEvent, TextPart

    mock_result = MagicMock(spec=SAAgentResult)
    mock_result.stop_reason = "interrupt"
    mock_result.interrupts = []  # Empty list — previously this was falsy and caused completion!

    async def mock_stream(content_blocks, **kwargs):
        yield {"result": mock_result}

    mock_strands_agent.stream_async = MagicMock(side_effect=mock_stream)

    executor = StrandsA2AExecutor(mock_strands_agent)

    mock_task = MagicMock()
    mock_task.id = "task-empty-interrupts"
    mock_task.context_id = "ctx-empty-interrupts"
    mock_request_context.current_task = mock_task

    mock_text_part = MagicMock(spec=TextPart)
    mock_text_part.text = "do something"
    mock_part = MagicMock()
    mock_part.root = mock_text_part
    mock_message = MagicMock()
    mock_message.parts = [mock_part]
    mock_request_context.message = mock_message

    await executor.execute(mock_request_context, mock_event_queue)

    # Should transition to input_required, NOT completed
    enqueued_events = [call[0][0] for call in mock_event_queue.enqueue_event.call_args_list]
    input_required_events = [
        e
        for e in enqueued_events
        if isinstance(e, TaskStatusUpdateEvent) and e.status.state == TaskState.input_required
    ]
    completed_events = [
        e for e in enqueued_events if isinstance(e, TaskStatusUpdateEvent) and e.status.state == TaskState.completed
    ]

    assert len(input_required_events) == 1, "Empty interrupts list should still trigger input_required"
    assert len(completed_events) == 0, "Should NOT complete when stop_reason='interrupt'"
    # Verify the fallback message is used
    assert "additional input" in input_required_events[0].status.message.parts[0].root.text.lower()


@pytest.mark.asyncio
async def test_execute_with_interrupt_none_list_transitions_to_input_required(
    mock_strands_agent, mock_request_context, mock_event_queue
):
    """Edge case: stop_reason='interrupt' with interrupts=None.

    Same logic — the stop_reason is authoritative. None interrupts should
    still result in input_required transition.
    """
    from a2a.types import TaskState, TaskStatusUpdateEvent, TextPart

    mock_result = MagicMock(spec=SAAgentResult)
    mock_result.stop_reason = "interrupt"
    mock_result.interrupts = None  # None, not empty list

    async def mock_stream(content_blocks, **kwargs):
        yield {"result": mock_result}

    mock_strands_agent.stream_async = MagicMock(side_effect=mock_stream)

    executor = StrandsA2AExecutor(mock_strands_agent)

    mock_task = MagicMock()
    mock_task.id = "task-none-interrupts"
    mock_task.context_id = "ctx-none-interrupts"
    mock_request_context.current_task = mock_task

    mock_text_part = MagicMock(spec=TextPart)
    mock_text_part.text = "do something"
    mock_part = MagicMock()
    mock_part.root = mock_text_part
    mock_message = MagicMock()
    mock_message.parts = [mock_part]
    mock_request_context.message = mock_message

    await executor.execute(mock_request_context, mock_event_queue)

    enqueued_events = [call[0][0] for call in mock_event_queue.enqueue_event.call_args_list]
    input_required_events = [
        e
        for e in enqueued_events
        if isinstance(e, TaskStatusUpdateEvent) and e.status.state == TaskState.input_required
    ]
    assert len(input_required_events) == 1


@pytest.mark.asyncio
async def test_cancel_without_hasattr_cancel(mock_strands_agent, mock_request_context, mock_event_queue):
    """Test cancel works when agent doesn't have cancel() method (AttributeError)."""
    from a2a.types import TaskState, TaskStatusUpdateEvent

    # Remove cancel method entirely
    del mock_strands_agent.cancel

    executor = StrandsA2AExecutor(mock_strands_agent)

    mock_task = MagicMock()
    mock_task.id = "task-no-cancel-method"
    mock_task.context_id = "ctx-no-cancel-method"
    mock_request_context.current_task = mock_task

    # Should succeed — AttributeError from agent.cancel() is caught
    await executor.cancel(mock_request_context, mock_event_queue)

    # Task should still be transitioned to canceled
    enqueued_events = [call[0][0] for call in mock_event_queue.enqueue_event.call_args_list]
    canceled_events = [
        e for e in enqueued_events if isinstance(e, TaskStatusUpdateEvent) and e.status.state == TaskState.canceled
    ]
    assert len(canceled_events) == 1


# =========================================================================
# NEW TESTS: Per-context conversation isolation
#
# These tests drive a REAL Agent (with a deterministic stub model) through a
# single executor across two distinct A2A context_ids, asserting that no
# conversation state (messages OR agent state) leaks between contexts, while
# a single context still accumulates its own history across turns.
# =========================================================================


def _make_stub_agent(stream_fn=None, *, messages=None):
    """Build a real Agent backed by a deterministic, network-free stub model.

    Args:
        stream_fn: Callable ``(messages) -> str`` producing the assistant reply text. Defaults
            to an echo of the latest user text prefixed with ``ECHO[<history-length>]``.
        messages: Optional seeded conversation history for the template agent.
    """
    from collections.abc import AsyncGenerator

    from strands.agent.agent import Agent
    from strands.models import Model

    def _default_reply(msgs):
        last_user_text = ""
        for message in reversed(msgs):
            if message.get("role") == "user":
                last_user_text = next((b["text"] for b in message.get("content", []) if "text" in b), "")
                break
        return f"ECHO[{len(msgs)}]: {last_user_text}"

    reply_fn = stream_fn or _default_reply

    class _StubModel(Model):
        def get_config(self):
            return {}

        def update_config(self, **model_config):
            pass

        def format_request(self, messages, tool_specs=None, system_prompt=None):
            return None

        def format_chunk(self, event):
            return event

        async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
            yield {}

        async def stream(
            self, messages, tool_specs=None, system_prompt=None, tool_choice=None, **kwargs
        ) -> "AsyncGenerator":
            yield {"messageStart": {"role": "assistant"}}
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockDelta": {"delta": {"text": reply_fn(messages)}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}

    return Agent(model=_StubModel(), name="Stub", description="Stub agent", messages=messages)


def _make_request_context(context_id: str, message_id: str, text: str):
    """Build a RequestContext-like object the executor can consume."""
    from a2a.types import TextPart

    text_part = MagicMock(spec=TextPart)
    text_part.text = text
    part = MagicMock()
    part.root = text_part

    message = MagicMock()
    message.parts = [part]

    task = MagicMock()
    task.id = f"task-{message_id}"
    task.context_id = context_id

    context = MagicMock()
    context.context_id = context_id
    context.current_task = task
    context.message = message
    context.metadata = {}
    return context


def _artifact_texts(mock_event_queue):
    """Extract artifact text strings enqueued during an execution."""
    from a2a.types import TaskArtifactUpdateEvent

    texts = []
    for call in mock_event_queue.enqueue_event.call_args_list:
        event = call[0][0]
        if isinstance(event, TaskArtifactUpdateEvent):
            for part in event.artifact.parts:
                if hasattr(part.root, "text"):
                    texts.append(part.root.text)
    return texts


@pytest.mark.asyncio
async def test_single_agent_isolates_and_continues_per_context(mock_event_queue):
    """Single-agent (snapshot) mode isolates history across contexts and continues within one."""
    agent = _make_stub_agent()
    executor = StrandsA2AExecutor(agent)

    # ctx-A turn 1: empty history -> ECHO[1], carrying a secret marker.
    await executor.execute(_make_request_context("ctx-A", "a-1", "SECRET-AAAA"), mock_event_queue)
    assert any("ECHO[1]:" in t and "SECRET-AAAA" in t for t in _artifact_texts(mock_event_queue))

    # ctx-A turn 2: sees its own prior turns -> ECHO[3] (continuity).
    mock_event_queue.enqueue_event.reset_mock()
    await executor.execute(_make_request_context("ctx-A", "a-2", "again"), mock_event_queue)
    assert any("ECHO[3]:" in t for t in _artifact_texts(mock_event_queue))

    # ctx-B: a different context starts fresh -> ECHO[1], never sees ctx-A's secret.
    mock_event_queue.enqueue_event.reset_mock()
    await executor.execute(_make_request_context("ctx-B", "b-1", "what did prev say"), mock_event_queue)
    texts_b = _artifact_texts(mock_event_queue)
    assert any("ECHO[1]:" in t for t in texts_b)
    assert not any("SECRET-AAAA" in t for t in texts_b)

    # The shared agent is reset to the clean template between requests.
    assert agent.messages == []


@pytest.mark.asyncio
async def test_single_agent_evicts_least_recently_used_context(mock_event_queue):
    """Single-agent mode evicts the LRU context's snapshot beyond max_contexts."""
    agent = _make_stub_agent()
    executor = StrandsA2AExecutor(agent, max_contexts=2)

    await executor.execute(_make_request_context("ctx-A", "a-1", "hi"), mock_event_queue)
    await executor.execute(_make_request_context("ctx-B", "b-1", "hi"), mock_event_queue)
    await executor.execute(_make_request_context("ctx-A", "a-2", "again"), mock_event_queue)  # touch A
    await executor.execute(_make_request_context("ctx-C", "c-1", "hi"), mock_event_queue)  # evicts B

    assert set(executor._snapshots.keys()) == {"ctx-A", "ctx-C"}


def test_max_contexts_must_be_positive(mock_strands_agent):
    """max_contexts below 1 is rejected to keep the eviction bound meaningful."""
    with pytest.raises(ValueError, match="max_contexts must be >= 1"):
        StrandsA2AExecutor(mock_strands_agent, max_contexts=0)


@pytest.mark.asyncio
async def test_execute_raises_when_context_id_missing(mock_strands_agent, mock_event_queue):
    """A request with no context_id is rejected (the framework always populates one)."""
    executor = StrandsA2AExecutor(mock_strands_agent)
    context = _make_request_context("ignored", "m-1", "hello")
    context.context_id = None  # simulate the should-never-happen absent id

    with pytest.raises(ServerError) as excinfo:
        await executor.execute(context, mock_event_queue)
    assert isinstance(excinfo.value.error, InternalError)


@pytest.mark.asyncio
async def test_single_agent_preserves_seeded_history(mock_event_queue):
    """Seeded history (Agent(messages=[...])) is present when the single agent is invoked."""
    seeded = [{"role": "user", "content": [{"text": "SEED"}]}]
    agent = _make_stub_agent(stream_fn=lambda msgs: f"LEN[{len(msgs)}]", messages=seeded)
    executor = StrandsA2AExecutor(agent)

    await executor.execute(_make_request_context("ctx-A", "a-1", "hello"), mock_event_queue)
    texts = _artifact_texts(mock_event_queue)
    # Seed (1) + new user message (1) = 2 messages present when the model is first called.
    assert any("LEN[2]" in t for t in texts)


# =========================================================================
# NEW TESTS: Agent-factory mode (recommended) and constructor validation
# =========================================================================


def test_requires_exactly_one_of_agent_or_factory(mock_strands_agent):
    """Neither or both of agent/agent_factory is a configuration error."""
    with pytest.raises(ValueError, match="exactly one of 'agent' or 'agent_factory'"):
        StrandsA2AExecutor()
    with pytest.raises(ValueError, match="exactly one of 'agent' or 'agent_factory'"):
        StrandsA2AExecutor(mock_strands_agent, agent_factory=lambda cid: mock_strands_agent)


def test_single_agent_with_session_manager_rejected():
    """A single agent with a session_manager would interleave sessions, so it is rejected."""
    from strands.session.session_manager import SessionManager

    agent = _make_stub_agent()
    agent._session_manager = MagicMock(spec=SessionManager)
    with pytest.raises(ValueError, match="session_manager is not supported"):
        StrandsA2AExecutor(agent)


@pytest.mark.asyncio
async def test_factory_builds_one_agent_per_context(mock_event_queue):
    """Factory mode builds a dedicated agent per context_id and reuses it within a context."""
    built: list[str] = []

    def factory(context_id: str):
        built.append(context_id)
        return _make_stub_agent()

    executor = StrandsA2AExecutor(agent_factory=factory)

    await executor.execute(_make_request_context("ctx-A", "a-1", "first"), mock_event_queue)
    await executor.execute(_make_request_context("ctx-A", "a-2", "second"), mock_event_queue)
    await executor.execute(_make_request_context("ctx-B", "b-1", "first"), mock_event_queue)

    # Factory invoked once per distinct context, not per request.
    assert built == ["ctx-A", "ctx-B"]
    # Distinct Agent instances per context.
    assert executor._contexts["ctx-A"].agent is not executor._contexts["ctx-B"].agent


@pytest.mark.asyncio
async def test_factory_isolates_and_continues_per_context(mock_event_queue):
    """Factory mode isolates history across contexts and continues it within one."""
    executor = StrandsA2AExecutor(agent_factory=lambda cid: _make_stub_agent())

    # ctx-A two turns -> its own history continues (ECHO[1] then ECHO[3]).
    await executor.execute(_make_request_context("ctx-A", "a-1", "SECRET-AAAA"), mock_event_queue)
    assert any("ECHO[1]:" in t and "SECRET-AAAA" in t for t in _artifact_texts(mock_event_queue))

    mock_event_queue.enqueue_event.reset_mock()
    await executor.execute(_make_request_context("ctx-A", "a-2", "again"), mock_event_queue)
    assert any("ECHO[3]:" in t for t in _artifact_texts(mock_event_queue))

    # ctx-B is independent -> starts fresh, never sees ctx-A's secret.
    mock_event_queue.enqueue_event.reset_mock()
    await executor.execute(_make_request_context("ctx-B", "b-1", "hello"), mock_event_queue)
    texts_b = _artifact_texts(mock_event_queue)
    assert any("ECHO[1]:" in t for t in texts_b)
    assert not any("SECRET-AAAA" in t for t in texts_b)


@pytest.mark.asyncio
async def test_factory_mode_evicts_least_recently_used_context(mock_event_queue):
    """Factory mode evicts the LRU context's agent and lock beyond max_contexts."""
    executor = StrandsA2AExecutor(agent_factory=lambda cid: _make_stub_agent(), max_contexts=2)

    await executor.execute(_make_request_context("ctx-A", "a-1", "hi"), mock_event_queue)
    await executor.execute(_make_request_context("ctx-B", "b-1", "hi"), mock_event_queue)
    await executor.execute(_make_request_context("ctx-A", "a-2", "again"), mock_event_queue)  # touch A
    await executor.execute(_make_request_context("ctx-C", "c-1", "hi"), mock_event_queue)  # evicts B

    assert set(executor._contexts.keys()) == {"ctx-A", "ctx-C"}


@pytest.mark.asyncio
async def test_concurrent_compliant_streaming_uses_distinct_artifact_ids():
    """Concurrent A2A-compliant streams in different contexts must not share artifact state.

    Streaming state is per-invocation, so two requests running concurrently each emit their own
    artifact_id. Were it stored on the executor, the streams would corrupt each other.
    """
    import asyncio

    from a2a.types import TaskArtifactUpdateEvent

    # Stub model that yields a data chunk then a result, with an await between requests' steps
    # so the two invocations genuinely interleave.
    def slow_factory(context_id):
        from collections.abc import AsyncGenerator

        from strands.agent.agent import Agent
        from strands.models import Model

        class _SlowModel(Model):
            def get_config(self):
                return {}

            def update_config(self, **k):
                pass

            def format_request(self, m, tool_specs=None, system_prompt=None):
                return None

            def format_chunk(self, e):
                return e

            async def structured_output(self, om, p, system_prompt=None, **k):
                yield {}

            async def stream(
                self, messages, tool_specs=None, system_prompt=None, tool_choice=None, **k
            ) -> "AsyncGenerator":
                yield {"messageStart": {"role": "assistant"}}
                yield {"contentBlockStart": {"start": {}}}
                await asyncio.sleep(0.01)  # force interleaving with the other request
                yield {"contentBlockDelta": {"delta": {"text": f"chunk-{context_id}"}}}
                yield {"contentBlockStop": {}}
                yield {"messageStop": {"stopReason": "end_turn"}}

        return Agent(model=_SlowModel(), name="s", description="d")

    executor = StrandsA2AExecutor(agent_factory=slow_factory, enable_a2a_compliant_streaming=True)

    def make_queue():
        events: list = []

        async def enqueue(e):
            events.append(e)

        q = MagicMock()
        q.enqueue_event = enqueue
        return q, events

    qa, events_a = make_queue()
    qb, events_b = make_queue()

    # Run both contexts concurrently.
    await asyncio.gather(
        executor.execute(_make_request_context("ctx-A", "a-1", "hi"), qa),
        executor.execute(_make_request_context("ctx-B", "b-1", "hi"), qb),
    )

    def artifact_ids(events):
        return {e.artifact.artifact_id for e in events if isinstance(e, TaskArtifactUpdateEvent)}

    ids_a = artifact_ids(events_a)
    ids_b = artifact_ids(events_b)

    # Each request used exactly one artifact id, and the two requests' ids are disjoint.
    assert len(ids_a) == 1 and len(ids_b) == 1
    assert ids_a.isdisjoint(ids_b)


# ── Inbound interrupt responses ──────────────────────────────────────────────
#
# Regression coverage for https://github.com/strands-agents/harness-sdk/issues/2948: a client
# resumes a task parked in `input_required` by sending a DataPart shaped like
# InterruptResponseContent. These tests guarantee such a part reaches the agent as an interrupt
# response rather than being flattened into a text block, and that a response the executor cannot
# bind to a parked interrupt is rejected before the agent runs.


def _interrupt_response_part(interrupt_id, response):
    """Build an A2A DataPart carrying an interrupt response for the given id."""
    data_part = MagicMock(spec=DataPart)
    data_part.data = {"interruptResponse": {"interruptId": interrupt_id, "response": response}}
    part = MagicMock()
    part.root = data_part
    return part


def _data_part(data):
    """Build an A2A DataPart carrying arbitrary structured data."""
    data_part = MagicMock(spec=DataPart)
    data_part.data = data
    part = MagicMock()
    part.root = data_part
    return part


def _text_part(text):
    """Build an A2A TextPart."""
    text_part = MagicMock(spec=TextPart)
    text_part.text = text
    part = MagicMock()
    part.root = text_part
    return part


def _park_interrupt(agent, *interrupt_ids):
    """Put the agent into an interrupt state holding the given parked interrupt ids."""
    from strands.interrupt import Interrupt, _InterruptState

    state = _InterruptState()
    state.interrupts = {id_: Interrupt(id=id_, name=f"name-{id_}") for id_ in interrupt_ids}
    state.activated = True
    agent._interrupt_state = state
    return state


def _request_with_parts(mock_request_context, parts, task_id="task-resume"):
    """Point a request context at a task carrying the given message parts."""
    task = MagicMock()
    task.id = task_id
    task.context_id = f"ctx-{task_id}"
    mock_request_context.current_task = task

    message = MagicMock()
    message.parts = parts
    mock_request_context.message = message
    return mock_request_context


@pytest.mark.asyncio
async def test_execute_interrupt_response_resumes_parked_interrupt(
    mock_strands_agent, mock_request_context, mock_event_queue
):
    """An interrupt-response DataPart reaches the agent as InterruptResponseContent, not text."""
    _park_interrupt(mock_strands_agent, "int-1")

    mock_result = MagicMock(spec=SAAgentResult)
    mock_result.stop_reason = "end_turn"
    mock_result.interrupts = None
    mock_result.__str__ = MagicMock(return_value="Campaign created")

    async def mock_stream(agent_input, **kwargs):
        yield {"result": mock_result}

    mock_strands_agent.stream_async = MagicMock(side_effect=mock_stream)
    executor = StrandsA2AExecutor(mock_strands_agent)

    _request_with_parts(mock_request_context, [_interrupt_response_part("int-1", {"approved": True})])
    await executor.execute(mock_request_context, mock_event_queue)

    tru_input = mock_strands_agent.stream_async.call_args[0][0]
    exp_input = [{"interruptResponse": {"interruptId": "int-1", "response": {"approved": True}}}]
    assert tru_input == exp_input


@pytest.mark.asyncio
async def test_execute_multiple_interrupt_responses_all_delivered(
    mock_strands_agent, mock_request_context, mock_event_queue
):
    """Distinct interrupt ids in one message are all forwarded to the agent."""
    _park_interrupt(mock_strands_agent, "int-1", "int-2")

    mock_result = MagicMock(spec=SAAgentResult)
    mock_result.stop_reason = "end_turn"
    mock_result.interrupts = None
    mock_result.__str__ = MagicMock(return_value="done")

    async def mock_stream(agent_input, **kwargs):
        yield {"result": mock_result}

    mock_strands_agent.stream_async = MagicMock(side_effect=mock_stream)
    executor = StrandsA2AExecutor(mock_strands_agent)

    _request_with_parts(
        mock_request_context,
        [_interrupt_response_part("int-1", "yes"), _interrupt_response_part("int-2", "no")],
    )
    await executor.execute(mock_request_context, mock_event_queue)

    tru_input = mock_strands_agent.stream_async.call_args[0][0]
    exp_input = [
        {"interruptResponse": {"interruptId": "int-1", "response": "yes"}},
        {"interruptResponse": {"interruptId": "int-2", "response": "no"}},
    ]
    assert tru_input == exp_input


@pytest.mark.asyncio
async def test_execute_null_interrupt_response_rejected(mock_strands_agent, mock_request_context, mock_event_queue):
    """A null answer leaves the interrupt unsatisfied, so it is refused instead of silently re-firing."""
    _park_interrupt(mock_strands_agent, "int-1")
    mock_strands_agent.stream_async = MagicMock()
    executor = StrandsA2AExecutor(mock_strands_agent)

    _request_with_parts(mock_request_context, [_interrupt_response_part("int-1", None)])

    with pytest.raises(ServerError) as exc_info:
        await executor.execute(mock_request_context, mock_event_queue)

    assert isinstance(exc_info.value.error, InvalidParamsError)
    mock_strands_agent.stream_async.assert_not_called()


@pytest.mark.asyncio
async def test_execute_falsy_interrupt_response_is_valid(mock_strands_agent, mock_request_context, mock_event_queue):
    """Only null is refused: False answers an interrupt just as well as True."""
    _park_interrupt(mock_strands_agent, "int-1")

    mock_result = MagicMock(spec=SAAgentResult)
    mock_result.stop_reason = "end_turn"
    mock_result.interrupts = None
    mock_result.__str__ = MagicMock(return_value="done")

    async def mock_stream(agent_input, **kwargs):
        yield {"result": mock_result}

    mock_strands_agent.stream_async = MagicMock(side_effect=mock_stream)
    executor = StrandsA2AExecutor(mock_strands_agent)

    _request_with_parts(mock_request_context, [_interrupt_response_part("int-1", False)])
    await executor.execute(mock_request_context, mock_event_queue)

    tru_input = mock_strands_agent.stream_async.call_args[0][0]
    exp_input = [{"interruptResponse": {"interruptId": "int-1", "response": False}}]
    assert tru_input == exp_input


@pytest.mark.asyncio
async def test_execute_interrupt_response_for_unknown_id_fails_closed(
    mock_strands_agent, mock_request_context, mock_event_queue
):
    """A response naming an interrupt the agent is not parked on never reaches the agent."""
    _park_interrupt(mock_strands_agent, "int-1")
    mock_strands_agent.stream_async = MagicMock()
    executor = StrandsA2AExecutor(mock_strands_agent)

    _request_with_parts(mock_request_context, [_interrupt_response_part("int-other", {"approved": True})])

    with pytest.raises(ServerError) as exc_info:
        await executor.execute(mock_request_context, mock_event_queue)

    assert isinstance(exc_info.value.error, InvalidParamsError)
    mock_strands_agent.stream_async.assert_not_called()


@pytest.mark.asyncio
async def test_execute_interrupt_response_when_not_parked_fails_closed(
    mock_strands_agent, mock_request_context, mock_event_queue
):
    """Interrupt responses sent to an agent holding no interrupt are rejected."""
    mock_strands_agent.stream_async = MagicMock()
    executor = StrandsA2AExecutor(mock_strands_agent)

    _request_with_parts(mock_request_context, [_interrupt_response_part("int-1", {"approved": True})])

    with pytest.raises(ServerError) as exc_info:
        await executor.execute(mock_request_context, mock_event_queue)

    assert isinstance(exc_info.value.error, InvalidParamsError)
    mock_strands_agent.stream_async.assert_not_called()


@pytest.mark.asyncio
async def test_execute_rejected_resume_leaves_interrupt_parked(
    mock_strands_agent, mock_request_context, mock_event_queue
):
    """Rejecting a resume must not clear the interrupt the agent is still waiting on."""
    state = _park_interrupt(mock_strands_agent, "int-1")
    mock_strands_agent.stream_async = MagicMock()
    executor = StrandsA2AExecutor(mock_strands_agent)

    _request_with_parts(mock_request_context, [_interrupt_response_part("int-other", "yes")])

    with pytest.raises(ServerError) as exc_info:
        await executor.execute(mock_request_context, mock_event_queue)

    assert isinstance(exc_info.value.error, InvalidParamsError)
    assert state.activated
    assert "int-1" in state.interrupts


@pytest.mark.asyncio
async def test_execute_duplicate_interrupt_responses_rejected(
    mock_strands_agent, mock_request_context, mock_event_queue
):
    """Two responses for one interrupt id are ambiguous and rejected rather than silently resolved."""
    _park_interrupt(mock_strands_agent, "int-1")
    mock_strands_agent.stream_async = MagicMock()
    executor = StrandsA2AExecutor(mock_strands_agent)

    _request_with_parts(
        mock_request_context,
        [_interrupt_response_part("int-1", {"approved": True}), _interrupt_response_part("int-1", {"approved": False})],
    )

    with pytest.raises(ServerError) as exc_info:
        await executor.execute(mock_request_context, mock_event_queue)

    assert isinstance(exc_info.value.error, InvalidParamsError)
    mock_strands_agent.stream_async.assert_not_called()


@pytest.mark.parametrize(
    "malformed",
    [
        {"interruptResponse": "not-an-object"},
        {"interruptResponse": {"response": "yes"}},
        {"interruptResponse": {"interruptId": "", "response": "yes"}},
        {"interruptResponse": {"interruptId": 42, "response": "yes"}},
        {"interruptResponse": {"interruptId": "int-1"}},
    ],
)
@pytest.mark.asyncio
async def test_execute_malformed_interrupt_response_rejected(
    malformed, mock_strands_agent, mock_request_context, mock_event_queue
):
    """Malformed interrupt responses fail before the agent is invoked."""
    _park_interrupt(mock_strands_agent, "int-1")
    mock_strands_agent.stream_async = MagicMock()
    executor = StrandsA2AExecutor(mock_strands_agent)

    _request_with_parts(mock_request_context, [_data_part(malformed)])

    with pytest.raises(ServerError) as exc_info:
        await executor.execute(mock_request_context, mock_event_queue)

    assert isinstance(exc_info.value.error, InvalidParamsError)
    mock_strands_agent.stream_async.assert_not_called()


@pytest.mark.asyncio
async def test_execute_interrupt_response_mixed_with_other_parts_rejected(
    mock_strands_agent, mock_request_context, mock_event_queue
):
    """Content alongside an interrupt response would be silently dropped, so the message is rejected."""
    _park_interrupt(mock_strands_agent, "int-1")
    mock_strands_agent.stream_async = MagicMock()
    executor = StrandsA2AExecutor(mock_strands_agent)

    _request_with_parts(
        mock_request_context,
        [_interrupt_response_part("int-1", {"approved": True}), _text_part("and also do something else")],
    )

    with pytest.raises(ServerError) as exc_info:
        await executor.execute(mock_request_context, mock_event_queue)

    assert isinstance(exc_info.value.error, InvalidParamsError)
    mock_strands_agent.stream_async.assert_not_called()


@pytest.mark.asyncio
async def test_execute_new_message_while_parked_fails_closed(
    mock_strands_agent, mock_request_context, mock_event_queue
):
    """A parked task does not accept a fresh conversational turn in place of a resume."""
    _park_interrupt(mock_strands_agent, "int-1")
    mock_strands_agent.stream_async = MagicMock()
    executor = StrandsA2AExecutor(mock_strands_agent)

    _request_with_parts(mock_request_context, [_text_part("never mind, do something else")])

    with pytest.raises(ServerError) as exc_info:
        await executor.execute(mock_request_context, mock_event_queue)

    assert isinstance(exc_info.value.error, InvalidParamsError)
    mock_strands_agent.stream_async.assert_not_called()


@pytest.mark.asyncio
async def test_execute_ordinary_data_part_still_converts_to_text(
    mock_strands_agent, mock_request_context, mock_event_queue
):
    """A DataPart without an interrupt response keeps the generic structured-data path."""
    mock_result = MagicMock(spec=SAAgentResult)
    mock_result.stop_reason = "end_turn"
    mock_result.interrupts = None
    mock_result.__str__ = MagicMock(return_value="ok")

    async def mock_stream(agent_input, **kwargs):
        yield {"result": mock_result}

    mock_strands_agent.stream_async = MagicMock(side_effect=mock_stream)
    executor = StrandsA2AExecutor(mock_strands_agent)

    _request_with_parts(mock_request_context, [_data_part({"campaign": "spring", "budget": 100})])
    await executor.execute(mock_request_context, mock_event_queue)

    tru_input = mock_strands_agent.stream_async.call_args[0][0]
    assert len(tru_input) == 1
    assert tru_input[0]["text"].startswith("[Structured Data]")
    assert "spring" in tru_input[0]["text"]


# ── Outbound interrupt advertisement ─────────────────────────────────────────
#
# An interrupt id is generated server-side, so a client can only answer an interrupt if the id
# reaches it. These tests guarantee the input_required status message carries the ids in a DataPart
# while keeping the human-readable TextPart clients already rely on.


def _input_required_message(mock_event_queue):
    """The status message from the single input_required event on the queue."""
    from a2a.types import TaskState, TaskStatusUpdateEvent

    events = [call[0][0] for call in mock_event_queue.enqueue_event.call_args_list]
    input_required = [
        e for e in events if isinstance(e, TaskStatusUpdateEvent) and e.status.state == TaskState.input_required
    ]
    assert len(input_required) == 1
    return input_required[0].status.message


async def _run_until_interrupt(executor, mock_strands_agent, mock_request_context, mock_event_queue, interrupts):
    """Drive one execution whose result carries the given interrupts."""
    mock_result = MagicMock(spec=SAAgentResult)
    mock_result.stop_reason = "interrupt"
    mock_result.interrupts = interrupts

    async def mock_stream(agent_input, **kwargs):
        yield {"result": mock_result}

    mock_strands_agent.stream_async = MagicMock(side_effect=mock_stream)
    _request_with_parts(mock_request_context, [_text_part("do the thing")], task_id="task-out")
    await executor.execute(mock_request_context, mock_event_queue)


@pytest.mark.asyncio
async def test_interrupt_advertises_ids_in_data_part(mock_strands_agent, mock_request_context, mock_event_queue):
    """The input_required message carries each interrupt's id so a client can answer it."""
    from strands.interrupt import Interrupt

    executor = StrandsA2AExecutor(mock_strands_agent)
    await _run_until_interrupt(
        executor,
        mock_strands_agent,
        mock_request_context,
        mock_event_queue,
        [Interrupt(id="v1:tool_call:tu-1:abc", name="approve_campaign", reason={"name": "spring"})],
    )

    data_parts = [p.root.data for p in _input_required_message(mock_event_queue).parts if isinstance(p.root, DataPart)]
    tru_data = data_parts
    exp_data = [
        {
            "interrupts": [
                {"interruptId": "v1:tool_call:tu-1:abc", "name": "approve_campaign", "reason": {"name": "spring"}}
            ]
        }
    ]
    assert tru_data == exp_data


@pytest.mark.asyncio
async def test_interrupt_keeps_human_readable_text_part(mock_strands_agent, mock_request_context, mock_event_queue):
    """The prose part clients already read stays first and unchanged."""
    from strands.interrupt import Interrupt

    executor = StrandsA2AExecutor(mock_strands_agent)
    await _run_until_interrupt(
        executor,
        mock_strands_agent,
        mock_request_context,
        mock_event_queue,
        [Interrupt(id="int-1", name="approval", reason="Need user approval")],
    )

    first_part = _input_required_message(mock_event_queue).parts[0].root
    assert isinstance(first_part, TextPart)
    assert "approval" in first_part.text
    assert "Need user approval" in first_part.text


@pytest.mark.asyncio
async def test_interrupt_advertises_every_pending_id(mock_strands_agent, mock_request_context, mock_event_queue):
    """Every interrupt the agent parked is addressable, not just the first."""
    from strands.interrupt import Interrupt

    executor = StrandsA2AExecutor(mock_strands_agent)
    await _run_until_interrupt(
        executor,
        mock_strands_agent,
        mock_request_context,
        mock_event_queue,
        [Interrupt(id="int-1", name="first"), Interrupt(id="int-2", name="second")],
    )

    data_parts = [p.root.data for p in _input_required_message(mock_event_queue).parts if isinstance(p.root, DataPart)]
    tru_ids = [entry["interruptId"] for entry in data_parts[0]["interrupts"]]
    exp_ids = ["int-1", "int-2"]
    assert tru_ids == exp_ids


@pytest.mark.asyncio
async def test_interrupt_reason_that_is_not_json_falls_back_to_text(
    mock_strands_agent, mock_request_context, mock_event_queue
):
    """A reason the transport cannot encode degrades to its string form rather than failing late."""
    from strands.interrupt import Interrupt

    class Unserializable:
        def __str__(self):
            return "<custom reason>"

    executor = StrandsA2AExecutor(mock_strands_agent)
    await _run_until_interrupt(
        executor,
        mock_strands_agent,
        mock_request_context,
        mock_event_queue,
        [Interrupt(id="int-1", name="approval", reason=Unserializable())],
    )

    data_parts = [p.root.data for p in _input_required_message(mock_event_queue).parts if isinstance(p.root, DataPart)]
    tru_reason = data_parts[0]["interrupts"][0]["reason"]
    exp_reason = "<custom reason>"
    assert tru_reason == exp_reason


@pytest.mark.asyncio
async def test_interrupt_without_details_sends_no_data_part(mock_strands_agent, mock_request_context, mock_event_queue):
    """stop_reason='interrupt' with no interrupts still parks the task, with nothing to advertise."""
    executor = StrandsA2AExecutor(mock_strands_agent)
    await _run_until_interrupt(executor, mock_strands_agent, mock_request_context, mock_event_queue, [])

    parts = _input_required_message(mock_event_queue).parts
    assert not [p for p in parts if isinstance(p.root, DataPart)]
    assert isinstance(parts[0].root, TextPart)
