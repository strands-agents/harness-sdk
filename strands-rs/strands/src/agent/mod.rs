//! The agent: [`Agent`] and its configuration, the invocation API and its result, the
//! per-invocation state, the request context, direct tool calls, agents as tools, and the agent
//! views: [`LocalAgent`] for sequential hooks and plugins, [`ToolAgent`] for tools and per-tool
//! hooks.
//!
//! # Agent, tool and streaming
//!
//! ```
//! use futures::StreamExt;
//! use strands::{tool, Agent, AgentStreamEvent};
//!
//! /// Get the current weather for a city.
//! #[tool]
//! async fn get_weather(
//!     /// City name, for example "Seattle".
//!     city: String,
//! ) -> Result<String, strands::ToolError> {
//!     Ok(format!("Sunny in {city}"))
//! }
//!
//! #[tokio::main]
//! async fn main() -> Result<(), strands::Error> {
//!     let mut agent = Agent::builder()            // default model: Bedrock
//! #       .model(strands::testing::MockModel::from_turns(["It is sunny.", "It is mild."]))
//! #       .printer(false)
//!         .system_prompt("You are a concise assistant.")
//!         .tools([GetWeather])
//!         .build()?;
//!
//!     let result = agent.invoke("What's the weather in Seattle?").await?;
//!     println!("{result}");
//!
//!     {
//!         let mut stream = agent.stream("And in Lisbon?");
//!         while let Some(event) = stream.next().await {
//!             if let AgentStreamEvent::ModelStreamUpdate(update) = event? {
//!                 if let Some(text) = update.text_delta() {
//!                     print!("{text}");
//!                 }
//!             }
//!         }
//!     }
//!     agent.shutdown().await
//! }
//! ```
//!
//! # Config struct
//!
//! ```
//! use strands::{Agent, AgentConfig};
//! # use strands::testing::MockModel;
//!
//! let agent = Agent::new(AgentConfig {
//!     model: Some(MockModel::new().into()), // any provider, such as an `AnthropicModel`
//!     system_prompt: Some("You are a concise assistant.".into()),
//!     ..Default::default()
//! })?;
//! # Ok::<(), strands::Error>(())
//! ```
//!
//! # Tools with state
//!
//! ```
//! use std::sync::Arc;
//! use strands::{tools, Agent, ToolContext};
//! # struct Pool;
//! # impl Pool {
//! #     async fn stock(&self, _sku: &str) -> std::io::Result<u32> { Ok(3) }
//! # }
//! # let db = Pool;
//!
//! struct Inventory { db: Pool }
//!
//! #[tools]
//! impl Inventory {
//!     /// Look up stock for a product.
//!     #[tool]
//!     async fn check_stock(&self, #[tool(context)] ctx: &ToolContext, sku: String) -> Result<u32, strands::ToolError> {
//!         let _ = ctx.agent().app_state().get::<String>("region");
//!         Ok(self.db.stock(&sku).await?)
//!     }
//! }
//!
//! let inventory = Arc::new(Inventory { db });
//! let agent = Agent::builder()
//! #   .model(strands::testing::MockModel::new())
//!     .tools(inventory.tools())
//!     .build()?;
//! # assert_eq!(agent.tools()[0].name(), "check_stock");
//! # Ok::<(), strands::Error>(())
//! ```
//!
//! # Hooks, structured output and cancellation
//!
//! ```
//! use strands::hooks::BeforeToolCallEvent;
//! use strands::{Agent, CancelOptions, InvokeOptions};
//! # use serde_json::json;
//! # use strands::testing::{MockModel, MockTurn};
//! # use strands::types::ToolUseBlock;
//!
//! # async fn audit_log(_tool_use: &strands::ToolUse) {}
//! # async fn run() -> Result<(), strands::Error> {
//! # let reply = ToolUseBlock::new("strands_structured_output", "t-1", json!({"title": "Thread", "points": ["a"]}));
//! # let model = MockModel::from_turns([MockTurn::content([strands::ContentBlock::from(reply)])]);
//! let mut agent = Agent::builder()
//! #   .model(model)
//! #   .printer(false)
//!     .build()?;
//!
//! agent.add_hook(|event: &mut BeforeToolCallEvent| {
//!     if event.tool_use().name == "shell" {
//!         event.set_cancel("shell is disabled");
//!     }
//! });
//!
//! agent.add_async_hook::<BeforeToolCallEvent>(|event| Box::pin(async move {
//!     audit_log(event.tool_use()).await;
//! }));
//!
//! #[derive(serde::Deserialize, schemars::JsonSchema)]
//! struct Summary { title: String, points: Vec<String> }
//!
//! let summary: Summary = agent
//!     .invoke_with("Summarize this thread", InvokeOptions::default().structured_output_schema::<Summary>())
//!     .await?
//!     .structured_output()?;
//! # assert_eq!(summary.title, "Thread");
//! # assert_eq!(summary.points, ["a"]);
//!
//! let cancel = agent.cancel_handle();
//! tokio::spawn(async move {
//!     tokio::time::sleep(std::time::Duration::from_secs(30)).await;
//!     cancel.cancel(CancelOptions::default());
//! });
//! # Ok(())
//! # }
//! # tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(run()).unwrap();
//! ```

#[allow(
    clippy::module_inception,
    reason = "the `Agent` type has its own file, apart from the rest of the module"
)]
mod agent;
mod agent_as_tool;
mod agent_delegation;
mod config;
pub(crate) mod continuation;
#[cfg(not(feature = "bedrock"))]
mod default_model;
mod event_loop;
mod invocation_context;
mod invocation_state;
mod invoke_args;
mod local_agent;
mod mcp_tools;
mod printer;
mod result;
pub(crate) mod snapshot;
mod stream;
mod tool_agent;
mod tool_caller;
mod tool_pipeline;

pub use agent::Agent;
pub(crate) use agent::resolve_plain_model;
pub use agent_as_tool::{AgentAsTool, AgentAsToolOptions, DELEGATION_DESCRIPTION_SUFFIX};
pub(crate) use agent_as_tool::{AgentToolStreamer, Resume, merge_events_first};
pub use config::{AgentBuilder, AgentConfig, InvokeOptions, ModelSource};
#[cfg(test)]
pub(crate) use event_loop::cancelled_error;
pub(crate) use event_loop::is_cancelled_error;
pub use invocation_context::{InvocationContext, InvocationContextUsage, InvokeLimits, LimitKey};
pub use invocation_state::InvocationState;
pub use invoke_args::InvokeArgs;
pub use local_agent::LocalAgent;
pub use result::AgentResult;
pub use snapshot::{SnapshotField, SnapshotPreset, TakeSnapshotOptions};
pub use stream::AgentStream;
pub use tool_agent::{RefusedCall, ToolAgent};
pub use tool_caller::{DirectToolCallOptions, ToolHandle};
