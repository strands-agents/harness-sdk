//! The serializable records of hook events that an agent stream yields (`AgentStreamEvent`).

use serde::de::Error as _;
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::events::{
    AfterInvocationEvent, AfterModelCallEvent, AfterToolCallEvent, AfterToolsEvent, AgentResultEvent,
    BeforeInvocationEvent, BeforeModelCallEvent, BeforeToolCallEvent, BeforeToolsEvent, ContentBlockEvent,
    InitializedEvent, InterruptEvent, MessageAddedEvent, ModelMessageEvent, ModelStopResponse, ModelStreamUpdateEvent,
    ToolResultEvent, ToolStreamUpdateEvent,
};
use crate::agent::AgentResult;
use crate::interrupt::Interrupt;
use crate::models::streaming::{ContentBlockDelta, ModelStreamEvent};
use crate::tools::ToolStreamEvent;
use crate::types::{ContentBlock, JsonValue, Message, StopReason, ToolResultBlock, ToolUse};

/// The message of an error on an event record.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ErrorData {
    /// The error message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl ErrorData {
    /// Creates the record of an error message.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: Some(message.into()),
        }
    }
}

/// Serializes a tool result in its content-block form, `{"toolResult": {...}}`.
mod wrapped_result {
    use super::*;

    pub(super) fn serialize<S: Serializer>(result: &ToolResultBlock, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(1))?;
        map.serialize_entry("toolResult", result)?;
        map.end()
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<ToolResultBlock, D::Error> {
        match ContentBlock::deserialize(deserializer)? {
            ContentBlock::ToolResult(result) => Ok(result),
            _ => Err(D::Error::custom("expected a toolResult block")),
        }
    }
}

macro_rules! record {
    (
        $(#[$doc:meta])*
        $name:ident = $tag:literal {
            $($(#[$field_attr:meta])* $field:ident: $ty:ty),* $(,)?
        }
        $(optional {
            $($(#[$opt_attr:meta])* $opt:ident: $opt_ty:ty => $setter:ident),* $(,)?
        })?
    ) => {
        $(#[$doc])*
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        #[serde(tag = "type", rename = $tag, rename_all = "camelCase")]
        #[non_exhaustive]
        pub struct $name {
            $($(#[$field_attr])* pub $field: $ty,)*
            $($(
                $(#[$opt_attr])*
                #[serde(default, skip_serializing_if = "Option::is_none")]
                pub $opt: Option<$opt_ty>,
            )*)?
        }

        impl $name {
            /// Creates the record from its required fields; the optional ones start unset.
            #[allow(clippy::new_without_default, reason = "a record with no required fields is built through `new`, like the others")]
            pub fn new($($field: $ty),*) -> Self {
                Self { $($field,)* $($($opt: None,)*)? }
            }

            $($(
                #[doc = concat!("Sets `", stringify!($opt), "`.")]
                #[must_use]
                pub fn $setter(mut self, $opt: $opt_ty) -> Self {
                    self.$opt = Some($opt);
                    self
                }
            )*)?
        }
    };
}

record! {
    /// Record of an [`InitializedEvent`]: `{"type":"initializedEvent"}`. Not a stream item; the
    /// event fires at construction.
    InitializedEventData = "initializedEvent" {}
}

record! {
    /// Record of a [`BeforeInvocationEvent`]: `{"type":"beforeInvocationEvent"}`.
    BeforeInvocationEventData = "beforeInvocationEvent" {}
}

record! {
    /// Record of an [`AfterInvocationEvent`]: `{"type":"afterInvocationEvent"}`.
    AfterInvocationEventData = "afterInvocationEvent" {}
}

record! {
    /// Record of a [`MessageAddedEvent`].
    MessageAddedEventData = "messageAddedEvent" {
        /// The added message.
        message: Message,
    }
}

record! {
    /// Record of a [`BeforeToolCallEvent`].
    BeforeToolCallEventData = "beforeToolCallEvent" {
        /// The tool use about to run.
        tool_use: ToolUse,
    }
}

record! {
    /// Record of an [`AfterToolCallEvent`].
    AfterToolCallEventData = "afterToolCallEvent" {
        /// The tool use that ran.
        tool_use: ToolUse,
        /// The tool result.
        #[serde(with = "wrapped_result")]
        result: ToolResultBlock,
    }
    optional {
        /// The error the tool failed with.
        error: ErrorData => with_error,
    }
}

record! {
    /// Record of a [`BeforeModelCallEvent`].
    BeforeModelCallEventData = "beforeModelCallEvent" {}
    optional {
        /// The projected input tokens of the call.
        projected_input_tokens: u64 => with_projected_input_tokens,
    }
}

record! {
    /// Record of an [`AfterModelCallEvent`].
    AfterModelCallEventData = "afterModelCallEvent" {
        /// The 1-based model attempt within the turn.
        attempt_count: u32,
    }
    optional {
        /// The model's response, when the call succeeded.
        stop_data: ModelStopResponse => with_stop_data,
        /// The error the call failed with.
        error: ErrorData => with_error,
    }
}

record! {
    /// Record of a [`ModelStreamUpdateEvent`].
    ModelStreamUpdateEventData = "modelStreamUpdateEvent" {
        /// The model stream event.
        event: ModelStreamEvent,
    }
}

record! {
    /// Record of a [`ContentBlockEvent`].
    ContentBlockEventData = "contentBlockEvent" {
        /// The finished block.
        content_block: ContentBlock,
    }
}

record! {
    /// Record of a [`ModelMessageEvent`].
    ModelMessageEventData = "modelMessageEvent" {
        /// The assembled message.
        message: Message,
        /// Why the model stopped.
        stop_reason: StopReason,
    }
}

record! {
    /// Record of a [`ToolResultEvent`].
    ToolResultEventData = "toolResultEvent" {
        /// The result.
        #[serde(with = "wrapped_result")]
        result: ToolResultBlock,
    }
}

record! {
    /// Record of a [`ToolStreamUpdateEvent`].
    ToolStreamUpdateEventData = "toolStreamUpdateEvent" {
        /// The tool's progress event.
        event: ToolStreamEvent,
    }
}

record! {
    /// Record of an [`InterruptEvent`].
    InterruptEventData = "interruptEvent" {
        /// The interrupt.
        interrupt: Interrupt,
    }
}

record! {
    /// Record of a [`BeforeToolsEvent`].
    BeforeToolsEventData = "beforeToolsEvent" {
        /// The assistant message with the tool uses.
        message: Message,
    }
}

record! {
    /// Record of an [`AfterToolsEvent`].
    AfterToolsEventData = "afterToolsEvent" {
        /// The user message with the tool results.
        message: Message,
    }
}

impl ModelStreamUpdateEventData {
    /// The text of a text delta event.
    #[must_use]
    pub fn text_delta(&self) -> Option<&str> {
        match &self.event {
            ModelStreamEvent::ContentBlockDelta(delta) => match &delta.delta {
                ContentBlockDelta::Text(text) => Some(&text.text),
                _ => None,
            },
            _ => None,
        }
    }
}

/// One item of an agent stream (`AgentStreamEvent`): the record of a hook event.
///
/// Hook callbacks receive the live events; the stream yields these owned records. Serialization
/// writes the stream-event JSON shared with the other Strands SDKs, and the records read it back.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum AgentStreamEvent {
    /// A model stream event.
    ModelStreamUpdate(ModelStreamUpdateEventData),
    /// A finished content block.
    ContentBlock(ContentBlockEventData),
    /// A finished model message.
    ModelMessage(ModelMessageEventData),
    /// A tool progress event.
    ToolStreamUpdate(ToolStreamUpdateEventData),
    /// A tool result.
    ToolResult(ToolResultEventData),
    /// The invocation started.
    BeforeInvocation(BeforeInvocationEventData),
    /// The invocation ended.
    AfterInvocation(AfterInvocationEventData),
    /// A model call is starting.
    BeforeModelCall(BeforeModelCallEventData),
    /// A model call ended.
    AfterModelCall(AfterModelCallEventData),
    /// A tool batch is starting.
    BeforeTools(BeforeToolsEventData),
    /// A tool batch ended.
    AfterTools(AfterToolsEventData),
    /// A tool call is starting.
    BeforeToolCall(BeforeToolCallEventData),
    /// A tool call ended.
    AfterToolCall(AfterToolCallEventData),
    /// A message was added to the history.
    MessageAdded(MessageAddedEventData),
    /// The agent stopped for an interrupt.
    Interrupt(InterruptEventData),
    /// The final result, `{"type":"agentResultEvent","result":{...}}`.
    AgentResult(AgentResult),
}

impl AgentStreamEvent {
    /// The `type` tag of the record, such as `"beforeInvocationEvent"`.
    #[must_use]
    pub fn event_type(&self) -> &'static str {
        match self {
            Self::ModelStreamUpdate(_) => "modelStreamUpdateEvent",
            Self::ContentBlock(_) => "contentBlockEvent",
            Self::ModelMessage(_) => "modelMessageEvent",
            Self::ToolStreamUpdate(_) => "toolStreamUpdateEvent",
            Self::ToolResult(_) => "toolResultEvent",
            Self::BeforeInvocation(_) => "beforeInvocationEvent",
            Self::AfterInvocation(_) => "afterInvocationEvent",
            Self::BeforeModelCall(_) => "beforeModelCallEvent",
            Self::AfterModelCall(_) => "afterModelCallEvent",
            Self::BeforeTools(_) => "beforeToolsEvent",
            Self::AfterTools(_) => "afterToolsEvent",
            Self::BeforeToolCall(_) => "beforeToolCallEvent",
            Self::AfterToolCall(_) => "afterToolCallEvent",
            Self::MessageAdded(_) => "messageAddedEvent",
            Self::Interrupt(_) => "interruptEvent",
            Self::AgentResult(_) => "agentResultEvent",
        }
    }
}

#[derive(Serialize)]
struct AgentResultRecord<'a> {
    #[serde(rename = "type")]
    tag: &'static str,
    result: &'a AgentResult,
}

impl Serialize for AgentStreamEvent {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::ModelStreamUpdate(data) => data.serialize(serializer),
            Self::ContentBlock(data) => data.serialize(serializer),
            Self::ModelMessage(data) => data.serialize(serializer),
            Self::ToolStreamUpdate(data) => data.serialize(serializer),
            Self::ToolResult(data) => data.serialize(serializer),
            Self::BeforeInvocation(data) => data.serialize(serializer),
            Self::AfterInvocation(data) => data.serialize(serializer),
            Self::BeforeModelCall(data) => data.serialize(serializer),
            Self::AfterModelCall(data) => data.serialize(serializer),
            Self::BeforeTools(data) => data.serialize(serializer),
            Self::AfterTools(data) => data.serialize(serializer),
            Self::BeforeToolCall(data) => data.serialize(serializer),
            Self::AfterToolCall(data) => data.serialize(serializer),
            Self::MessageAdded(data) => data.serialize(serializer),
            Self::Interrupt(data) => data.serialize(serializer),
            Self::AgentResult(result) => AgentResultRecord {
                tag: "agentResultEvent",
                result,
            }
            .serialize(serializer),
        }
    }
}

#[derive(Deserialize)]
struct AgentResultRecordOwned {
    result: AgentResult,
}

fn parse<T: serde::de::DeserializeOwned>(value: JsonValue) -> Result<T, serde_json::Error> {
    serde_json::from_value(value)
}

impl<'de> Deserialize<'de> for AgentStreamEvent {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = JsonValue::deserialize(deserializer)?;
        let tag = value
            .get("type")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| D::Error::custom("agent stream event must have a string type"))?
            .to_owned();
        let event = match tag.as_str() {
            "modelStreamUpdateEvent" => parse(value).map(Self::ModelStreamUpdate),
            "contentBlockEvent" => parse(value).map(Self::ContentBlock),
            "modelMessageEvent" => parse(value).map(Self::ModelMessage),
            "toolStreamUpdateEvent" => parse(value).map(Self::ToolStreamUpdate),
            "toolResultEvent" => parse(value).map(Self::ToolResult),
            "beforeInvocationEvent" => parse(value).map(Self::BeforeInvocation),
            "afterInvocationEvent" => parse(value).map(Self::AfterInvocation),
            "beforeModelCallEvent" => parse(value).map(Self::BeforeModelCall),
            "afterModelCallEvent" => parse(value).map(Self::AfterModelCall),
            "beforeToolsEvent" => parse(value).map(Self::BeforeTools),
            "afterToolsEvent" => parse(value).map(Self::AfterTools),
            "beforeToolCallEvent" => parse(value).map(Self::BeforeToolCall),
            "afterToolCallEvent" => parse(value).map(Self::AfterToolCall),
            "messageAddedEvent" => parse(value).map(Self::MessageAdded),
            "interruptEvent" => parse(value).map(Self::Interrupt),
            "agentResultEvent" => parse::<AgentResultRecordOwned>(value).map(|record| Self::AgentResult(record.result)),
            other => return Err(D::Error::custom(format!("unknown agent stream event type: {other}"))),
        };
        event.map_err(D::Error::custom)
    }
}

impl From<&InitializedEvent<'_>> for InitializedEventData {
    fn from(_: &InitializedEvent<'_>) -> Self {
        Self {}
    }
}

impl From<&BeforeInvocationEvent<'_>> for BeforeInvocationEventData {
    fn from(_: &BeforeInvocationEvent<'_>) -> Self {
        Self {}
    }
}

impl From<&AfterInvocationEvent<'_>> for AfterInvocationEventData {
    fn from(_: &AfterInvocationEvent<'_>) -> Self {
        Self {}
    }
}

impl From<&MessageAddedEvent<'_>> for MessageAddedEventData {
    fn from(event: &MessageAddedEvent<'_>) -> Self {
        Self {
            message: event.message().clone(),
        }
    }
}

impl From<&BeforeToolCallEvent> for BeforeToolCallEventData {
    fn from(event: &BeforeToolCallEvent) -> Self {
        Self {
            tool_use: event.tool_use().clone(),
        }
    }
}

impl From<&AfterToolCallEvent> for AfterToolCallEventData {
    fn from(event: &AfterToolCallEvent) -> Self {
        Self {
            tool_use: event.tool_use().clone(),
            result: event.result().clone(),
            error: event.error().map(|error| ErrorData::new(error.to_string())),
        }
    }
}

impl From<&BeforeModelCallEvent<'_>> for BeforeModelCallEventData {
    fn from(event: &BeforeModelCallEvent<'_>) -> Self {
        Self {
            projected_input_tokens: event.projected_input_tokens(),
        }
    }
}

impl From<&AfterModelCallEvent<'_>> for AfterModelCallEventData {
    fn from(event: &AfterModelCallEvent<'_>) -> Self {
        Self {
            attempt_count: event.attempt_count(),
            stop_data: event.stop_data().cloned(),
            error: event.error().map(|error| ErrorData::new(error.to_string())),
        }
    }
}

impl From<&ModelStreamUpdateEvent<'_>> for ModelStreamUpdateEventData {
    fn from(event: &ModelStreamUpdateEvent<'_>) -> Self {
        Self {
            event: event.event().clone(),
        }
    }
}

impl From<&ContentBlockEvent<'_>> for ContentBlockEventData {
    fn from(event: &ContentBlockEvent<'_>) -> Self {
        Self {
            content_block: event.content_block().clone(),
        }
    }
}

impl From<&ModelMessageEvent<'_>> for ModelMessageEventData {
    fn from(event: &ModelMessageEvent<'_>) -> Self {
        Self {
            message: event.message().clone(),
            stop_reason: event.stop_reason(),
        }
    }
}

impl From<&ToolResultEvent> for ToolResultEventData {
    fn from(event: &ToolResultEvent) -> Self {
        Self {
            result: event.result().clone(),
        }
    }
}

impl From<&ToolStreamUpdateEvent> for ToolStreamUpdateEventData {
    fn from(event: &ToolStreamUpdateEvent) -> Self {
        Self {
            event: event.event().clone(),
        }
    }
}

impl From<&InterruptEvent<'_>> for InterruptEventData {
    fn from(event: &InterruptEvent<'_>) -> Self {
        Self {
            interrupt: event.interrupt().clone(),
        }
    }
}

impl From<&BeforeToolsEvent<'_>> for BeforeToolsEventData {
    fn from(event: &BeforeToolsEvent<'_>) -> Self {
        Self {
            message: event.message().clone(),
        }
    }
}

impl From<&AfterToolsEvent<'_>> for AfterToolsEventData {
    fn from(event: &AfterToolsEvent<'_>) -> Self {
        Self {
            message: event.message().clone(),
        }
    }
}

macro_rules! stream_record {
    ($($event:ty => $variant:ident),* $(,)?) => {
        $(
            impl From<&$event> for AgentStreamEvent {
                fn from(event: &$event) -> Self {
                    Self::$variant(event.into())
                }
            }
        )*
    };
}

stream_record! {
    ModelStreamUpdateEvent<'_> => ModelStreamUpdate,
    ContentBlockEvent<'_> => ContentBlock,
    ModelMessageEvent<'_> => ModelMessage,
    ToolStreamUpdateEvent => ToolStreamUpdate,
    ToolResultEvent => ToolResult,
    BeforeInvocationEvent<'_> => BeforeInvocation,
    AfterInvocationEvent<'_> => AfterInvocation,
    BeforeModelCallEvent<'_> => BeforeModelCall,
    AfterModelCallEvent<'_> => AfterModelCall,
    BeforeToolsEvent<'_> => BeforeTools,
    AfterToolsEvent<'_> => AfterTools,
    BeforeToolCallEvent => BeforeToolCall,
    AfterToolCallEvent => AfterToolCall,
    MessageAddedEvent<'_> => MessageAdded,
    InterruptEvent<'_> => Interrupt,
}

impl From<&AgentResultEvent<'_>> for AgentStreamEvent {
    fn from(event: &AgentResultEvent<'_>) -> Self {
        Self::AgentResult(event.result().clone())
    }
}
