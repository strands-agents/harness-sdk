//! The Chat Completions adapter: request formatting and chunk mapping.

use serde_json::json;

use super::OpenAIModelConfig;
use super::cache::apply_cache_config;
use super::formatting::{
    block_type, data_url, document_source_type, image_data_url, is_truthy, js_trim, json_string, object,
    warn_managed_params, wire_name,
};
use crate::error::{Error, Result};
use crate::logging::warn_once;
use crate::models::ModelRequest;
use crate::models::defaults::MODEL_DEFAULTS;
use crate::models::model_info::{ChatCompletionsTools, lookup_chat_completions_tools};
use crate::models::streaming::{
    ModelContentBlockDeltaEvent, ModelContentBlockStartEvent, ModelContentBlockStopEvent, ModelMessageStartEvent,
    ModelMessageStopEvent, ModelStreamEvent, TextDelta, ToolUseInputDelta, ToolUseStart,
};
use crate::types::{
    ContentBlock, DocumentSource, ImageBlock, JsonObject, JsonValue, Message, Role, StopReason, SystemContentBlock,
    SystemPrompt, ToolChoice, ToolResultBlock, ToolResultContent, ToolResultStatus,
};

/// Request fields the provider sets itself; `params` cannot override them.
const MANAGED_PARAMS: [&str; 3] = ["model", "messages", "stream"];

/// The tool message text for a tool result that holds only images.
const IMAGE_ONLY_TOOL_RESULT: &str =
    "Tool successfully returned an image. The image is being provided in the following user message.";

/// Logs a warning for each Chat Completions managed key in `params`.
pub(super) fn warn_chat_managed_params(params: Option<&JsonObject>) {
    warn_managed_params(params, &MANAGED_PARAMS);
}

/// Builds a Chat Completions streaming request body.
pub(super) fn format_chat_request(config: &OpenAIModelConfig, request: &ModelRequest) -> Result<JsonObject> {
    let mut body = config
        .params
        .as_ref()
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    let model_id = config.model_id.as_deref().unwrap_or(MODEL_DEFAULTS.openai.model_id);
    body.insert("model".to_owned(), model_id.into());
    body.insert("messages".to_owned(), JsonValue::Array(Vec::new()));
    body.insert("stream".to_owned(), true.into());
    // `params` may override the `stream_options` default or omit it with `null`.
    if !body.contains_key("stream_options") {
        body.insert("stream_options".to_owned(), json!({"include_usage": true}));
    }

    let mut messages = Vec::new();
    if let Some(system) = format_system_prompt(request.system_prompt.as_ref()) {
        messages.push(object([("role", "system".into()), ("content", system.into())]));
    }
    messages.extend(format_chat_messages(&request.messages)?);
    body.insert("messages".to_owned(), JsonValue::Array(messages));

    let numbers = [
        ("temperature", config.temperature.map(JsonValue::from)),
        ("max_completion_tokens", config.max_tokens.map(JsonValue::from)),
        ("top_p", config.top_p.map(JsonValue::from)),
        ("frequency_penalty", config.frequency_penalty.map(JsonValue::from)),
        ("presence_penalty", config.presence_penalty.map(JsonValue::from)),
    ];
    for (key, value) in numbers {
        if let Some(value) = value {
            body.insert(key.to_owned(), value);
        }
    }

    if !request.tool_specs.is_empty() {
        let tools = request
            .tool_specs
            .iter()
            .map(|spec| {
                if spec.name.is_empty() || spec.description.is_empty() {
                    return Err(Error::other("Tool specification must have both name and description"));
                }
                let mut function = JsonObject::new();
                function.insert("name".to_owned(), spec.name.clone().into());
                function.insert("description".to_owned(), spec.description.clone().into());
                if let Some(schema) = &spec.input_schema {
                    function.insert("parameters".to_owned(), schema.clone());
                }
                Ok(object([
                    ("type", "function".into()),
                    ("function", JsonValue::Object(function)),
                ]))
            })
            .collect::<Result<Vec<_>>>()?;
        body.insert("tools".to_owned(), JsonValue::Array(tools));
        if let Some(choice) = &request.tool_choice {
            body.insert("tool_choice".to_owned(), format_tool_choice(choice));
        }
    }

    apply_cache_config(
        &mut body,
        config.cache_config.as_ref(),
        request.agent_metadata.as_ref(),
        false,
    );
    // Only `params` can leave a field `null`, so `null` there omits the field for endpoints that
    // reject it.
    body.retain(|_, value| !value.is_null());

    if body.get("n").and_then(JsonValue::as_f64).is_some_and(|n| n > 1.0) {
        return Err(Error::other("Streaming with n > 1 is not supported"));
    }
    Ok(body)
}

/// Whether `base_url` is the OpenAI API or Bedrock Mantle, where the tool limits in the shared
/// model info were measured.
fn has_openai_tool_limits(base_url: Option<&str>) -> bool {
    let Some(url) = base_url.and_then(|url| reqwest::Url::parse(url).ok()) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    if host == "api.openai.com" {
        return true;
    }
    host.strip_prefix("bedrock-mantle.")
        .and_then(|rest| rest.strip_suffix(".api.aws"))
        .is_some_and(|region| {
            !region.is_empty()
                && region
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

/// Turns reasoning off in a request with tools when OpenAI's Chat Completions API accepts them for
/// the model only that way and `reasoning_effort` is unset. Leaves requests to other endpoints as
/// they are, and returns the limit the API puts on the request's tools.
pub(super) fn apply_chat_completions_tools(
    body: &mut JsonObject,
    base_url: Option<&str>,
) -> Option<ChatCompletionsTools> {
    let has_tools = body
        .get("tools")
        .and_then(JsonValue::as_array)
        .is_some_and(|tools| !tools.is_empty());
    if !has_tools || !has_openai_tool_limits(base_url) {
        return None;
    }
    let model_id = body.get("model").and_then(JsonValue::as_str)?.to_owned();
    let limit = lookup_chat_completions_tools(&model_id);
    let effort_unset = body.get("reasoning_effort").is_none_or(JsonValue::is_null);
    if limit == Some(ChatCompletionsTools::ReasoningOff) && effort_unset {
        warn_once(&format!(
            "model_id=<{model_id}> | this model accepts tools on the Chat Completions API only with reasoning off, sending reasoning_effort='none'; use api: OpenAIApi::Responses to keep reasoning"
        ));
        body.insert("reasoning_effort".to_owned(), "none".into());
    }
    limit
}

/// The hint added to OpenAI's rejection of tools for a model that accepts none on Chat
/// Completions, whose own message suggests `reasoning_effort: "none"`, which such a model rejects
/// too.
pub(super) fn responses_hint(message: &str, model_id: &str) -> String {
    format!(
        "{message} {model_id} does not accept tools on the Chat Completions API with any reasoning_effort. Use OpenAIModel with api: OpenAIApi::Responses instead."
    )
}

fn format_tool_choice(choice: &ToolChoice) -> JsonValue {
    match choice {
        ToolChoice::Auto => "auto".into(),
        ToolChoice::Any => "required".into(),
        ToolChoice::Tool { name } => json!({"type": "function", "function": {"name": name}}),
    }
}

/// The system message text: the string when it is not blank, or the text blocks joined, warning
/// about cache points and guard content.
fn format_system_prompt(system_prompt: Option<&SystemPrompt>) -> Option<String> {
    match system_prompt? {
        SystemPrompt::Text(text) => (!js_trim(text).is_empty()).then(|| text.clone()),
        SystemPrompt::Blocks(blocks) => {
            let mut texts = Vec::new();
            let mut has_cache_points = false;
            let mut has_guard_content = false;
            for block in blocks {
                match block {
                    SystemContentBlock::Text(text) => texts.push(text.text.as_str()),
                    SystemContentBlock::CachePoint(_) => has_cache_points = true,
                    SystemContentBlock::GuardContent(_) => has_guard_content = true,
                }
            }
            if has_cache_points {
                tracing::warn!("cache points are not supported in openai system prompts, ignoring cache points");
            }
            if has_guard_content {
                tracing::warn!("guard content is not supported in openai system prompts, removing guard content block");
            }
            (!texts.is_empty()).then(|| texts.concat())
        }
    }
}

/// Converts messages to Chat Completions messages.
///
/// Tool results become `tool` messages ahead of the turn's other content, so each stays next to
/// the assistant `tool_calls` it answers; media in a tool result moves to a following user message
/// (OpenAI allows media only in user messages).
fn format_chat_messages(messages: &[Message]) -> Result<Vec<JsonValue>> {
    let mut formatted = Vec::new();
    for message in messages {
        match message.role {
            Role::User => format_user_message(&message.content, &mut formatted)?,
            _ => formatted.extend(format_assistant_message(&message.content)?),
        }
    }
    Ok(formatted)
}

fn format_user_message(content: &[ContentBlock], formatted: &mut Vec<JsonValue>) -> Result<()> {
    let parts: Vec<JsonValue> = content
        .iter()
        .filter(|block| !matches!(block, ContentBlock::ToolResult(_)))
        .flat_map(format_user_block)
        .collect();
    let mut media_messages = Vec::new();
    for block in content {
        let ContentBlock::ToolResult(result) = block else {
            continue;
        };
        let (tool_message, images) = format_tool_result(result)?;
        formatted.push(tool_message);
        if !images.is_empty() {
            media_messages.push(object([("role", "user".into()), ("content", JsonValue::Array(images))]));
        }
    }
    formatted.extend(media_messages);
    if !parts.is_empty() {
        formatted.push(object([("role", "user".into()), ("content", JsonValue::Array(parts))]));
    }
    Ok(())
}

fn text_part(text: &str) -> JsonValue {
    object([("type", "text".into()), ("text", text.into())])
}

fn image_part(image: &ImageBlock) -> Option<JsonValue> {
    let url = image_data_url(image)?;
    Some(object([
        ("type", "image_url".into()),
        ("image_url", json!({"url": url})),
    ]))
}

fn format_user_block(block: &ContentBlock) -> Vec<JsonValue> {
    match block {
        ContentBlock::Text(text) => vec![text_part(&text.text)],
        ContentBlock::Image(image) => image_part(image).into_iter().collect(),
        ContentBlock::Document(document) => match &document.source {
            DocumentSource::Bytes(bytes) => {
                let file_data = data_url(&wire_name(document.format), "application", bytes);
                vec![object([
                    ("type", "file".into()),
                    ("file", json!({"file_data": file_data, "filename": document.name})),
                ])]
            }
            DocumentSource::Text(text) => {
                tracing::warn!(
                    "source_type=<documentSourceText> | openai does not support text document sources directly | converting to string content"
                );
                vec![text_part(text)]
            }
            DocumentSource::Content(blocks) => blocks.iter().map(|block| text_part(&block.text)).collect(),
            source => {
                tracing::warn!(
                    "source_type=<{}> | openai only supports text content in user messages | skipping document block",
                    document_source_type(source)
                );
                Vec::new()
            }
        },
        ContentBlock::Unknown(_) => Vec::new(),
        block => {
            tracing::warn!(
                "block_type=<{}> | unsupported content type in openai user message | skipping",
                block_type(block)
            );
            Vec::new()
        }
    }
}

/// A tool result as a `tool` message, and the images it held.
fn format_tool_result(result: &ToolResultBlock) -> Result<(JsonValue, Vec<JsonValue>)> {
    let mut texts = Vec::new();
    let mut images = Vec::new();
    for content in &result.content {
        match content {
            ToolResultContent::Text(text) => texts.push(text.text.clone()),
            ToolResultContent::Json(json) => texts.push(json_string(&json.json).unwrap_or_default()),
            ToolResultContent::Image(image) => images.extend(image_part(image)),
            ToolResultContent::Document(_) => {
                tracing::warn!("block_type=<documentBlock> | documents not supported in openai tool results, skipping");
            }
            ToolResultContent::Video(_) => {
                tracing::warn!("block_type=<videoBlock> | videos not supported in openai tool results, skipping");
            }
            ToolResultContent::ToolReference(_) | ToolResultContent::Unknown(_) => {}
        }
    }
    let text = texts.join("\n");
    let tool_use_id = &result.tool_use_id;
    if !images.is_empty() {
        tracing::warn!(
            "tool_call_id=<{tool_use_id}> | moving images from tool result to separate user message for openai compatibility"
        );
    }
    let text = if js_trim(&text).is_empty() && !images.is_empty() {
        IMAGE_ONLY_TOOL_RESULT.to_owned()
    } else {
        text
    };
    if js_trim(&text).is_empty() {
        return Err(Error::other(format!(
            "Tool result for toolUseId \"{tool_use_id}\" has empty content. OpenAI requires tool messages to have non-empty content."
        )));
    }
    let content = match result.status {
        ToolResultStatus::Error => format!("[ERROR] {text}"),
        _ => text,
    };
    let message = object([
        ("role", "tool".into()),
        ("tool_call_id", tool_use_id.clone().into()),
        ("content", content.into()),
    ]);
    Ok((message, images))
}

fn format_assistant_message(content: &[ContentBlock]) -> Result<Option<JsonValue>> {
    let mut texts = Vec::new();
    let mut tool_calls = Vec::new();
    for block in content {
        match block {
            ContentBlock::Text(text) => texts.push(text.text.as_str()),
            ContentBlock::ToolUse(tool_use) => {
                let arguments = json_string(&tool_use.input)
                    .ok_or_else(|| Error::other(format!("Failed to serialize tool input for \"{}", tool_use.name)))?;
                tool_calls.push(object([
                    ("id", tool_use.tool_use_id.clone().into()),
                    ("type", "function".into()),
                    ("function", json!({"name": tool_use.name, "arguments": arguments})),
                ]));
            }
            ContentBlock::Reasoning(reasoning) => {
                if let Some(text) = reasoning.text.as_deref().filter(|text| !text.is_empty()) {
                    tracing::warn!(
                        "block_type=<reasoningBlock> | reasoning blocks not supported by openai | converting to text"
                    );
                    texts.push(text);
                }
            }
            ContentBlock::Unknown(_) => {}
            block => tracing::warn!(
                "block_type=<{}> | unsupported content type in openai assistant message | skipping",
                block_type(block)
            ),
        }
    }
    let text = js_trim(&texts.concat()).to_owned();
    if text.is_empty() && tool_calls.is_empty() {
        return Ok(None);
    }
    let mut message = JsonObject::new();
    message.insert("role".to_owned(), "assistant".into());
    message.insert("content".to_owned(), text.into());
    if !tool_calls.is_empty() {
        message.insert("tool_calls".to_owned(), JsonValue::Array(tool_calls));
    }
    Ok(Some(JsonValue::Object(message)))
}

/// Stream state of the Chat Completions adapter (`ChatStreamState` and the active tool calls).
#[derive(Debug, Default)]
pub(super) struct ChatStreamState {
    message_started: bool,
    text_content_block_started: bool,
    /// Indexes of tool calls whose block is open, in the order they started.
    active_tool_calls: Vec<u64>,
}

/// Maps one streamed chunk to SDK events.
pub(super) fn map_chat_chunk(chunk: &JsonValue, state: &mut ChatStreamState) -> Vec<ModelStreamEvent> {
    let mut events = Vec::new();
    let Some(choice) = chunk
        .get("choices")
        .and_then(JsonValue::as_array)
        .and_then(|choices| choices.first())
    else {
        return events;
    };
    if !choice.is_object() {
        tracing::warn!("choice=<{choice}> | invalid choice format in openai chunk");
        return events;
    }
    let delta = choice.get("delta").filter(|delta| is_truthy(Some(delta)));
    let finish_reason = choice.get("finish_reason").filter(|reason| is_truthy(Some(reason)));
    if delta.is_none() && finish_reason.is_none() {
        return events;
    }
    if let Some(delta) = delta {
        map_delta(delta, state, &mut events);
    }
    if let Some(finish_reason) = finish_reason {
        finish(finish_reason, state, &mut events);
    }
    events
}

fn map_delta(delta: &JsonValue, state: &mut ChatStreamState, events: &mut Vec<ModelStreamEvent>) {
    if let Some(role) = delta
        .get("role")
        .and_then(JsonValue::as_str)
        .filter(|role| !role.is_empty())
        && !state.message_started
    {
        state.message_started = true;
        let role = if role == "user" { Role::User } else { Role::Assistant };
        events.push(ModelMessageStartEvent::new(role).into());
    }
    if let Some(text) = delta
        .get("content")
        .and_then(JsonValue::as_str)
        .filter(|text| !text.is_empty())
    {
        if !state.text_content_block_started {
            state.text_content_block_started = true;
            events.push(ModelContentBlockStartEvent::new().into());
        }
        events.push(ModelContentBlockDeltaEvent::new(TextDelta::new(text)).into());
    }
    let tool_calls = delta.get("tool_calls").and_then(JsonValue::as_array);
    for tool_call in tool_calls.into_iter().flatten() {
        let Some(index) = tool_call.get("index").and_then(JsonValue::as_u64) else {
            tracing::warn!("tool_call=<{tool_call}> | received tool call with invalid index");
            continue;
        };
        let function = tool_call.get("function");
        let id = tool_call
            .get("id")
            .and_then(JsonValue::as_str)
            .filter(|id| !id.is_empty());
        let name = function
            .and_then(|function| function.get("name"))
            .and_then(JsonValue::as_str)
            .filter(|name| !name.is_empty());
        if let (Some(id), Some(name)) = (id, name) {
            // An open text block would swallow the tool call in aggregation, so it closes first.
            if state.text_content_block_started {
                state.text_content_block_started = false;
                events.push(ModelContentBlockStopEvent::new().into());
            }
            events.push(
                ModelContentBlockStartEvent::new()
                    .with_start(ToolUseStart::new(name, id))
                    .into(),
            );
            if !state.active_tool_calls.contains(&index) {
                state.active_tool_calls.push(index);
            }
        }
        let arguments = function
            .and_then(|function| function.get("arguments"))
            .and_then(JsonValue::as_str)
            .filter(|arguments| !arguments.is_empty());
        if let Some(arguments) = arguments {
            events.push(ModelContentBlockDeltaEvent::new(ToolUseInputDelta::new(arguments)).into());
        }
    }
}

fn finish(finish_reason: &JsonValue, state: &mut ChatStreamState, events: &mut Vec<ModelStreamEvent>) {
    if state.text_content_block_started {
        events.push(ModelContentBlockStopEvent::new().into());
        state.text_content_block_started = false;
    }
    for _ in state.active_tool_calls.drain(..) {
        events.push(ModelContentBlockStopEvent::new().into());
    }
    let finish_reason = finish_reason
        .as_str()
        .map_or_else(|| finish_reason.to_string(), str::to_owned);
    let stop_reason = match finish_reason.as_str() {
        "stop" => StopReason::EndTurn,
        "tool_calls" => StopReason::ToolUse,
        "length" => StopReason::MaxTokens,
        "content_filter" => StopReason::ContentFiltered,
        other => {
            let fallback = snake_to_camel(other);
            tracing::warn!(
                "finish_reason=<{other}>, fallback=<{fallback}> | unknown openai stop reason, using camelCase conversion as fallback"
            );
            StopReason::from(fallback)
        }
    };
    events.push(ModelMessageStopEvent::new(stop_reason).into());
}

/// `str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())`.
fn snake_to_camel(text: &str) -> String {
    let mut camel = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match chars.peek() {
            Some(next) if c == '_' && next.is_ascii_lowercase() => {
                camel.push(next.to_ascii_uppercase());
                chars.next();
            }
            _ => camel.push(c),
        }
    }
    camel
}
