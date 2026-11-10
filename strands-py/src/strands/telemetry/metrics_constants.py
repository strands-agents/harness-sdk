"""Metrics that are emitted in Strands-Agents."""

STRANDS_EVENT_LOOP_CYCLE_COUNT = "strands.event_loop.cycle_count"
STRANDS_EVENT_LOOP_START_CYCLE = "strands.event_loop.start_cycle"
STRANDS_EVENT_LOOP_END_CYCLE = "strands.event_loop.end_cycle"
STRANDS_TOOL_CALL_COUNT = "strands.tool.call_count"
STRANDS_TOOL_SUCCESS_COUNT = "strands.tool.success_count"
STRANDS_TOOL_ERROR_COUNT = "strands.tool.error_count"

# Histograms
STRANDS_EVENT_LOOP_LATENCY = "strands.event_loop.latency"
STRANDS_TOOL_DURATION = "strands.tool.duration"
STRANDS_EVENT_LOOP_CYCLE_DURATION = "strands.event_loop.cycle_duration"
STRANDS_EVENT_LOOP_INPUT_TOKENS = "strands.event_loop.input.tokens"
STRANDS_EVENT_LOOP_OUTPUT_TOKENS = "strands.event_loop.output.tokens"
STRANDS_EVENT_LOOP_CACHE_READ_INPUT_TOKENS = "strands.event_loop.cache_read.input.tokens"
STRANDS_EVENT_LOOP_CACHE_WRITE_INPUT_TOKENS = "strands.event_loop.cache_write.input.tokens"
STRANDS_MODEL_TIME_TO_FIRST_TOKEN = "strands.model.time_to_first_token"
