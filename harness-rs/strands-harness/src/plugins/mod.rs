//! Harness-authored plugins.
//!
//! Each bundles a tool or context with a loop-level behaviour: [`Todos`] keeps a task list in
//! view, [`EnvironmentContext`] surfaces the working environment and project docs.

mod environment;
mod todos;

pub use environment::{EnvironmentContext, EnvironmentContextConfig};
pub use todos::{TodoItem, TodoStatus, Todos, TodosConfig};
