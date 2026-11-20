//! Helpers shared by the agent loop tests.

#![allow(
    dead_code,
    unreachable_pub,
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::panic,
    reason = "each test binary uses a different subset; test helpers fail by panicking"
)]

pub mod gated;

use std::future::Future;
use std::sync::Arc;

use futures::StreamExt;
use serde_json::json;
use strands::testing::{MockModel, MockTurn};
use strands::tools::{FunctionTool, ToolStream};
use strands::types::{ToolResultContent, ToolSpec, ToolUseBlock};
use strands::{
    Agent, AgentStream, AgentStreamEvent, ContentBlock, JsonValue, Message, Tool, ToolContext, ToolOutcome,
    ToolResultBlock,
};

/// A model turn that calls one tool.
pub fn tool_use_turn(name: &str, tool_use_id: &str, input: JsonValue) -> MockTurn {
    MockTurn::content([ContentBlock::from(ToolUseBlock::new(name, tool_use_id, input))])
}

/// A model turn that calls several tools.
pub fn tool_uses_turn(uses: &[(&str, &str)]) -> MockTurn {
    MockTurn::content(
        uses.iter()
            .map(|(name, id)| ContentBlock::from(ToolUseBlock::new(*name, *id, json!({}))))
            .collect::<Vec<_>>(),
    )
}

/// A tool that runs `f` on its context and returns the outcome.
pub struct MockTool {
    name: String,
    result: Arc<dyn Fn(&ToolContext) -> ToolOutcome + Send + Sync>,
}

impl MockTool {
    pub fn new(name: &str, result: impl Fn(&ToolContext) -> ToolOutcome + Send + Sync + 'static) -> Self {
        Self {
            name: name.to_owned(),
            result: Arc::new(result),
        }
    }

    /// A tool that succeeds with `text`.
    pub fn text(name: &str, text: &str) -> Self {
        let text = text.to_owned();
        Self::new(name, move |context| {
            ToolResultBlock::success(
                context.tool_use().tool_use_id.clone(),
                vec![ToolResultContent::text(text.clone())],
            )
            .into()
        })
    }
}

impl Tool for MockTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        "Mock tool"
    }

    fn tool_spec(&self) -> ToolSpec {
        ToolSpec::new(&self.name, "Mock tool").with_input_schema(json!({"type": "object", "properties": {}}))
    }

    fn stream(&self, context: ToolContext) -> ToolStream {
        ToolStream::ready((self.result)(&context))
    }
}

/// A function tool with an async body.
pub fn async_tool<F, Fut>(name: &str, body: F) -> FunctionTool
where
    F: Fn(JsonValue, ToolContext) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<JsonValue, strands::ToolError>> + Send + 'static,
{
    FunctionTool::builder(name, format!("Tool {name}")).callback(body)
}

/// Drains a stream into its records; panics on an error item.
pub async fn collect(mut stream: AgentStream<'_>) -> Vec<AgentStreamEvent> {
    let mut events = Vec::new();
    while let Some(event) = stream.next().await {
        events.push(event.expect("stream item"));
    }
    events
}

/// The `type` of each record.
pub fn types(events: &[AgentStreamEvent]) -> Vec<&'static str> {
    events.iter().map(AgentStreamEvent::event_type).collect()
}

/// The text of every message in history.
pub fn texts(agent: &Agent) -> Vec<String> {
    agent.messages().iter().map(Message::text).collect()
}

/// A model with these text turns.
pub fn text_model(turns: &[&str]) -> MockModel {
    MockModel::from_turns(turns.iter().copied())
}
