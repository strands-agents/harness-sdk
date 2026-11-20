//! Agentic context management (experimental): the model compresses its own context with the
//! `summarize_context`, `truncate_context` and `pin_context` tools, and sees its context usage in
//! each request.
//!
//! Tools get a snapshot of the history, so each batch's tools edit a working copy of it (the
//! assistant message being answered joins it only after the batch), one tool at a time; the agent
//! installs the copy when the batch ends, before an interrupt stops the turn. Outside a model turn,
//! a direct call edits the history it was given, installed at the next appended message.

use std::sync::{Arc, LazyLock};

use futures::future::BoxFuture;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::Mutex;

use crate::agent::{InvocationContext, LocalAgent};
use crate::conversation_manager::compression::context_compression::{
    MessageTypeFilter, adjust_split_point_for_tool_pairs, find_valid_trim_point, generate_summary, matches_message_type,
};
use crate::conversation_manager::compression::pin_message::{is_pinned, pin_message, unpin_message};
use crate::conversation_manager::compression::token_usage::token_usage_middleware;
use crate::error::Error;
use crate::hooks::{AfterToolsEvent, BeforeToolsEvent, HookCallbackOptions, HookOrder, MessageAddedEvent};
use crate::models::Model;
use crate::tools::{SchemaValidator, Tool, ToolContext, ToolError, ToolOutcome, ToolStream, wrap_in_tool_result};
use crate::types::{ContentBlock, JsonValue, Message, Role, ToolSpec};

const DEFAULT_KEEP_RECENT_MESSAGES: usize = 10;
const DEFAULT_SUMMARY_RATIO: f64 = 0.3;
const MIN_SUMMARY_RATIO: f64 = 0.1;
const MAX_SUMMARY_RATIO: f64 = 0.8;
const MIN_MESSAGES_FOR_COMPRESSION: usize = 2;

/// The `messageType` filter of the compression tools.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MessageType {
    Tools,
    Messages,
    #[default]
    All,
}

impl MessageType {
    fn filter(self) -> MessageTypeFilter {
        match self {
            Self::Tools => MessageTypeFilter::Tools,
            Self::Messages => MessageTypeFilter::Messages,
            Self::All => MessageTypeFilter::All,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Tools => "\"tools\" ",
            Self::Messages => "\"messages\" ",
            Self::All => "",
        }
    }

    fn scope(self) -> &'static str {
        match self {
            Self::Tools => "\"tools\"",
            Self::Messages => "\"messages\"",
            Self::All => "eligible",
        }
    }
}

fn message_type_schema() -> JsonValue {
    json!({
        "type": "string",
        "enum": ["tools", "messages", "all"],
        "description": "Filter which messages to target. \"tools\" targets only tool use/result messages, \"messages\" targets only non-tool messages, \"all\" (default) targets everything."
    })
}

/// The messages in `0..range_end` a compression may remove and the ones it keeps, in order. The
/// first user message is always kept so the conversation still starts with one.
fn collect_preserved(
    messages: &[Message],
    range_end: usize,
    filter: MessageTypeFilter,
) -> (Vec<Message>, Vec<Message>) {
    let mut eligible = Vec::new();
    let mut preserved = Vec::new();
    let mut found_first_user = false;
    for (index, message) in messages.iter().enumerate().take(range_end) {
        let is_first_user = !found_first_user && message.role == Role::User;
        found_first_user |= is_first_user;
        if is_first_user || is_pinned(messages, index) || !matches_message_type(message, filter) {
            preserved.push(message.clone());
        } else {
            eligible.push(message.clone());
        }
    }
    (eligible, preserved)
}

/// The `summarize_context` input.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SummarizeContextInput {
    pub(crate) keep_recent: Option<usize>,
    pub(crate) summary_ratio: Option<f64>,
    pub(crate) message_type: Option<MessageType>,
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "message counts are small and the floored values are non-negative"
)]
/// Folds the oldest messages into a summary (the `summarize_context` callback).
pub(crate) async fn summarize_context(
    messages: &mut Vec<Message>,
    model: &Arc<dyn Model>,
    input: SummarizeContextInput,
    invocation_context: Option<&InvocationContext>,
) -> String {
    let original = messages.len();
    let message_type = input.message_type.unwrap_or_default();
    let preserve_recent = input.keep_recent.unwrap_or(DEFAULT_KEEP_RECENT_MESSAGES);
    let ratio = input
        .summary_ratio
        .unwrap_or(DEFAULT_SUMMARY_RATIO)
        .clamp(MIN_SUMMARY_RATIO, MAX_SUMMARY_RATIO);
    let split_point = ((original as f64 * ratio).floor() as usize).max(1);
    let split_point = split_point.min(original.saturating_sub(preserve_recent));
    if split_point == 0 {
        return format!(
            "No summarization performed: not enough eligible messages to compress (conversation has {original} messages, preserving recent {preserve_recent})."
        );
    }
    let Ok(split_point) = adjust_split_point_for_tool_pairs(messages, split_point) else {
        return format!(
            "No summarization performed: no valid split boundary found from index {split_point} onward (requires a message that isn't mid-tool-call). Try a smaller keepRecent, a larger summaryRatio, or use truncate_context with messageType=\"tools\" instead."
        );
    };
    let (eligible, preserved) = collect_preserved(messages, split_point, message_type.filter());
    if eligible.is_empty() {
        return format!(
            "No summarization performed: no {} messages found in range (conversation has {original} messages).",
            message_type.scope()
        );
    }
    let auxiliary = InvocationContext::auxiliary(invocation_context);
    let summary = match generate_summary(&eligible, model, None, auxiliary.as_ref()).await {
        Ok(summary) => summary,
        Err(error) => return format!("Summarization failed: {error}"),
    };
    messages.splice(0..split_point, preserved.into_iter().chain([summary]));
    let removed = original as i64 - messages.len() as i64;
    format!(
        "Summarized {} {}message(s). Removed {removed} message(s), {} remaining.",
        eligible.len(),
        message_type.label(),
        messages.len()
    )
}

/// The `truncate_context` input.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TruncateContextInput {
    pub(crate) keep_recent: Option<usize>,
    pub(crate) message_type: Option<MessageType>,
}

/// Drops the oldest messages (the `truncate_context` callback).
pub(crate) fn truncate_context(messages: &mut Vec<Message>, input: &TruncateContextInput) -> String {
    let original = messages.len();
    let message_type = input.message_type.unwrap_or_default();
    let window_size = input.keep_recent.unwrap_or(DEFAULT_KEEP_RECENT_MESSAGES);
    if original <= MIN_MESSAGES_FOR_COMPRESSION || original <= window_size {
        return format!("No messages dropped: conversation only has {original} messages.");
    }
    let start_index = original - window_size;
    let trim_point = find_valid_trim_point(messages, start_index);
    if trim_point >= original {
        return format!(
            "No messages dropped: no valid trim boundary exists between index {start_index} and {} (requires a plain user text message). Try a larger keepRecent or use summarize_context instead.",
            original - 1
        );
    }
    let (eligible, preserved) = collect_preserved(messages, trim_point, message_type.filter());
    if eligible.is_empty() {
        return format!(
            "No messages dropped: no {} messages found in range (conversation has {original} messages).",
            message_type.scope()
        );
    }
    messages.splice(0..trim_point, preserved);
    format!(
        "Dropped {} {}message(s). {} remaining.",
        original - messages.len(),
        message_type.label(),
        messages.len()
    )
}

/// Which messages `pin_context` targets.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub(crate) enum PinSelect {
    /// `"last_turn"`.
    Turn(LastTurn),
    /// The last N messages.
    Last(usize),
    /// Zero-based indices.
    Indices(Vec<usize>),
}

/// The `"last_turn"` selector.
#[derive(Debug, Clone, Copy, Deserialize)]
pub(crate) enum LastTurn {
    #[serde(rename = "last_turn")]
    LastTurn,
}

/// The `pin_context` filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PinFilter {
    User,
    Assistant,
    Tools,
}

/// Pin or unpin.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PinAction {
    #[default]
    Pin,
    Unpin,
}

/// The `pin_context` input.
#[derive(Debug, Deserialize)]
pub(crate) struct PinContextInput {
    pub(crate) select: PinSelect,
    #[serde(default)]
    pub(crate) filter: Option<PinFilter>,
    #[serde(default)]
    pub(crate) action: PinAction,
}

fn has_text(message: &Message) -> bool {
    message
        .content
        .iter()
        .any(|block| matches!(block, ContentBlock::Text(_)))
}

fn matches_pin_filter(message: &Message, filter: PinFilter) -> bool {
    match filter {
        PinFilter::User => message.role == Role::User && has_text(message),
        PinFilter::Assistant => message.role == Role::Assistant && has_text(message),
        PinFilter::Tools => message
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::ToolUse(_) | ContentBlock::ToolResult(_))),
    }
}

/// Pins or unpins messages (the `pin_context` callback).
pub(crate) fn pin_context(messages: &mut [Message], input: &PinContextInput) -> String {
    if messages.is_empty() {
        return "No messages in the conversation.".to_owned();
    }
    let count = messages.len();
    let candidates: Vec<usize> = match &input.select {
        PinSelect::Turn(_) => {
            let mut indices = Vec::new();
            for index in (0..count).rev() {
                indices.push(index);
                let message = &messages[index];
                if message.role == Role::User && has_text(message) {
                    break;
                }
            }
            indices
        }
        PinSelect::Last(last) => (0..(*last).min(count)).map(|offset| count - 1 - offset).collect(),
        PinSelect::Indices(indices) => {
            let in_range: Vec<usize> = indices.iter().copied().filter(|&index| index < count).collect();
            if in_range.is_empty() {
                return format!("All indices out of range (conversation has {count} messages).");
            }
            in_range
        }
    };
    let targets: Vec<usize> = match input.filter {
        Some(filter) => candidates
            .into_iter()
            .filter(|&index| matches_pin_filter(&messages[index], filter))
            .collect(),
        None => candidates,
    };
    if targets.is_empty() {
        return "No matching messages found.".to_owned();
    }
    for &index in &targets {
        match input.action {
            PinAction::Pin => pin_message(messages, index),
            PinAction::Unpin => unpin_message(messages, index),
        }
    }
    let verb = match input.action {
        PinAction::Pin => "Pinned",
        PinAction::Unpin => "Unpinned",
    };
    format!("{verb} {} message(s).", targets.len())
}

/// The history the batch's tools edit, and where it goes back.
struct Batch {
    base_len: usize,
    /// The tracking id of the last message the copy started from, to detect a changed history.
    last: Option<String>,
    /// The assistant message of the tool batch; `None` for a direct call outside a model turn.
    anchor: Option<String>,
    working: Vec<Message>,
    dirty: bool,
}

impl Batch {
    fn new(snapshot: Vec<Message>, anchor: Option<String>) -> Self {
        Self {
            base_len: snapshot.len(),
            last: snapshot.last().map(|message| message.tracking_id().to_owned()),
            anchor,
            working: snapshot,
            dirty: false,
        }
    }
}

/// The shared working copy of the agentic tools of one agent.
#[derive(Clone, Default)]
pub(crate) struct AgenticContext {
    batch: Arc<Mutex<Option<Batch>>>,
}

impl std::fmt::Debug for AgenticContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgenticContext").finish_non_exhaustive()
    }
}

type Operation = Arc<
    dyn for<'a> Fn(&'a mut Vec<Message>, JsonValue, &'a ToolContext) -> BoxFuture<'a, Result<String, ToolError>>
        + Send
        + Sync,
>;

struct AgenticTool {
    spec: ToolSpec,
    validator: Option<Arc<SchemaValidator>>,
    context: AgenticContext,
    operation: Operation,
}

impl AgenticTool {
    fn new(name: &str, description: &str, schema: JsonValue, context: AgenticContext, operation: Operation) -> Self {
        Self {
            validator: SchemaValidator::new(&schema).ok().map(Arc::new),
            spec: ToolSpec::new(name, description).with_input_schema(schema),
            context,
            operation,
        }
    }
}

async fn run_agentic(
    context: AgenticContext,
    validator: Option<Arc<SchemaValidator>>,
    operation: Operation,
    tool_context: ToolContext,
) -> ToolOutcome {
    let tool_use_id = tool_context.tool_use().tool_use_id.clone();
    let input = tool_context.tool_use().input.clone();
    if let Some(Err(error)) = validator.as_ref().map(|validator| validator.validate(&input)) {
        return ToolError::new(error).into_outcome(tool_use_id);
    }
    let mut guard = context.batch.lock().await;
    let batch = guard.get_or_insert_with(|| Batch::new(tool_context.agent().messages().to_vec(), None));
    let before = batch.working.clone();
    let result = operation(&mut batch.working, input, &tool_context).await;
    if batch.working != before {
        batch.dirty = true;
    }
    match result {
        Ok(text) => wrap_in_tool_result(JsonValue::String(text), tool_use_id).into(),
        Err(error) => error.into_outcome(tool_use_id),
    }
}

impl Tool for AgenticTool {
    fn name(&self) -> &str {
        &self.spec.name
    }

    fn description(&self) -> &str {
        &self.spec.description
    }

    fn tool_spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    fn stream(&self, context: ToolContext) -> ToolStream {
        ToolStream::from_future(run_agentic(
            self.context.clone(),
            self.validator.clone(),
            self.operation.clone(),
            context,
        ))
    }
}

fn parse<T: serde::de::DeserializeOwned>(input: JsonValue) -> Result<T, ToolError> {
    serde_json::from_value(input).map_err(ToolError::new)
}

static SUMMARIZE_SCHEMA: LazyLock<JsonValue> = LazyLock::new(|| {
    json!({
        "type": "object",
        "properties": {
            "keepRecent": {
                "type": "integer",
                "minimum": MIN_MESSAGES_FOR_COMPRESSION,
                "description": format!("Minimum number of recent messages to preserve verbatim. Defaults to {DEFAULT_KEEP_RECENT_MESSAGES}.")
            },
            "summaryRatio": {
                "type": "number",
                "minimum": MIN_SUMMARY_RATIO,
                "maximum": MAX_SUMMARY_RATIO,
                "description": format!("Fraction of the oldest messages to fold into the summary ({MIN_SUMMARY_RATIO}–{MAX_SUMMARY_RATIO}). Defaults to {DEFAULT_SUMMARY_RATIO}.")
            },
            "messageType": message_type_schema()
        },
        "additionalProperties": false
    })
});

static TRUNCATE_SCHEMA: LazyLock<JsonValue> = LazyLock::new(|| {
    json!({
        "type": "object",
        "properties": {
            "keepRecent": {
                "type": "integer",
                "minimum": MIN_MESSAGES_FOR_COMPRESSION,
                "description": format!("Number of most recent messages to keep. Everything older (and unpinned) is dropped. Defaults to {DEFAULT_KEEP_RECENT_MESSAGES}.")
            },
            "messageType": message_type_schema()
        },
        "additionalProperties": false
    })
});

static PIN_SCHEMA: LazyLock<JsonValue> = LazyLock::new(|| {
    json!({
        "type": "object",
        "properties": {
            "select": {
                "anyOf": [
                    {"type": "string", "const": "last_turn", "description": "Select messages from the current turn (everything since the last user request)."},
                    {"type": "integer", "minimum": 1, "description": "Select the last N messages from the conversation."},
                    {"type": "array", "items": {"type": "integer", "minimum": 0}, "minItems": 1, "description": "Select messages at specific zero-based indices."}
                ],
                "description": "Which messages to target. \"last_turn\" for the current exchange, a number for the last N messages, or an array of indices."
            },
            "filter": {
                "type": "string",
                "enum": ["user", "assistant", "tools"],
                "description": "Narrow the selection to only messages matching this filter. \"user\" matches user text messages, \"assistant\" matches assistant text responses, \"tools\" matches tool call and tool result messages (pairs are always kept together)."
            },
            "action": {
                "default": "pin",
                "type": "string",
                "enum": ["pin", "unpin"],
                "description": "Whether to pin or unpin the selected messages."
            }
        },
        "required": ["select"],
        "additionalProperties": false
    })
});

impl AgenticContext {
    /// The `summarize_context`, `truncate_context` and `pin_context` tools.
    pub(crate) fn tools(&self) -> Vec<Arc<dyn Tool>> {
        let summarize: Operation = Arc::new(|messages, input, context| {
            Box::pin(async move {
                let input: SummarizeContextInput = parse(input)?;
                let model = context.agent().aux_model().clone();
                Ok(summarize_context(messages, &model, input, context.invocation_context()).await)
            })
        });
        let truncate: Operation =
            Arc::new(|messages, input, _| Box::pin(async move { Ok(truncate_context(messages, &parse(input)?)) }));
        let pin: Operation =
            Arc::new(|messages, input, _| Box::pin(async move { Ok(pin_context(messages, &parse(input)?)) }));
        vec![
            Arc::new(AgenticTool::new(
                "summarize_context",
                "Compress the oldest messages in your conversation into a concise summary to free up context space. The summary preserves key information while reducing token usage. Recent messages are kept verbatim. Pinned messages are never summarized away. Often most useful with messageType \"messages\" to preserve tool results verbatim while condensing discussion.",
                SUMMARIZE_SCHEMA.clone(),
                self.clone(),
                summarize,
            )),
            Arc::new(AgenticTool::new(
                "truncate_context",
                "Drop the oldest messages from your conversation history entirely to free up context space. Use this when older messages are no longer relevant and do not need to be preserved in any form. Pinned messages are always kept. Tool-call pairs are preserved together. Often most useful with messageType \"tools\" since tool results tend to be large and lose relevance quickly.",
                TRUNCATE_SCHEMA.clone(),
                self.clone(),
                truncate,
            )),
            Arc::new(AgenticTool::new(
                "pin_context",
                "Pin or unpin messages in the conversation history. Pinned messages are protected from eviction during context reduction (summarize or truncate). Best for critical context like user-established constraints or key facts that must survive compression. Pin sparingly — too many pinned messages limit what can be compressed. Select messages using relative references: pin the current exchange, the last N messages, or specific indices.",
                PIN_SCHEMA.clone(),
                self.clone(),
                pin,
            )),
        ]
    }

    /// Registers the working-copy hooks and the token usage middleware.
    pub(crate) fn register(&self, agent: &LocalAgent) {
        let batch = self.batch.clone();
        agent.add_async_hook::<BeforeToolsEvent<'_>>(move |event| {
            let batch = batch.clone();
            Box::pin(async move {
                let anchor = event.message().tracking_id().to_owned();
                let snapshot = event.agent().messages().to_vec();
                *batch.lock().await = Some(Batch::new(snapshot, Some(anchor)));
            })
        });
        let batch = self.batch.clone();
        agent.add_async_hook_with::<AfterToolsEvent<'_>>(
            move |event| {
                let batch = batch.clone();
                Box::pin(async move {
                    install(&batch, event.agent_mut(), Install::BatchEnd).await;
                    Ok::<(), Error>(())
                })
            },
            HookCallbackOptions {
                order: HookOrder::SDK_FIRST,
            },
        );
        let batch = self.batch.clone();
        agent.add_async_hook_with::<MessageAddedEvent<'_>>(
            move |event| {
                let batch = batch.clone();
                Box::pin(async move {
                    install(&batch, event.agent_mut(), Install::MessageAdded).await;
                    Ok::<(), Error>(())
                })
            },
            HookCallbackOptions {
                order: HookOrder::SDK_FIRST,
            },
        );
        agent.add_middleware(token_usage_middleware());
    }
}

/// When the working copy goes back into the history.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Install {
    /// A tool batch ended: its copy, before the assistant message and results are appended or an
    /// interrupt stops the turn, so a resumed or restored turn keeps the edits.
    BatchEnd,
    /// A message was appended: the copy of a direct call outside a model turn.
    MessageAdded,
}

/// Installs the working copy over the prefix of the history it was taken from.
async fn install(batch: &Mutex<Option<Batch>>, agent: &mut LocalAgent, when: Install) {
    let mut guard = batch.lock().await;
    let applies = guard
        .as_ref()
        .is_some_and(|batch| batch.anchor.is_some() == (when == Install::BatchEnd));
    if !applies {
        return;
    }
    let Some(batch) = guard.take() else {
        return;
    };
    if !batch.dirty {
        return;
    }
    let messages = agent.messages_mut();
    let unchanged = batch.base_len <= messages.len()
        && batch.last.as_deref()
            == batch
                .base_len
                .checked_sub(1)
                .and_then(|index| messages.get(index))
                .map(Message::tracking_id);
    if !unchanged {
        tracing::warn!("history changed during the tool batch | discarding the agentic context edits");
        return;
    }
    messages.splice(0..batch.base_len, batch.working);
}

#[cfg(test)]
#[path = "agentic/tests.rs"]
mod tests;
