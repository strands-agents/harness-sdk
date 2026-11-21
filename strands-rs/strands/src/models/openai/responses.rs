//! The Responses API adapter: request formatting, durable prompt-cache checkpoints and event mapping.
//!
//! Built-in tools pass through `params.tools`: `web_search` is fully supported (URL citations are
//! emitted); `file_search`, `code_interpreter`, `mcp` and `shell` work without their extra output
//! (file citations, executed code, approvals); `image_generation` is not supported.

use indexmap::IndexMap;
use serde_json::json;

use super::OpenAIModelConfig;
use super::cache::{apply_cache_config, is_cache_lifetime};
use super::formatting::{
    block_type, data_url, document_source_type, image_data_url, is_truthy, json_string, non_empty_str, object,
    positive_count, token_count, tool_result_content_type, warn_managed_params, wire_name,
};
use crate::models::defaults::MODEL_DEFAULTS;
use crate::models::model_info::{SystemPromptPlacement, lookup_system_prompt_placement};
use crate::models::streaming::{
    CitationsDelta, ModelContentBlockDeltaEvent, ModelContentBlockStartEvent, ModelContentBlockStopEvent,
    ModelMessageStartEvent, ModelMessageStopEvent, ModelMetadataEvent, ModelStreamEvent, ReasoningContentDelta,
    TextDelta, ToolUseInputDelta, ToolUseStart, Usage,
};
use crate::models::{CacheSectionSetting, ModelInfo, ModelRequest, PromptCaching};
use crate::state_store::StateStore;
use crate::types::{
    Citation, CitationGeneratedContent, ContentBlock, DocumentBlock, DocumentSource, ImageBlock, JsonObject, JsonValue,
    Role, StopReason, SystemContentBlock, SystemPrompt, ToolChoice, ToolResultBlock, ToolResultContent,
    ToolResultStatus, WebLocation,
};

/// Request fields the provider sets itself; `params` cannot override them.
const MANAGED_PARAMS: [&str; 4] = ["model", "input", "stream", "store"];

/// Input part types that take a `prompt_cache_breakpoint`.
const CACHEABLE_INPUT_TYPES: [&str; 3] = ["input_text", "input_image", "input_file"];

/// The `modelState` key that chains stateful turns.
pub(super) const RESPONSE_ID_KEY: &str = "responseId";

/// The message of a failed response that carries no error details.
const RESPONSE_FAILED_MESSAGE: &str = "OpenAI Responses API response failed";

/// Logs a warning for each Responses managed key in `params`.
pub(super) fn warn_responses_managed_params(params: Option<&JsonObject>) {
    warn_managed_params(params, &MANAGED_PARAMS);
}

/// Builds a Responses API streaming request body. `model_info` decides
/// whether durable message checkpoints are placed.
pub(super) fn format_responses_request(
    config: &OpenAIModelConfig,
    request: &ModelRequest,
    stateful: bool,
    model_info: &ModelInfo,
) -> JsonObject {
    let cache_config = config.cache_config.as_ref();
    let cache_points = model_info.capabilities.prompt_caching == Some(PromptCaching::CachePoints);
    let messages_ttl = cache_config.and_then(|cache| cache.messages_ttl.as_ref());
    let cache_messages =
        cache_points && cache_config.is_some() && messages_ttl != Some(&CacheSectionSetting::Enabled(false));
    let messages: Vec<(Role, &[ContentBlock])> = request
        .messages
        .iter()
        .map(|message| (message.role, message.content.as_slice()))
        .collect();
    let dynamic_trailing_blocks = request.dynamic_trailing_blocks.unwrap_or_default();
    let (mut input, explicit_cache) = if cache_messages {
        format_cacheable_messages(&messages, dynamic_trailing_blocks, messages_ttl)
    } else {
        (format_messages(&messages), false)
    };
    let model_id = config.model_id.as_deref().unwrap_or(MODEL_DEFAULTS.openai.model_id);
    let mut instructions = format_instructions(request.system_prompt.as_ref());
    // Some models append instructions after the input, where they never cache; a leading developer
    // message does. A stored conversation would keep every resent copy.
    if let Some(system_prompt) = instructions.take_if(|text| {
        !text.is_empty()
            && !stateful
            && lookup_system_prompt_placement(model_id) == Some(SystemPromptPlacement::Message)
    }) {
        input.insert(
            0,
            json!({"role": "developer", "content": [{"type": "input_text", "text": system_prompt}]}),
        );
    }

    let mut body = config
        .params
        .as_ref()
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    body.insert("model".to_owned(), model_id.into());
    body.insert("input".to_owned(), JsonValue::Array(input));
    body.insert("stream".to_owned(), true.into());
    body.insert("store".to_owned(), stateful.into());

    if stateful
        && let Some(response_id) = request.model_state.get_value(RESPONSE_ID_KEY)
        && is_truthy(Some(&response_id))
    {
        body.insert("previous_response_id".to_owned(), response_id);
    }

    if let Some(instructions) = instructions {
        body.insert("instructions".to_owned(), instructions.into());
    }

    if !request.tool_specs.is_empty() {
        let mut tools = match body.get("tools") {
            Some(JsonValue::Array(tools)) => tools.clone(),
            _ => Vec::new(),
        };
        tools.extend(request.tool_specs.iter().map(|spec| {
            object([
                ("type", "function".into()),
                ("name", spec.name.clone().into()),
                ("description", spec.description.clone().into()),
                ("parameters", spec.input_schema.clone().unwrap_or_else(|| json!({}))),
                ("strict", JsonValue::Null),
            ])
        }));
        body.insert("tools".to_owned(), JsonValue::Array(tools));
        if let Some(choice) = &request.tool_choice {
            body.insert("tool_choice".to_owned(), format_tool_choice(choice));
        }
    }

    let numbers = [
        ("temperature", config.temperature.map(JsonValue::from)),
        ("max_output_tokens", config.max_tokens.map(JsonValue::from)),
        ("top_p", config.top_p.map(JsonValue::from)),
    ];
    for (key, value) in numbers {
        if let Some(value) = value {
            body.insert(key.to_owned(), value);
        }
    }

    if explicit_cache {
        let mut options = JsonObject::new();
        options.insert("mode".to_owned(), "explicit".into());
        let native = config
            .params
            .as_ref()
            .and_then(|params| params.get("prompt_cache_options"));
        if let Some(JsonValue::Object(native)) = native {
            options.extend(native.clone());
        }
        body.insert("prompt_cache_options".to_owned(), JsonValue::Object(options));
    }

    apply_cache_config(&mut body, cache_config, request.agent_metadata.as_ref(), cache_points);
    body
}

fn format_tool_choice(choice: &ToolChoice) -> JsonValue {
    match choice {
        ToolChoice::Auto => "auto".into(),
        ToolChoice::Any => "required".into(),
        ToolChoice::Tool { name } => json!({"type": "function", "name": name}),
    }
}

/// The `instructions`: a string system prompt as is, or its text blocks joined.
fn format_instructions(system_prompt: Option<&SystemPrompt>) -> Option<String> {
    match system_prompt? {
        SystemPrompt::Text(text) => Some(text.clone()),
        SystemPrompt::Blocks(blocks) => {
            let texts: Vec<&str> = blocks
                .iter()
                .filter_map(|block| match block {
                    SystemContentBlock::Text(text) => Some(text.text.as_str()),
                    _ => None,
                })
                .collect();
            (!texts.is_empty()).then(|| texts.concat())
        }
    }
}

/// Formats messages with a cache checkpoint on the last input part of each durable user message.
///
/// The final user message's last `dynamic_trailing_blocks` blocks are temporary: they go after the
/// checkpoint and after any tool outputs, so a changing injection never shifts the cached prefix.
/// Returns the input and whether `prompt_cache_options.mode` defaults to explicit, which needs a
/// checkpoint or a temporary suffix.
fn format_cacheable_messages(
    messages: &[(Role, &[ContentBlock])],
    dynamic_trailing_blocks: usize,
    messages_ttl: Option<&CacheSectionSetting>,
) -> (Vec<JsonValue>, bool) {
    let ttl = match messages_ttl {
        Some(CacheSectionSetting::Ttl(ttl)) if is_cache_lifetime(ttl) => Some(ttl.as_str()),
        _ => None,
    };
    let mut breakpoint = JsonObject::new();
    breakpoint.insert("mode".to_owned(), "explicit".into());
    if let Some(ttl) = ttl {
        breakpoint.insert("ttl".to_owned(), ttl.into());
    }
    let mut input = Vec::new();
    let mut has_checkpoints = false;
    for (index, (role, content)) in messages.iter().enumerate() {
        let is_latest_user = *role == Role::User && index + 1 == messages.len();
        let dynamic_count = if is_latest_user { dynamic_trailing_blocks } else { 0 };
        let boundary = content.len().saturating_sub(dynamic_count);
        let mut items = format_messages(&[(*role, &content[..boundary])]);
        normalize_tool_outputs(&mut items);
        if *role == Role::User
            && let Some(part) = last_cacheable_part(&mut items)
        {
            part.insert(
                "prompt_cache_breakpoint".to_owned(),
                JsonValue::Object(breakpoint.clone()),
            );
            has_checkpoints = true;
        }
        if dynamic_count > 0 {
            let mut tail = format_messages(&[(Role::User, &content[boundary..])]);
            normalize_tool_outputs(&mut tail);
            append_dynamic_content(&mut items, tail);
        }
        input.extend(items);
    }
    (input, has_checkpoints || dynamic_trailing_blocks > 0)
}

/// Sends text tool outputs as one `input_text` block, so they can carry a checkpoint and replay
/// identically. An empty output stays a string: an empty text block makes no checkpoint.
fn normalize_tool_outputs(items: &mut [JsonValue]) {
    for item in items {
        if item.get("type").and_then(JsonValue::as_str) != Some("function_call_output") {
            continue;
        }
        let Some(output) = non_empty_str(item, "output").map(str::to_owned) else {
            continue;
        };
        item["output"] = json!([{"type": "input_text", "text": output}]);
    }
}

/// The final text, image or file part of formatted durable user input.
fn last_cacheable_part(items: &mut [JsonValue]) -> Option<&mut JsonObject> {
    items
        .iter_mut()
        .rev()
        .filter_map(|item| {
            let key = if item.get("type").and_then(JsonValue::as_str) == Some("function_call_output") {
                "output"
            } else {
                "content"
            };
            item.get_mut(key).and_then(JsonValue::as_array_mut)
        })
        .flat_map(|parts| parts.iter_mut().rev())
        .filter_map(JsonValue::as_object_mut)
        .find(|part| {
            part.get("type")
                .and_then(JsonValue::as_str)
                .is_some_and(|kind| CACHEABLE_INPUT_TYPES.contains(&kind))
        })
}

/// Merges temporary content into the durable user message; after tool outputs it becomes its own
/// message.
fn append_dynamic_content(items: &mut Vec<JsonValue>, mut tail: Vec<JsonValue>) {
    let both_messages = matches!(
        (items.last(), tail.first()),
        (Some(last), Some(first)) if last.get("role").is_some() && first.get("role").is_some()
    );
    if both_messages {
        let first = tail.remove(0);
        let parts = first
            .get("content")
            .and_then(JsonValue::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(content) = items
            .last_mut()
            .and_then(|last| last.get_mut("content"))
            .and_then(JsonValue::as_array_mut)
        {
            content.extend(parts);
        }
    }
    items.extend(tail);
}

/// Formats messages as Responses input items: text and media grouped
/// per message, then each tool call and each tool result as its own item.
fn format_messages(messages: &[(Role, &[ContentBlock])]) -> Vec<JsonValue> {
    let mut input = Vec::new();
    for (role, content) in messages {
        let is_assistant = *role == Role::Assistant;
        let text_type = if is_assistant { "output_text" } else { "input_text" };
        let mut content_items = Vec::new();
        let mut tool_calls = Vec::new();
        let mut tool_results = Vec::new();
        for block in *content {
            match block {
                ContentBlock::Text(text) => content_items.push(json!({"type": text_type, "text": text.text})),
                ContentBlock::Image(image) => content_items.extend(format_image_input(image)),
                ContentBlock::Document(document) => content_items.extend(format_document_input(document)),
                ContentBlock::Citations(citations) => content_items.extend(
                    citations
                        .content
                        .iter()
                        .map(|content| json!({"type": text_type, "text": content.text})),
                ),
                ContentBlock::ToolUse(tool_use) => tool_calls.push(object([
                    ("type", "function_call".into()),
                    ("call_id", tool_use.tool_use_id.clone().into()),
                    ("name", tool_use.name.clone().into()),
                    ("arguments", json_string(&tool_use.input).unwrap_or_default().into()),
                ])),
                ContentBlock::ToolResult(result) => tool_results.push(object([
                    ("type", "function_call_output".into()),
                    ("call_id", result.tool_use_id.clone().into()),
                    ("output", format_tool_result_output(result)),
                ])),
                ContentBlock::Reasoning(_) => tracing::warn!(
                    "block_type=<reasoningBlock> | reasoning content is not yet supported in multi-turn conversations with the responses api"
                ),
                ContentBlock::Unknown(_) => {}
                block => tracing::warn!(
                    "block_type=<{}> | unsupported content type in responses api message formatting | skipping",
                    block_type(block)
                ),
            }
        }
        if !content_items.is_empty() {
            if is_assistant {
                input.extend(assistant_history(&content_items));
            } else {
                input.push(json!({"role": "user", "content": content_items}));
            }
        }
        input.extend(tool_calls);
        input.extend(tool_results);
    }
    input
}

/// Assistant history as the string message form, the only assistant input shape without the
/// output metadata (ids, status, annotations) the history no longer holds; other content is
/// dropped with a warning.
fn assistant_history(content_items: &[JsonValue]) -> Option<JsonValue> {
    let item_type = |item: &JsonValue| {
        item.get("type")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let dropped: Vec<String> = content_items
        .iter()
        .map(item_type)
        .filter(|kind| kind != "output_text")
        .collect();
    if !dropped.is_empty() {
        tracing::warn!(
            "content_type=<{}> | non-text assistant history content has no valid responses api input shape | dropping",
            dropped.join(", ")
        );
    }
    let text = content_items
        .iter()
        .filter(|item| item_type(item) == "output_text")
        .filter_map(|item| item.get("text").and_then(JsonValue::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then(|| json!({"role": "assistant", "content": text}))
}

fn format_image_input(image: &ImageBlock) -> Option<JsonValue> {
    let url = image_data_url(image)?;
    Some(json!({"type": "input_image", "image_url": url}))
}

fn input_file(document: &DocumentBlock, bytes: &[u8]) -> JsonValue {
    json!({
        "type": "input_file",
        "file_data": data_url(&wire_name(document.format), "application", bytes),
        "filename": document.name,
    })
}

fn format_document_input(document: &DocumentBlock) -> Option<JsonValue> {
    if let DocumentSource::Bytes(bytes) = &document.source {
        return Some(input_file(document, bytes));
    }
    tracing::warn!(
        "source_type=<{}> | only byte source documents supported in responses api",
        document_source_type(&document.source)
    );
    None
}

/// A tool result's `function_call_output.output`: the texts joined by
/// newlines, or the content-item array when the result carries an image or a document.
fn format_tool_result_output(result: &ToolResultBlock) -> JsonValue {
    let mut parts = Vec::new();
    let mut texts = Vec::new();
    let mut has_media = false;
    for content in &result.content {
        match content {
            ToolResultContent::Text(text) => {
                texts.push(text.text.clone());
                parts.push(json!({"type": "input_text", "text": text.text}));
            }
            ToolResultContent::Json(json) => {
                let text = json_string(&json.json).unwrap_or_else(|| "[JSON serialization error]".to_owned());
                parts.push(json!({"type": "input_text", "text": text}));
                texts.push(text);
            }
            ToolResultContent::Image(image) => {
                if let Some(url) = image_data_url(image) {
                    has_media = true;
                    parts.push(json!({"type": "input_image", "image_url": url}));
                }
            }
            ToolResultContent::Document(document) => match &document.source {
                DocumentSource::Bytes(bytes) => {
                    has_media = true;
                    parts.push(input_file(document, bytes));
                }
                source => tracing::warn!(
                    "source_type=<{}> | only byte source documents supported in responses api tool results",
                    document_source_type(source)
                ),
            },
            ToolResultContent::Unknown(_) => {}
            other => tracing::warn!(
                "block_type=<{}> | unsupported tool result content type for responses api",
                tool_result_content_type(other)
            ),
        }
    }
    if has_media {
        return JsonValue::Array(parts);
    }
    let text = texts.join("\n");
    match result.status {
        ToolResultStatus::Error => format!("[ERROR] {text}").into(),
        _ => text.into(),
    }
}

/// The kind of the open content block, so a switch closes it and opens another.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DataType {
    Text,
    Reasoning,
    Citations,
}

#[derive(Debug, Clone)]
struct ToolCall {
    name: String,
    arguments: String,
    call_id: String,
}

/// Stream state of the Responses adapter (`ResponsesStreamState`).
#[derive(Debug)]
pub(super) struct ResponsesStreamState {
    data_type: Option<DataType>,
    /// Function calls by item id, in the order they were added.
    tool_calls: IndexMap<String, ToolCall>,
    final_usage: Option<Usage>,
    stop_reason: StopReason,
}

impl Default for ResponsesStreamState {
    fn default() -> Self {
        Self {
            data_type: None,
            tool_calls: IndexMap::new(),
            final_usage: None,
            stop_reason: StopReason::EndTurn,
        }
    }
}

/// A failed response or an `error` event: the message, or the fallback text, and the error code.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub(super) struct ResponsesStreamError {
    pub(super) message: String,
    pub(super) code: Option<String>,
}

impl ResponsesStreamError {
    fn new(error: Option<&JsonValue>) -> Self {
        let field = |key| error.and_then(|error| non_empty_str(error, key)).map(str::to_owned);
        Self {
            message: field("message").unwrap_or_else(|| RESPONSE_FAILED_MESSAGE.to_owned()),
            code: field("code"),
        }
    }
}

/// The usage of a response, with prompt-cache reads and writes.
fn map_usage(usage: &JsonValue) -> Usage {
    let count = |key| token_count(usage.get(key)).unwrap_or_default();
    let mut mapped = Usage::new(count("input_tokens"), count("output_tokens"), count("total_tokens"));
    let details = usage.get("input_tokens_details");
    if let Some(cached) = positive_count(details.and_then(|details| details.get("cached_tokens"))) {
        mapped = mapped.with_cache_read_input_tokens(cached);
    }
    if let Some(written) = positive_count(details.and_then(|details| details.get("cache_write_tokens"))) {
        mapped = mapped.with_cache_write_input_tokens(written);
    }
    mapped
}

fn switch_content(next: DataType, state: &mut ResponsesStreamState, events: &mut Vec<ModelStreamEvent>) {
    if state.data_type == Some(next) {
        return;
    }
    if state.data_type.is_some() {
        events.push(ModelContentBlockStopEvent::new().into());
    }
    events.push(ModelContentBlockStartEvent::new().into());
    state.data_type = Some(next);
}

/// Maps one Responses stream event to SDK events. With `stateful`,
/// stores the response id in `model_state`.
pub(super) fn map_responses_event(
    event: &JsonValue,
    state: &mut ResponsesStreamState,
    stateful: bool,
    model_state: &StateStore,
) -> Result<Vec<ModelStreamEvent>, ResponsesStreamError> {
    let mut events = Vec::new();
    let delta_text = || event.get("delta").and_then(JsonValue::as_str).unwrap_or_default();
    match event.get("type").and_then(JsonValue::as_str).unwrap_or_default() {
        "response.created" => {
            let response_id = event.get("response").and_then(|response| response.get("id"));
            if stateful && let Some(response_id) = response_id {
                let _ = model_state.set(RESPONSE_ID_KEY, response_id);
            }
            events.push(ModelMessageStartEvent::new(Role::Assistant).into());
        }
        "response.output_text.delta" => {
            switch_content(DataType::Text, state, &mut events);
            events.push(ModelContentBlockDeltaEvent::new(TextDelta::new(delta_text())).into());
        }
        "response.reasoning_text.delta" | "response.reasoning_summary_text.delta" => {
            switch_content(DataType::Reasoning, state, &mut events);
            let delta = ReasoningContentDelta::new().with_text(delta_text());
            events.push(ModelContentBlockDeltaEvent::new(delta).into());
        }
        "response.output_text.annotation.added" => map_annotation(event.get("annotation"), state, &mut events),
        "response.output_item.added" => add_function_call(event.get("item"), state),
        "response.function_call_arguments.delta" => {
            if let Some(call) = item_call(event, state) {
                call.arguments.push_str(delta_text());
            }
        }
        "response.function_call_arguments.done" => {
            let arguments = event
                .get("arguments")
                .and_then(JsonValue::as_str)
                .unwrap_or_default()
                .to_owned();
            if let Some(call) = item_call(event, state) {
                call.arguments = arguments;
            }
        }
        "response.incomplete" => {
            let response = event.get("response");
            record_usage(response, state);
            let reason = response
                .and_then(|response| response.get("incomplete_details"))
                .and_then(|details| details.get("reason"))
                .and_then(JsonValue::as_str);
            match reason {
                Some("max_output_tokens") => state.stop_reason = StopReason::MaxTokens,
                Some("content_filter") => state.stop_reason = StopReason::ContentFiltered,
                _ => {}
            }
        }
        "response.failed" => {
            let error = event.get("response").and_then(|response| response.get("error"));
            return Err(ResponsesStreamError::new(error.filter(|error| error.is_object())));
        }
        "error" => return Err(ResponsesStreamError::new(Some(event))),
        "response.completed" => record_usage(event.get("response"), state),
        _ => {}
    }
    Ok(events)
}

fn record_usage(response: Option<&JsonValue>, state: &mut ResponsesStreamState) {
    let usage = response
        .and_then(|response| response.get("usage"))
        .filter(|usage| usage.is_object());
    if let Some(usage) = usage {
        state.final_usage = Some(map_usage(usage));
    }
}

fn item_call<'a>(event: &JsonValue, state: &'a mut ResponsesStreamState) -> Option<&'a mut ToolCall> {
    let item_id = event.get("item_id").and_then(JsonValue::as_str)?;
    state.tool_calls.get_mut(item_id)
}

fn add_function_call(item: Option<&JsonValue>, state: &mut ResponsesStreamState) {
    let Some(item) = item.filter(|item| item.get("type").and_then(JsonValue::as_str) == Some("function_call")) else {
        return;
    };
    let text = |key| item.get(key).and_then(JsonValue::as_str).unwrap_or_default().to_owned();
    let (call_id, name) = (text("call_id"), text("name"));
    // The item id keys the argument events; a missing one would let distinct calls share a key.
    let Some(item_id) = non_empty_str(item, "id") else {
        tracing::warn!("call_id=<{call_id}> name=<{name}> | function_call event missing item id — skipping");
        return;
    };
    state.tool_calls.insert(
        item_id.to_owned(),
        ToolCall {
            name,
            arguments: String::new(),
            call_id,
        },
    );
}

fn map_annotation(
    annotation: Option<&JsonValue>,
    state: &mut ResponsesStreamState,
    events: &mut Vec<ModelStreamEvent>,
) {
    let text = |key| {
        annotation
            .and_then(|annotation| annotation.get(key))
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let kind = text("type");
    if kind != "url_citation" {
        tracing::warn!("annotation_type=<{kind}> | unsupported annotation type in responses api");
        return;
    }
    // Text and a citation in one open block would lose the text when the block closes, so the
    // citation gets its own block.
    switch_content(DataType::Citations, state, events);
    let url = text("url");
    let citation = Citation::new(WebLocation::new(url.clone()), url, Vec::new(), text("title"));
    let delta = CitationsDelta::new(vec![citation], vec![CitationGeneratedContent::new(text("cited_text"))]);
    events.push(ModelContentBlockDeltaEvent::new(delta).into());
}

/// The closing events of a Responses stream: closes an open block,
/// emits the function calls, the usage and the stop event.
pub(super) fn finalize_responses_stream(state: ResponsesStreamState) -> Vec<ModelStreamEvent> {
    let mut events = Vec::new();
    if state.data_type.is_some() {
        events.push(ModelContentBlockStopEvent::new().into());
    }
    let has_tool_calls = !state.tool_calls.is_empty();
    for call in state.tool_calls.into_values() {
        events.push(
            ModelContentBlockStartEvent::new()
                .with_start(ToolUseStart::new(call.name, call.call_id))
                .into(),
        );
        events.push(ModelContentBlockDeltaEvent::new(ToolUseInputDelta::new(call.arguments)).into());
        events.push(ModelContentBlockStopEvent::new().into());
    }
    // A function call in flight at max_output_tokens has truncated arguments, so maxTokens wins.
    let stop_reason = if has_tool_calls && state.stop_reason != StopReason::MaxTokens {
        StopReason::ToolUse
    } else {
        state.stop_reason
    };
    if let Some(usage) = state.final_usage {
        events.push(ModelMetadataEvent::new().with_usage(usage).into());
    }
    events.push(ModelMessageStopEvent::new(stop_reason).into());
    events
}
