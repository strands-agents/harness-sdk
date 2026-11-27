//! Background task records and errors, crate-internal.

use serde::{Deserialize, Serialize};

use crate::error::Error;
use crate::interrupt::Interrupt;
use crate::types::ToolResultContent;

/// A task's lifecycle status (`BackgroundTaskStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BackgroundTaskStatus {
    Queued,
    Working,
    InputRequired,
    Completed,
    Failed,
    Cancelled,
}

impl BackgroundTaskStatus {
    /// Whether the task can no longer change.
    pub(crate) fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Working => "working",
            Self::InputRequired => "input_required",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// Why a task failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskFailureType {
    ToolError,
    ExecutionError,
    Timeout,
}

/// A task failure (`{ type, message }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct TaskFailure {
    #[serde(rename = "type")]
    pub(crate) failure_type: TaskFailureType,
    pub(crate) message: String,
}

impl TaskFailure {
    pub(crate) fn new(failure_type: TaskFailureType, message: impl Into<String>) -> Self {
        Self {
            failure_type,
            message: message.into(),
        }
    }
}

/// A task's result content (`{ content }`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct TaskResult {
    pub(crate) content: Vec<ToolResultContent>,
}

/// A read-only task snapshot, as persisted under `strands.backgroundTasks` in app state
/// (`BackgroundTask`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundTask {
    pub(crate) task_id: String,
    pub(crate) tool_use_id: String,
    pub(crate) tool_name: String,
    pub(crate) status: BackgroundTaskStatus,
    pub(crate) created_at: String,
    pub(crate) last_updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) result: Option<TaskResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<TaskFailure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) interrupts: Option<Vec<Interrupt>>,
}

/// A task id that is not tracked (`BackgroundTaskNotFoundError`).
#[derive(Debug, thiserror::Error)]
#[error("Background task '{0}' was not found")]
pub(crate) struct BackgroundTaskNotFoundError(pub(crate) String);

/// A wait that exceeded its timeout (`BackgroundTaskTimeoutError`).
#[derive(Debug, thiserror::Error)]
#[error("Timed out waiting for background tasks after {0}ms")]
pub(crate) struct BackgroundTaskTimeoutError(pub(crate) u128);

pub(crate) fn not_found(task_id: &str) -> Error {
    Error::other(BackgroundTaskNotFoundError(task_id.to_owned()))
}
