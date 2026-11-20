//! Bedrock provider tests. A [`MockTransport`] records the Converse JSON the provider sends and
//! replays scripted Converse JSON responses.

mod cache;
mod config;
mod count_tokens;
mod format;
mod guardrail;
mod stream;
mod transport;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures::StreamExt;
use serde_json::json;

use super::transport::{BedrockError, BedrockErrorKind, BedrockTransport, ChunkStream};
use super::{BedrockModel, BedrockModelConfig};
use crate::error::{Error, Result};
use crate::models::streaming::ModelStreamEvent;
use crate::models::{Model, ModelRequest};
use crate::types::{ContentBlock, JsonObject, JsonValue, Message, Role, SystemPrompt, ToolChoice, ToolSpec};

/// Which API a recorded request went to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Command {
    ConverseStream,
    Converse,
}

/// A scripted reply to one send.
pub(super) enum Reply {
    /// Stream chunks (for ConverseStream) or the single output (for Converse).
    Ok(Vec<Result<JsonValue, BedrockError>>),
    /// The send itself rejects.
    Reject(BedrockError),
}

/// Records sent requests and replays scripted replies; unscripted sends get the default reply.
#[derive(Default)]
pub(super) struct MockTransport {
    pub(super) calls: Mutex<Vec<(Command, JsonObject)>>,
    replies: Mutex<VecDeque<Reply>>,
    default_reply: Mutex<Option<Vec<JsonValue>>>,
    pub(super) count_calls: Mutex<Vec<(String, JsonObject)>>,
    count_replies: Mutex<VecDeque<Result<Option<u64>, BedrockError>>>,
}

pub(super) fn hello_chunks() -> Vec<JsonValue> {
    vec![
        json!({"messageStart": {"role": "assistant"}}),
        json!({"contentBlockStart": {}}),
        json!({"contentBlockDelta": {"delta": {"text": "Hello"}}}),
        json!({"contentBlockStop": {}}),
        json!({"messageStop": {"stopReason": "end_turn"}}),
        json!({"metadata": {"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}}}),
    ]
}

pub(super) fn hello_output() -> JsonValue {
    json!({
        "output": {"message": {"role": "assistant", "content": [{"text": "Hello"}]}},
        "stopReason": "end_turn",
        "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
        "metrics": {"latencyMs": 100}
    })
}

impl MockTransport {
    pub(super) fn push(&self, reply: Reply) {
        self.replies.lock().unwrap().push_back(reply);
    }

    pub(super) fn push_chunks(&self, chunks: Vec<JsonValue>) {
        self.push(Reply::Ok(chunks.into_iter().map(Ok).collect()));
    }

    pub(super) fn reject(&self, error: BedrockError) {
        self.push(Reply::Reject(error));
    }

    /// Replaces the reply every unscripted send gets.
    pub(super) fn set_default(&self, chunks: Vec<JsonValue>) {
        *self.default_reply.lock().unwrap() = Some(chunks);
    }

    pub(super) fn push_count(&self, reply: Result<Option<u64>, BedrockError>) {
        self.count_replies.lock().unwrap().push_back(reply);
    }

    pub(super) fn requests(&self, command: Command) -> Vec<JsonValue> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(sent, _)| *sent == command)
            .map(|(_, request)| JsonValue::Object(request.clone()))
            .collect()
    }

    pub(super) fn call_count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }

    /// The last ConverseStream request.
    pub(super) fn last(&self) -> JsonValue {
        self.requests(Command::ConverseStream)
            .pop()
            .expect("a ConverseStream request")
    }

    fn next(&self, command: Command, request: JsonObject) -> Reply {
        self.calls.lock().unwrap().push((command, request));
        if let Some(reply) = self.replies.lock().unwrap().pop_front() {
            return reply;
        }
        let default = self.default_reply.lock().unwrap().clone();
        let chunks = default.unwrap_or_else(|| match command {
            Command::ConverseStream => hello_chunks(),
            Command::Converse => vec![hello_output()],
        });
        Reply::Ok(chunks.into_iter().map(Ok).collect())
    }
}

fn into_object(value: JsonValue) -> JsonObject {
    match value {
        JsonValue::Object(object) => object,
        other => panic!("expected a JSON object, got {other}"),
    }
}

#[async_trait]
impl BedrockTransport for MockTransport {
    async fn converse_stream(&self, request: JsonObject) -> Result<ChunkStream, BedrockError> {
        match self.next(Command::ConverseStream, request) {
            Reply::Reject(error) => Err(error),
            Reply::Ok(chunks) => Ok(Box::pin(futures::stream::iter(
                chunks.into_iter().map(|chunk| chunk.map(into_object)),
            ))),
        }
    }

    async fn converse(&self, request: JsonObject) -> Result<JsonObject, BedrockError> {
        match self.next(Command::Converse, request) {
            Reply::Reject(error) => Err(error),
            Reply::Ok(mut outputs) => outputs.remove(0).map(into_object),
        }
    }

    async fn count_tokens(&self, model_id: String, input: JsonObject) -> Result<Option<u64>, BedrockError> {
        self.count_calls.lock().unwrap().push((model_id, input));
        self.count_replies.lock().unwrap().pop_front().unwrap_or(Ok(Some(42)))
    }
}

/// A Bedrock service error, as the AWS SDK raises with `name`.
pub(super) fn service_error(name: &str, message: &str) -> BedrockError {
    BedrockError::service(name, message)
}

/// A plain error that is not a Bedrock exception.
pub(super) fn plain_error(message: &str) -> BedrockError {
    BedrockError {
        name: "Error".to_owned(),
        message: message.to_owned(),
        kind: BedrockErrorKind::Other,
        source: None,
    }
}

pub(super) fn validation(message: &str) -> BedrockError {
    service_error("ValidationException", message)
}

/// A provider over a fresh mock transport.
pub(super) fn provider(config: BedrockModelConfig) -> (BedrockModel, Arc<MockTransport>) {
    let transport = Arc::new(MockTransport::default());
    let model = BedrockModel::with_transport(config, transport.clone());
    (model, transport)
}

pub(super) fn with_model_id(model_id: &str) -> BedrockModelConfig {
    BedrockModelConfig {
        model_id: Some(model_id.to_owned()),
        ..BedrockModelConfig::default()
    }
}

/// The request options of a `stream` call.
#[derive(Default, Clone)]
pub(super) struct Options {
    pub(super) system_prompt: Option<SystemPrompt>,
    pub(super) tool_specs: Vec<ToolSpec>,
    pub(super) tool_choice: Option<ToolChoice>,
    pub(super) dynamic_trailing_blocks: Option<usize>,
    pub(super) structured_output_schema: Option<JsonValue>,
}

pub(super) fn request(messages: Vec<Message>, options: Options) -> ModelRequest {
    ModelRequest {
        messages,
        system_prompt: options.system_prompt,
        tool_specs: options.tool_specs,
        tool_choice: options.tool_choice,
        dynamic_trailing_blocks: options.dynamic_trailing_blocks,
        structured_output_schema: options.structured_output_schema,
        ..ModelRequest::default()
    }
}

/// Drains the stream, returning the events or the first error.
pub(super) async fn collect(model: &BedrockModel, request: ModelRequest) -> Result<Vec<ModelStreamEvent>> {
    let mut stream = model.stream(request);
    let mut events = Vec::new();
    while let Some(event) = stream.next().await {
        events.push(event?);
    }
    Ok(events)
}

/// Drains the stream and returns its events as JSON.
pub(super) async fn events_json(model: &BedrockModel, request: ModelRequest) -> Vec<JsonValue> {
    collect(model, request)
        .await
        .unwrap()
        .iter()
        .map(|event| serde_json::to_value(event).unwrap())
        .collect()
}

/// Runs the stream, ignoring its outcome.
pub(super) async fn run(model: &BedrockModel, request: ModelRequest) {
    let _ = collect(model, request).await;
}

pub(super) async fn run_error(model: &BedrockModel, request: ModelRequest) -> Error {
    collect(model, request).await.unwrap_err()
}

pub(super) fn user(content: Vec<ContentBlock>) -> Message {
    Message::new(Role::User, content)
}

pub(super) fn assistant(content: Vec<ContentBlock>) -> Message {
    Message::new(Role::Assistant, content)
}

pub(super) fn hello() -> Vec<Message> {
    vec![Message::user("Hello")]
}

/// The tool config with only the no-op tool.
pub(super) fn noop_tool_config() -> JsonValue {
    json!({"tools": [{"toolSpec": {
        "name": "noop",
        "description": "This is a fake tool that MUST be completely ignored.",
        "inputSchema": {"json": {"type": "object", "properties": {}}}
    }}]})
}
