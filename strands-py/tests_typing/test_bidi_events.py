from typing_extensions import assert_type

from strands.experimental.bidi import BidiOutputEvent, BidiToolUsesCompleteEvent
from strands.experimental.bidi.types import BidiToolUsesCompleteEvent as TypesBidiToolUsesCompleteEvent
from strands.types.content import Message


def completed_tool_uses_are_output_events(message: Message) -> None:
    event = BidiToolUsesCompleteEvent(message)
    output_event: BidiOutputEvent = event

    assert_type(event, BidiToolUsesCompleteEvent)
    assert_type(output_event, BidiOutputEvent)
    assert_type(TypesBidiToolUsesCompleteEvent(message), BidiToolUsesCompleteEvent)
