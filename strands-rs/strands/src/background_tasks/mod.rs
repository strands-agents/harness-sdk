//! Background tool execution.
//!
//! With [`AgentConfig::background_tasks`](crate::AgentConfig::background_tasks) set, tool calls
//! can run detached from the turn that requested them. The model selects background execution
//! per call through a `_background_execution` property added to each eligible tool's schema
//! (the `agentic` policy, by default for every tool), or a tool always or never runs in the
//! background. A detached call returns a dispatch acknowledgement at once; its result is
//! delivered later as a synthetic `strands_manage_background_task` `get` call, before the next
//! model call or at the end of the invocation. By default the invocation waits for its tasks.
//!
//! ```
//! use strands::Agent;
//! use strands::background_tasks::BackgroundTasksConfig;
//! use strands::testing::MockModel;
//!
//! let agent = Agent::builder()
//!     .model(MockModel::new())
//!     .background_tasks(BackgroundTasksConfig {
//!         always: Some(vec!["slow_report".into()]),
//!         max_concurrency: Some(2),
//!         ..Default::default()
//!     })
//!     .printer(false)
//!     .build()?;
//! # let _ = agent;
//! # Ok::<(), strands::Error>(())
//! ```

mod engine;
mod manager;
mod plugin;
mod types;

use std::time::Duration;

pub(crate) use engine::panic_message;
pub(crate) use manager::{RunFailure, RunFn, ToolRun};
pub(crate) use plugin::{BackgroundTasks, BackgroundTasksPlugin, Route};

/// Background tool execution settings (`BackgroundTasksConfig`). Tools are named by
/// [`Tool::name`](crate::Tool::name); `*` matches every tool without an exact entry.
#[derive(Debug, Clone, Default, PartialEq, Eq, bon::Builder)]
pub struct BackgroundTasksConfig {
    /// Wait for background work before an invocation returns. Defaults to `true`.
    pub wait_for_completion: Option<bool>,
    /// Tools whose execution mode the model selects. Defaults to `["*"]` unless `always` or
    /// `never` holds `*`.
    pub agentic: Option<Vec<String>>,
    /// Tools that always run in the background.
    pub always: Option<Vec<String>>,
    /// Tools that never run in the background.
    pub never: Option<Vec<String>>,
    /// The most background tasks running at once. Defaults to 4.
    pub max_concurrency: Option<usize>,
    /// The timeout of one execution, in whole milliseconds. Defaults to none.
    pub timeout: Option<Duration>,
    /// Name of the tool the model calls to list, get or cancel background tasks
    /// (`manageToolName`). Must not match another tool on the agent. The name is written into
    /// conversation history, so keep it stable across a saved session. Defaults to
    /// `strands_manage_background_task`.
    #[builder(into)]
    pub manage_tool_name: Option<String>,
}

crate::types::toggle_from_config!(BackgroundTasksConfig);

#[cfg(test)]
mod tests;
