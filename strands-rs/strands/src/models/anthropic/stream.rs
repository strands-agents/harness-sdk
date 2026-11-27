//! Turning Messages API stream events into SDK stream events, and accumulating the response message.

use std::collections::{HashMap, HashSet};

use crate::models::streaming::{
    CitationsDelta, ModelContentBlockDeltaEvent, ModelContentBlockStartEvent, ModelContentBlockStopEvent,
    ModelMessageStartEvent, ModelStreamEvent, ReasoningContentDelta, TextDelta, ToolUseInputDelta, ToolUseStart, Usage,
};
use crate::types::media::base64_bytes;
use crate::types::{
    Citation, CitationLocation, CitationSourceContent, DocumentCharLocation, DocumentChunkLocation,
    DocumentPageLocation, JsonObject, JsonValue, Role, SearchResultLocation, StopReason, WebLocation,
};

/// Content blocks for tools Anthropic runs server side. They have no tool use or tool result
/// equivalent (the agent never runs them), so they are not streamed.
const SERVER_TOOL_BLOCK_TYPES: [&str; 10] = [
    "bash_code_execution_tool_result",
    "code_execution_tool_result",
    "container_upload",
    "mcp_tool_result",
    "mcp_tool_use",
    "server_tool_use",
    "text_editor_code_execution_tool_result",
    "tool_search_tool_result",
    "web_fetch_tool_result",
    "web_search_tool_result",
];

/// Block types whose input arrives as `input_json_delta` events.
const TOOL_INPUT_BLOCK_TYPES: [&str; 3] = ["tool_use", "server_tool_use", "mcp_tool_use"];

fn str_field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a str> {
    value.get(key).and_then(JsonValue::as_str)
}

fn index_of(event: &JsonValue) -> u64 {
    event.get("index").and_then(JsonValue::as_u64).unwrap_or_default()
}

fn number(value: &JsonValue) -> Option<u64> {
    value.as_u64().or_else(|| value.as_f64().map(|number| number as u64))
}

/// The four token counters of an Anthropic usage payload, as far as it reported them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct UsageCounters {
    pub(super) input_tokens: Option<u64>,
    pub(super) output_tokens: Option<u64>,
    pub(super) cache_read_input_tokens: Option<u64>,
    pub(super) cache_creation_input_tokens: Option<u64>,
}

impl UsageCounters {
    /// Copies the numeric counters of `usage`; `null` and absent ones keep the current value.
    pub(super) fn merge(&mut self, usage: &JsonValue) {
        let read = |key: &str| usage.get(key).and_then(number);
        self.input_tokens = read("input_tokens").or(self.input_tokens);
        self.output_tokens = read("output_tokens").or(self.output_tokens);
        self.cache_read_input_tokens = read("cache_read_input_tokens").or(self.cache_read_input_tokens);
        self.cache_creation_input_tokens = read("cache_creation_input_tokens").or(self.cache_creation_input_tokens);
    }

    pub(super) fn from_json(usage: &JsonValue) -> Self {
        let mut counters = Self::default();
        counters.merge(usage);
        counters
    }
}

/// Converts Anthropic usage to SDK usage. Anthropic's `input_tokens` excludes tokens read from or
/// written to the cache, so the billed total is the sum of all four counters.
pub(super) fn format_usage(usage: UsageCounters) -> Usage {
    let input = usage.input_tokens.unwrap_or_default();
    let output = usage.output_tokens.unwrap_or_default();
    let read = usage.cache_read_input_tokens.unwrap_or_default();
    let write = usage.cache_creation_input_tokens.unwrap_or_default();
    let mut formatted = Usage::new(input, output, input + output + read + write);
    if read > 0 {
        formatted = formatted.with_cache_read_input_tokens(read);
    }
    if write > 0 {
        formatted = formatted.with_cache_write_input_tokens(write);
    }
    formatted
}

/// The usage a stream reports: the summed counters of every response of the turn, with a cache
/// counter whenever a response reported it.
pub(super) fn stream_usage(total: UsageCounters) -> Usage {
    let input = total.input_tokens.unwrap_or_default();
    let output = total.output_tokens.unwrap_or_default();
    let read = total.cache_read_input_tokens.unwrap_or_default();
    let write = total.cache_creation_input_tokens.unwrap_or_default();
    let mut usage = Usage::new(input, output, input + output + read + write);
    if let Some(read) = total.cache_read_input_tokens {
        usage = usage.with_cache_read_input_tokens(read);
    }
    if let Some(write) = total.cache_creation_input_tokens {
        usage = usage.with_cache_write_input_tokens(write);
    }
    usage
}

/// Converts a compaction response's usage, which counts its tokens per iteration and zero at the
/// top level.
pub(super) fn format_compaction_usage(usage: &JsonValue) -> Usage {
    let iterations = usage.get("iterations").and_then(JsonValue::as_array);
    let Some(iterations) = iterations.filter(|iterations| !iterations.is_empty()) else {
        return format_usage(UsageCounters::from_json(usage));
    };
    let sum = |key: &str| {
        Some(
            iterations
                .iter()
                .filter_map(|iteration| iteration.get(key).and_then(number))
                .sum(),
        )
    };
    format_usage(UsageCounters {
        input_tokens: sum("input_tokens"),
        output_tokens: sum("output_tokens"),
        cache_read_input_tokens: sum("cache_read_input_tokens"),
        cache_creation_input_tokens: sum("cache_creation_input_tokens"),
    })
}

/// The response message accumulated from its events, as the SDK's `MessageStream` builds the
/// final message.
#[derive(Debug, Clone, Default)]
pub(super) struct MessageAccumulator {
    content: Vec<JsonValue>,
    tool_input: HashMap<usize, String>,
    stop_reason: Option<JsonValue>,
    usage: JsonObject,
}

impl MessageAccumulator {
    pub(super) fn apply(&mut self, event: &JsonValue) {
        match str_field(event, "type").unwrap_or_default() {
            "message_start" => self.start(event.get("message")),
            "message_delta" => self.delta(event),
            "content_block_start" => {
                self.content
                    .push(event.get("content_block").cloned().unwrap_or_default());
            }
            "content_block_delta" => self.block_delta(event),
            "content_block_stop" => self.block_stop(index_of(event) as usize),
            _ => {}
        }
    }

    fn start(&mut self, message: Option<&JsonValue>) {
        let Some(message) = message else {
            return;
        };
        if let Some(content) = message.get("content").and_then(JsonValue::as_array) {
            self.content.clone_from(content);
        }
        if let Some(usage) = message.get("usage").and_then(JsonValue::as_object) {
            self.usage.clone_from(usage);
        }
        self.stop_reason = message.get("stop_reason").cloned();
    }

    fn delta(&mut self, event: &JsonValue) {
        if let Some(stop_reason) = event.get("delta").and_then(|delta| delta.get("stop_reason")) {
            self.stop_reason = Some(stop_reason.clone());
        }
        let Some(usage) = event.get("usage").and_then(JsonValue::as_object) else {
            return;
        };
        for (key, value) in usage {
            if key == "output_tokens" || !value.is_null() {
                self.usage.insert(key.clone(), value.clone());
            }
        }
    }

    fn block_delta(&mut self, event: &JsonValue) {
        let index = index_of(event) as usize;
        let Some(delta) = event.get("delta") else {
            return;
        };
        if str_field(delta, "type") == Some("input_json_delta") {
            let partial = str_field(delta, "partial_json").unwrap_or_default();
            self.tool_input.entry(index).or_default().push_str(partial);
            return;
        }
        let Some(JsonValue::Object(block)) = self.content.get_mut(index) else {
            return;
        };
        let append = |block: &mut JsonObject, key: &str, text: &str| {
            let current = block.get(key).and_then(JsonValue::as_str).unwrap_or_default();
            let joined = format!("{current}{text}");
            block.insert(key.to_owned(), joined.into());
        };
        let kind = block
            .get("type")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_owned();
        match (str_field(delta, "type").unwrap_or_default(), kind.as_str()) {
            ("text_delta", "text") => append(block, "text", str_field(delta, "text").unwrap_or_default()),
            ("citations_delta", "text") => {
                let citation = delta.get("citation").cloned().unwrap_or_default();
                match block.get_mut("citations") {
                    Some(JsonValue::Array(citations)) => citations.push(citation),
                    _ => {
                        block.insert("citations".to_owned(), JsonValue::Array(vec![citation]));
                    }
                }
            }
            ("thinking_delta", "thinking") => {
                append(block, "thinking", str_field(delta, "thinking").unwrap_or_default());
            }
            ("signature_delta", "thinking") => {
                block.insert(
                    "signature".to_owned(),
                    delta.get("signature").cloned().unwrap_or_default(),
                );
            }
            ("compaction_delta", "compaction") => {
                if let Some(content) = str_field(delta, "content") {
                    append(block, "content", content);
                }
                block.insert(
                    "encrypted_content".to_owned(),
                    delta.get("encrypted_content").cloned().unwrap_or_default(),
                );
            }
            _ => {}
        }
    }

    fn block_stop(&mut self, index: usize) {
        let Some(JsonValue::Object(block)) = self.content.get_mut(index) else {
            return;
        };
        let tracks_input = block
            .get("type")
            .and_then(JsonValue::as_str)
            .is_some_and(|kind| TOOL_INPUT_BLOCK_TYPES.contains(&kind));
        let Some(input) = self.tool_input.remove(&index).filter(|_| tracks_input) else {
            return;
        };
        let parsed = serde_json::from_str(&input).unwrap_or_else(|error| {
            tracing::debug!("error=<{error}> | unable to parse server tool input json | using an empty input");
            JsonValue::Object(JsonObject::new())
        });
        block.insert("input".to_owned(), parsed);
    }

    /// The accumulated content blocks, as the response would carry them.
    pub(super) fn content(&self) -> &[JsonValue] {
        &self.content
    }

    /// The response's stop reason, when it sent one.
    pub(super) fn stop_reason(&self) -> Option<&str> {
        self.stop_reason.as_ref().and_then(JsonValue::as_str)
    }

    /// The response's usage payload.
    pub(super) fn usage(&self) -> Option<JsonValue> {
        (!self.usage.is_empty()).then(|| JsonValue::Object(self.usage.clone()))
    }
}

/// The state of one response's event loop.
#[derive(Debug)]
pub(super) struct ResponseState {
    pub(super) stop_reason: StopReason,
    pub(super) stopped: bool,
    pub(super) usage: UsageCounters,
    pub(super) message: MessageAccumulator,
    server_tool_blocks: HashSet<u64>,
}

impl Default for ResponseState {
    fn default() -> Self {
        Self {
            stop_reason: StopReason::EndTurn,
            stopped: false,
            usage: UsageCounters::default(),
            message: MessageAccumulator::default(),
            server_tool_blocks: HashSet::new(),
        }
    }
}

fn delta_event(delta: impl Into<crate::models::streaming::ContentBlockDelta>) -> ModelStreamEvent {
    ModelContentBlockDeltaEvent::new(delta).into()
}

impl ResponseState {
    /// Applies one event, returning the SDK events it produces. `first_response` is false for the
    /// continuation of a paused turn, whose message start is not repeated.
    pub(super) fn handle(&mut self, event: &JsonValue, first_response: bool) -> Vec<ModelStreamEvent> {
        self.message.apply(event);
        match str_field(event, "type").unwrap_or_default() {
            "message_start" => {
                let message = event.get("message");
                if let Some(usage) = message.and_then(|message| message.get("usage")) {
                    self.usage.merge(usage);
                }
                if !first_response {
                    return Vec::new();
                }
                let role = match message.and_then(|message| str_field(message, "role")) {
                    Some("user") => Role::User,
                    _ => Role::Assistant,
                };
                vec![ModelMessageStartEvent::new(role).into()]
            }
            "content_block_start" => self.block_start(event),
            "content_block_delta" => self.block_delta(event),
            "content_block_stop" => {
                if self.server_tool_blocks.remove(&index_of(event)) {
                    return Vec::new();
                }
                vec![ModelContentBlockStopEvent::new().into()]
            }
            "message_delta" => {
                // Cumulative within one response; fields Anthropic omits keep their message_start value.
                if let Some(usage) = event.get("usage") {
                    self.usage.merge(usage);
                }
                if let Some(reason) = event.get("delta").and_then(|delta| str_field(delta, "stop_reason")) {
                    self.stop_reason = map_stop_reason(reason);
                }
                Vec::new()
            }
            "message_stop" => {
                self.stopped = true;
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn block_start(&mut self, event: &JsonValue) -> Vec<ModelStreamEvent> {
        let block = event.get("content_block").cloned().unwrap_or_default();
        let kind = str_field(&block, "type").unwrap_or_default();
        if SERVER_TOOL_BLOCK_TYPES.contains(&kind) {
            self.server_tool_blocks.insert(index_of(event));
            log_server_tool_block(kind, &block);
            return Vec::new();
        }
        let start = ModelContentBlockStartEvent::new();
        match kind {
            "tool_use" => {
                let name = str_field(&block, "name").unwrap_or_default();
                let id = str_field(&block, "id").unwrap_or_default();
                vec![start.with_start(ToolUseStart::new(name, id)).into()]
            }
            "thinking" => {
                let mut events = vec![start.into()];
                if let Some(thinking) = str_field(&block, "thinking").filter(|thinking| !thinking.is_empty()) {
                    let mut delta = ReasoningContentDelta::new().with_text(thinking);
                    if let Some(signature) = str_field(&block, "signature") {
                        delta = delta.with_signature(signature);
                    }
                    events.push(delta_event(delta));
                }
                events
            }
            "redacted_thinking" => {
                let data = str_field(&block, "data").unwrap_or_default();
                let bytes = base64_bytes::decode(data).unwrap_or_default();
                vec![
                    start.into(),
                    delta_event(ReasoningContentDelta::new().with_redacted_content(bytes)),
                ]
            }
            _ => {
                let mut events = vec![start.into()];
                if let Some(text) = str_field(&block, "text").filter(|text| kind == "text" && !text.is_empty()) {
                    events.push(delta_event(TextDelta::new(text)));
                }
                events
            }
        }
    }

    fn block_delta(&self, event: &JsonValue) -> Vec<ModelStreamEvent> {
        if self.server_tool_blocks.contains(&index_of(event)) {
            return Vec::new();
        }
        let Some(delta) = event.get("delta") else {
            return Vec::new();
        };
        let field = |key| str_field(delta, key).unwrap_or_default();
        let event = match str_field(delta, "type").unwrap_or_default() {
            "text_delta" => delta_event(TextDelta::new(field("text"))),
            "citations_delta" => {
                let Some(citation) = delta.get("citation").and_then(format_citation) else {
                    return Vec::new();
                };
                delta_event(CitationsDelta::new(vec![citation], Vec::new()))
            }
            "input_json_delta" => delta_event(ToolUseInputDelta::new(field("partial_json"))),
            "thinking_delta" => delta_event(ReasoningContentDelta::new().with_text(field("thinking"))),
            "signature_delta" => delta_event(ReasoningContentDelta::new().with_signature(field("signature"))),
            _ => return Vec::new(),
        };
        vec![event]
    }
}

/// Logs a skipped server-side tool block, at warn level when the tool returned an error.
fn log_server_tool_block(kind: &str, block: &JsonValue) {
    let error_code = block.get("content").and_then(|content| content.get("error_code"));
    match error_code {
        Some(code) => {
            let code = code.as_str().map_or_else(|| code.to_string(), str::to_owned);
            tracing::warn!("block_type=<{kind}>, error_code=<{code}> | server-side tool failed");
        }
        None => tracing::debug!("block_type=<{kind}> | skipping server-side tool block"),
    }
}

pub(super) fn map_stop_reason(reason: &str) -> StopReason {
    match reason {
        "end_turn" => StopReason::EndTurn,
        "max_tokens" => StopReason::MaxTokens,
        "stop_sequence" => StopReason::StopSequence,
        "tool_use" => StopReason::ToolUse,
        "pause_turn" => StopReason::PauseTurn,
        "refusal" => StopReason::Refusal,
        other => {
            tracing::warn!("stop_reason=<{other}> | unknown anthropic stop reason");
            serde_json::from_value(JsonValue::String(other.to_owned())).unwrap_or(StopReason::EndTurn)
        }
    }
}

/// Maps an Anthropic citation onto an SDK citation; `None` for a location type the SDK has no
/// equivalent for.
fn format_citation(citation: &JsonValue) -> Option<Citation> {
    let text = |key| str_field(citation, key).unwrap_or_default().to_owned();
    let index = |key| citation.get(key).and_then(number).unwrap_or_default();
    let cited: Vec<CitationSourceContent> = str_field(citation, "cited_text")
        .filter(|text| !text.is_empty())
        .map(CitationSourceContent::new)
        .into_iter()
        .collect();
    let (location, source, title): (CitationLocation, String, String) =
        match str_field(citation, "type").unwrap_or_default() {
            "web_search_result_location" => {
                let url = text("url");
                let mut location = WebLocation::new(url.clone());
                if let Some(domain) = reqwest::Url::parse(&url)
                    .ok()
                    .and_then(|parsed| parsed.host_str().map(str::to_owned))
                    .filter(|domain| !domain.is_empty())
                {
                    location = location.with_domain(domain);
                }
                (location.into(), url, text("title"))
            }
            "search_result_location" => (
                SearchResultLocation::new(
                    index("search_result_index"),
                    index("start_block_index"),
                    index("end_block_index"),
                )
                .into(),
                text("source"),
                text("title"),
            ),
            "char_location" => (
                DocumentCharLocation::new(
                    index("document_index"),
                    index("start_char_index"),
                    index("end_char_index"),
                )
                .into(),
                text("file_id"),
                text("document_title"),
            ),
            "page_location" => (
                DocumentPageLocation::new(
                    index("document_index"),
                    index("start_page_number"),
                    index("end_page_number"),
                )
                .into(),
                text("file_id"),
                text("document_title"),
            ),
            "content_block_location" => (
                DocumentChunkLocation::new(
                    index("document_index"),
                    index("start_block_index"),
                    index("end_block_index"),
                )
                .into(),
                text("file_id"),
                text("document_title"),
            ),
            other => {
                tracing::warn!("citation_type=<{other}> | unsupported citation location | skipping");
                return None;
            }
        };
    Some(Citation::new(location, source, cited, title))
}
