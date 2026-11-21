//! Message and system prompt shapes the tracer records.

use serde::Serialize;
use serde_json::json;

use crate::types::{
    ContentBlock, GuardContentBlock, JsonValue, Message, ReasoningBlock, Role, SystemContentBlock, SystemPrompt,
};

/// Stands in for binary data in attribute JSON.
const REPLACED: &str = "<replaced>";

/// Serializes a value for an attribute. The SDK's types always serialize; a failure records an
/// empty string rather than failing the span.
pub(crate) fn to_json<T: Serialize + ?Sized>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|error| {
        tracing::warn!("error=<{error}> | failed to serialize telemetry attribute");
        String::new()
    })
}

/// The `type` discriminator of a block.
pub(crate) fn block_type(block: &ContentBlock) -> &'static str {
    match block {
        ContentBlock::Text(_) => "textBlock",
        ContentBlock::ToolUse(_) => "toolUseBlock",
        ContentBlock::ToolResult(_) => "toolResultBlock",
        ContentBlock::Reasoning(_) => "reasoningBlock",
        ContentBlock::CachePoint(_) => "cachePointBlock",
        ContentBlock::GuardContent(_) => "guardContentBlock",
        ContentBlock::Audio(_) => "audioBlock",
        ContentBlock::Image(_) => "imageBlock",
        ContentBlock::Video(_) => "videoBlock",
        ContentBlock::Document(_) => "documentBlock",
        ContentBlock::Citations(_) => "citationsBlock",
        ContentBlock::Injected(_) => "injectedBlock",
        ContentBlock::Summary(_) => "summaryBlock",
        ContentBlock::Unknown(_) => "unknownBlock",
    }
}

/// The reasoning text a trace keeps; the signature and redacted content are never exported.
fn reasoning_text(reasoning: &ReasoningBlock) -> Option<&str> {
    reasoning.text.as_deref().filter(|text| !text.is_empty())
}

/// A block in the latest-convention parts format.
fn otel_part(block: &ContentBlock) -> JsonValue {
    match block {
        ContentBlock::Text(text) => json!({"type": "text", "content": text.text}),
        ContentBlock::Injected(injected) => json!({"type": "text", "content": injected.text}),
        ContentBlock::Summary(summary) => json!({"type": "text", "content": summary.text}),
        ContentBlock::ToolUse(tool_use) => json!({
            "type": "tool_call",
            "name": tool_use.name,
            "id": tool_use.tool_use_id,
            "arguments": tool_use.input,
        }),
        ContentBlock::ToolResult(result) => json!({
            "type": "tool_call_response",
            "id": result.tool_use_id,
            "response": result.content,
        }),
        ContentBlock::Reasoning(reasoning) => match reasoning_text(reasoning) {
            Some(text) => json!({"type": "reasoning", "content": text}),
            None => json!({"type": block_type(block)}),
        },
        other => json!({"type": block_type(other)}),
    }
}

/// Blocks in the latest-convention parts format.
pub(crate) fn otel_parts(blocks: &[ContentBlock]) -> Vec<JsonValue> {
    blocks.iter().map(otel_part).collect()
}

/// Messages in the latest-convention `gen_ai.input.messages` format.
pub(crate) fn otel_messages(messages: &[Message]) -> Vec<JsonValue> {
    messages
        .iter()
        .map(|message| json!({"role": message.role, "parts": otel_parts(&message.content)}))
        .collect()
}

/// Blocks in the minimal stable format; other block types are left out.
pub(crate) fn stable_parts(blocks: &[ContentBlock]) -> Vec<JsonValue> {
    blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text(text) => Some(json!({"text": text.text})),
            ContentBlock::ToolUse(tool_use) => Some(json!({
                "type": "toolUse",
                "name": tool_use.name,
                "toolUseId": tool_use.tool_use_id,
                "input": tool_use.input,
            })),
            ContentBlock::ToolResult(result) => Some(json!({
                "type": "toolResult",
                "toolUseId": result.tool_use_id,
                "content": result.content,
            })),
            ContentBlock::Reasoning(reasoning) => {
                reasoning_text(reasoning).map(|text| json!({"type": "reasoning", "text": text}))
            }
            _ => None,
        })
        .collect()
}

fn guard_part(block: &GuardContentBlock) -> JsonValue {
    match block {
        GuardContentBlock::Text(text) => json!({"type": "guard_content", "text": text}),
        GuardContentBlock::Image(image) => {
            let mut image = serde_json::to_value(image).unwrap_or(JsonValue::Null);
            if let Some(bytes) = image.pointer_mut("/source/bytes") {
                *bytes = JsonValue::from(REPLACED);
            }
            json!({"type": "guard_content", "image": image})
        }
    }
}

/// A system prompt in the latest-convention parts format (`gen_ai.system_instructions`).
pub(crate) fn system_prompt_otel_parts(system_prompt: &SystemPrompt) -> Vec<JsonValue> {
    match system_prompt {
        SystemPrompt::Text(text) => vec![json!({"type": "text", "content": text})],
        SystemPrompt::Blocks(blocks) => blocks
            .iter()
            .map(|block| match block {
                SystemContentBlock::Text(text) => json!({"type": "text", "content": text.text}),
                SystemContentBlock::CachePoint(cache_point) => {
                    json!({"type": "cache_point", "cacheType": cache_point.cache_type})
                }
                SystemContentBlock::GuardContent(guard) => guard_part(guard),
            })
            .collect(),
    }
}

/// A system prompt in the stable `gen_ai.system.message` format: a string becomes one text block.
pub(crate) fn system_prompt_stable(system_prompt: &SystemPrompt) -> String {
    match system_prompt {
        SystemPrompt::Text(text) => to_json(&json!([{"text": text}])),
        other => to_json(other),
    }
}

/// The stable event name of a message.
pub(crate) fn event_name_for_message(message: &Message) -> &'static str {
    let has_tool_result = message
        .content
        .iter()
        .any(|block| matches!(block, ContentBlock::ToolResult(_)));
    match message.role {
        Role::User if has_tool_result => "gen_ai.tool.message",
        Role::User => "gen_ai.user.message",
        Role::Assistant => "gen_ai.assistant.message",
    }
}

/// The text blocks of a message joined by newlines, the agent span's response text.
pub(crate) fn message_text(message: &Message) -> String {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text(text) => Some(text.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}
