//! Direct tool calls: `agent.tool("name").invoke(input)`.

use std::collections::VecDeque;
use std::sync::Arc;

use futures::StreamExt;

use super::agent::{Agent, PendingCleanup};
use super::invocation_state::InvocationState;
use super::tool_pipeline::ToolCallPipeline;
use crate::error::Result;
use crate::interrupt::Interrupt;
use crate::models::BoxStream;
use crate::tools::{ToolContext, ToolOutcome, ToolStreamItem, create_error_result};
use crate::types::{ContentBlock, JsonValue, Message, Role, ToolResultBlock, ToolUse, ToolUseBlock};

/// Options for a direct tool call (`DirectToolCallOptions`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, bon::Builder)]
pub struct DirectToolCallOptions {
    /// Record the call and its result in the agent's history. Defaults to `true`.
    pub record_direct_tool_call: Option<bool>,
}

/// A registered tool, called directly rather than by the model (`ToolHandle`).
///
/// The name resolves like the model's tool names: an exact match, then `_` for `-`, then
/// case-insensitively. A recorded call appends the tool use, its result and
/// `agent.tool.<name> was called.` to history and fires `MessageAddedEvent` for each. Direct
/// calls run the tool alone: no tool hooks fire, and an interrupt becomes an error result.
///
/// ```
/// use serde_json::json;
/// use strands::Agent;
/// use strands::testing::MockModel;
/// use strands::tools::FunctionTool;
///
/// # tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
/// let add = FunctionTool::builder("add", "Adds two numbers").callback(|input, _ctx| async move {
///     Ok(json!(input["a"].as_i64().unwrap_or(0) + input["b"].as_i64().unwrap_or(0)))
/// });
/// let mut agent = Agent::builder().model(MockModel::new()).tools([add]).printer(false).build()?;
/// let result = agent.tool("add").invoke(json!({"a": 5, "b": 3})).await?;
/// assert_eq!(serde_json::to_value(&result.content)?, json!([{"text": "8"}]));
/// assert_eq!(agent.messages().len(), 3);
/// # Ok::<(), strands::Error>(())
/// # }).unwrap();
/// ```
#[derive(Debug)]
pub struct ToolHandle<'a> {
    agent: &'a mut Agent,
    name: String,
}

impl Agent {
    /// A handle that calls the named tool directly (`agent.tool.<name>`).
    pub fn tool(&mut self, name: impl Into<String>) -> ToolHandle<'_> {
        ToolHandle {
            agent: self,
            name: name.into(),
        }
    }
}

impl<'a> ToolHandle<'a> {
    /// Calls the tool and returns its result (`invoke`).
    ///
    /// # Errors
    ///
    /// [`ToolNotFoundError`](crate::ToolNotFoundError) when no tool matches the name.
    pub async fn invoke(self, input: JsonValue) -> Result<ToolResultBlock> {
        self.invoke_with(input, DirectToolCallOptions::default()).await
    }

    /// Calls the tool with options.
    ///
    /// # Errors
    ///
    /// The same as [`invoke`](Self::invoke).
    pub async fn invoke_with(self, input: JsonValue, options: DirectToolCallOptions) -> Result<ToolResultBlock> {
        let mut stream = self.stream_with(input, options);
        let mut result = None;
        while let Some(item) = stream.next().await {
            if let ToolStreamItem::Outcome(ToolOutcome::Result(block)) = item? {
                result = Some(block);
            }
        }
        result.ok_or_else(|| crate::Error::other("direct tool call ended without a result"))
    }

    /// Streams the tool's progress events, ending with its result (`stream`).
    pub fn stream(self, input: JsonValue) -> BoxStream<'a, Result<ToolStreamItem>> {
        self.stream_with(input, DirectToolCallOptions::default())
    }

    /// Streams the tool with options.
    pub fn stream_with(
        self,
        input: JsonValue,
        options: DirectToolCallOptions,
    ) -> BoxStream<'a, Result<ToolStreamItem>> {
        let ToolHandle { agent, name } = self;
        Box::pin(async_stream::try_stream! {
            let tool = agent.local.tool_registry().resolve(&name)?.clone();
            let tool_use_id = format!("tooluse_{}", uuid::Uuid::new_v4());
            let tool_use = ToolUse::new(tool.name(), tool_use_id.clone(), input);
            let pipeline = ToolCallPipeline::new(
                agent.local.hooks().clone(),
                agent.local.middleware().clone(),
                InvocationState::new(),
                agent.local.meter().clone(),
                agent.local.tracer().clone(),
            );
            let view = agent.local.tool_agent().with_pipeline(Arc::new(pipeline));
            let context = ToolContext::new(tool_use.clone(), view, InvocationState::new())
                .with_interrupt(Arc::new(|params: &crate::types::InterruptParams| {
                    Err(Interrupt::new("direct", params.name.clone()).into())
                }));
            let mut tool_stream = tool.stream(context);
            let mut result = None;
            while let Some(item) = tool_stream.next().await {
                match item {
                    ToolStreamItem::Event(event) => yield ToolStreamItem::Event(event),
                    ToolStreamItem::Outcome(ToolOutcome::Result(block)) => {
                        result = Some(block);
                        break;
                    }
                    ToolStreamItem::Outcome(ToolOutcome::Interrupt(_)) => {
                        result = Some(create_error_result(
                            "Interrupts are not supported in direct tool calls",
                            tool_use_id.clone(),
                        ));
                        break;
                    }
                }
            }
            let result = result.unwrap_or_else(|| super::tool_agent::no_result(&tool_use));
            if options.record_direct_tool_call.unwrap_or(true) {
                agent.record_direct_tool_call(&tool_use, &result).await?;
            }
            yield ToolStreamItem::Outcome(ToolOutcome::Result(result));
        })
    }
}

impl Agent {
    async fn record_direct_tool_call(&mut self, tool_use: &ToolUse, result: &ToolResultBlock) -> Result<()> {
        let block = ToolUseBlock::new(
            tool_use.name.clone(),
            tool_use.tool_use_id.clone(),
            tool_use.input.clone(),
        );
        let messages = VecDeque::from([
            Message::new(Role::Assistant, vec![ContentBlock::ToolUse(block)]),
            Message::new(Role::User, vec![ContentBlock::ToolResult(result.clone())]),
            Message::new(
                Role::Assistant,
                vec![ContentBlock::text(format!("agent.tool.{} was called.", tool_use.name))],
            ),
        ]);
        self.run_pending_cleanup().await;
        self.local.messages_mut().extend(messages.iter().cloned());
        self.pending_cleanup = Some(PendingCleanup {
            messages,
            message_progress: Arc::default(),
            after_invocation: None,
            invocation_state: InvocationState::new(),
            invocation_context: None,
        });
        self.drain_pending_cleanup().await
    }
}
