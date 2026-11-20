//! `Todos`: a structured task list the agent maintains for multi-step work.
//!
//! A single `todo_write` tool writes the current list to the agent's app state; an internal
//! [`ContextInjector`] re-renders that list before every model call (`EveryTurn`), so the model
//! sees the refreshed list within the same invocation. Each rendered list is an injected block, and
//! only the latest user message's injected blocks are sent, so the model sees one current copy.
//!
//! ```
//! use strands::Agent;
//! use strands::testing::MockModel;
//! use strands::vended_plugins::todos::Todos;
//!
//! let agent = Agent::builder()
//!     .model(MockModel::new())
//!     .plugins([Todos::default()])
//!     .printer(false)
//!     .build()?;
//! # let _ = agent;
//! # Ok::<(), strands::Error>(())
//! ```

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::agent::LocalAgent;
use crate::injection::{InjectionContext, InjectionTrigger};
use crate::plugins::Plugin;
use crate::tools::{FunctionTool, ToolError, ToolSource};
use crate::types::{JsonSchema, JsonValue};
use crate::vended_plugins::context_injector::{ContextInjector, ContextInjectorConfig};

const STATE_KEY: &str = "todos";
const DEFAULT_NAME: &str = "strands:todos";

// The `todo_write` tool description.
const TODO_WRITE_DESCRIPTION: &str = concat!(
    "Create and maintain a structured task list for the current session. Use proactively for ",
    "multi-step work (roughly 3+ distinct steps). Keep exactly one item in_progress at a time, ",
    "and update status as you go rather than batching. The current list is re-surfaced to you ",
    "before each step, so you do not need to restate it. Pass an empty list to clear it when the ",
    "work is done."
);

/// Where a todo stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum TodoStatus {
    /// Not started (`pending`).
    Pending,
    /// Being worked on (`in_progress`).
    InProgress,
    /// Done (`completed`).
    Completed,
}

impl TodoStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
        }
    }
}

/// One entry of the todo list, stored in app state in this JSON shape. Unknown keys are dropped on
/// input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TodoItem {
    /// The task, imperative: "Run tests".
    pub content: String,
    /// Present continuous, shown while in progress: "Running tests".
    pub active_form: String,
    /// Where the task stands.
    pub status: TodoStatus,
}

impl TodoItem {
    /// A todo.
    pub fn new(content: impl Into<String>, active_form: impl Into<String>, status: TodoStatus) -> Self {
        Self {
            content: content.into(),
            active_form: active_form.into(),
            status,
        }
    }
}

#[derive(Deserialize)]
struct TodoWriteInput {
    todos: Vec<TodoItem>,
}

fn todo_line(todo: &TodoItem) -> String {
    let label = if todo.status == TodoStatus::InProgress && !todo.active_form.is_empty() {
        &todo.active_form
    } else {
        &todo.content
    };
    format!("  [{}] {label}", todo.status.as_str())
}

fn render_list(todos: &[TodoItem]) -> String {
    todos.iter().map(todo_line).collect::<Vec<_>>().join("\n")
}

fn input_schema() -> JsonSchema {
    json!({
        "type": "object",
        "properties": {
            "todos": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "content": {"type": "string", "description": "The task, imperative: \"Run tests\"."},
                        "activeForm": {
                            "type": "string",
                            "description": "Present continuous, shown while in progress: \"Running tests\"."
                        },
                        "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]}
                    },
                    "required": ["content", "activeForm", "status"],
                    "additionalProperties": false
                },
                "description": "The full updated list."
            }
        },
        "required": ["todos"],
        "additionalProperties": false
    })
}

/// Configuration for the [`Todos`] plugin (`TodosConfig`).
#[derive(Debug, Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct TodosConfig {
    /// Plugin name. It also tags the reminder blocks the plugin injects, and that tag keeps a retry
    /// or a restored session from injecting a second copy, so keep it stable. Defaults to
    /// `strands:todos`.
    pub name: Option<String>,
    /// App-state key the list is stored under. Defaults to `todos`.
    pub state_key: Option<String>,
}

/// Gives the agent a `todo_write` tool and keeps the current list in view (`Todos`).
///
/// The tool persists the list to the agent's app state under the state key; before each model
/// call the plugin re-renders it as a `<system-reminder>`. Sharing one instance across agents is
/// safe: the list lives in per-agent state, not on the plugin.
///
/// One agent takes one `Todos`. The tool is always named `todo_write`, so registering a second
/// instance fails no matter how `name` and `state_key` are set.
///
/// Because the list is re-rendered on every model call, it changes the tail of the request each
/// turn. On a provider without explicit cache points that moves the cached prefix boundary, so
/// weigh it against the task tracking it buys.
#[derive(Debug, Clone)]
pub struct Todos {
    name: String,
    state_key: String,
}

impl Default for Todos {
    fn default() -> Self {
        Self::new(TodosConfig::default())
    }
}

impl Todos {
    /// The plugin with `config`.
    #[must_use]
    pub fn new(config: TodosConfig) -> Self {
        Self {
            name: config.name.unwrap_or_else(|| DEFAULT_NAME.to_owned()),
            state_key: config.state_key.unwrap_or_else(|| STATE_KEY.to_owned()),
        }
    }

    /// The `todo_write` tool, writing to `state_key`.
    #[must_use]
    pub fn todo_write_tool(&self) -> FunctionTool {
        let state_key = self.state_key.clone();
        FunctionTool::builder("todo_write", TODO_WRITE_DESCRIPTION)
            .input_schema(input_schema())
            .callback(move |input, context| {
                let state_key = state_key.clone();
                async move {
                    let input: TodoWriteInput = serde_json::from_value(input)?;
                    let state = context.agent().app_state();
                    if input.todos.is_empty() {
                        state.delete(&state_key);
                        return Ok::<JsonValue, ToolError>("Todo list cleared".into());
                    }
                    state.set(&state_key, &input.todos)?;
                    let remaining = input
                        .todos
                        .iter()
                        .filter(|todo| todo.status != TodoStatus::Completed)
                        .count();
                    Ok(format!("{remaining} todos remaining\n{}", render_list(&input.todos)).into())
                }
            })
    }

    fn render_reminder(state_key: &str, context: &InjectionContext) -> Option<String> {
        let todos: Vec<TodoItem> = context.app_state.get(state_key).ok().flatten()?;
        if todos.is_empty() {
            return None;
        }
        Some(format!(
            "<system-reminder>\nYour current todo list:\n{}\nKeep it up to date with todo_write as you work.\n</system-reminder>",
            render_list(&todos)
        ))
    }
}

#[async_trait]
impl Plugin for Todos {
    fn name(&self) -> &str {
        &self.name
    }

    async fn init_agent(&self, agent: &mut LocalAgent) -> crate::Result<()> {
        let state_key = self.state_key.clone();
        let config = ContextInjectorConfig::new(move |context| {
            let reminder = Self::render_reminder(&state_key, &context);
            async move { Ok(reminder) }
        })
        .with_name(format!("{}:injector", self.name))
        .with_trigger(InjectionTrigger::EveryTurn);
        ContextInjector::new(config).init_agent(agent).await
    }

    fn get_tools(&self) -> Vec<ToolSource> {
        vec![self.todo_write_tool().into()]
    }
}

#[cfg(test)]
mod tests;
