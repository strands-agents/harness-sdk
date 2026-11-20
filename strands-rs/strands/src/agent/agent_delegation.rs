//! Delegation semantics for agents as tools (`AgentDelegation`).
//!
//! When the model calls an agent-as-tool built with `delegate: true`, the tool must be the only
//! call of its turn, the loop ends right after it succeeds, its answer becomes the final assistant
//! message, and the sub-agent's stream events surface in the parent's stream as native events.

use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use futures::StreamExt;

use super::local_agent::LocalAgent;
use crate::error::{Error, Result};
use crate::hooks::{
    AfterToolCallEvent, AfterToolsEvent, AgentStreamEvent, BeforeModelCallEvent, BeforeToolsEvent, EndTurn,
    HookCallbackOptions, HookOrder,
};
use crate::middleware::{ExecuteToolResult, ExecuteToolStage, StageItem, StageStream};
use crate::plugins::Plugin;
use crate::tools::{DelegationToken, STRUCTURED_OUTPUT_TOOL_NAME, ToolRegistry};
use crate::types::{ContentBlock, ToolResultBlock, ToolResultContent, ToolResultStatus};

/// The name of the built-in delegation plugin; a user plugin with this name replaces it.
pub(crate) const AGENT_DELEGATION_NAME: &str = "strands:agent-delegation";

const STATEFUL_DELEGATION_ERROR: &str = "Delegation tools (delegate: true) are not supported with stateful models. Stateful models manage conversation state server-side, and delegation's early loop exit would leave unclosed function calls on the server.";
const MIXED_BATCH_CANCEL: &str = "This tool call was not executed. A delegation tool must be the only tool called in a turn. Retry with a single delegation tool call or use only non-delegation tools.";
const MIXED_BATCH_ERROR: &str = "Delegation failed: a delegation tool must be the only tool called in a turn. Retry with a single delegation tool call or use only non-delegation tools.";

/// The delegation state of one tool batch (`DelegationState`).
#[derive(Debug, Default)]
struct DelegationState {
    tool_use_count: usize,
    tool_use_id: Option<String>,
}

type SharedState = Arc<Mutex<Option<DelegationState>>>;

fn lock(state: &SharedState) -> std::sync::MutexGuard<'_, Option<DelegationState>> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

fn is_delegation_tool(registry: &ToolRegistry, name: &str) -> bool {
    registry
        .get(name)
        .is_some_and(|tool| tool.is_delegation_tool(DelegationToken(())))
}

/// A delegation result as assistant content: JSON becomes its text.
fn to_content_blocks(result: &ToolResultBlock) -> Vec<ContentBlock> {
    result
        .content
        .iter()
        .filter_map(|content| match content {
            ToolResultContent::Text(text) => Some(ContentBlock::Text(text.clone())),
            ToolResultContent::Json(json) => Some(ContentBlock::text(json.json.to_string())),
            ToolResultContent::Image(image) => Some(ContentBlock::Image(image.clone())),
            ToolResultContent::Video(video) => Some(ContentBlock::Video(video.clone())),
            ToolResultContent::Document(document) => Some(ContentBlock::Document(document.clone())),
            _ => None,
        })
        .collect()
}

fn is_blank(blocks: &[ContentBlock]) -> bool {
    blocks.iter().all(|block| block.as_text() == Some(""))
}

/// The built-in plugin that enforces delegation (`AgentDelegation`). Every agent registers one;
/// it does nothing until a delegation tool runs.
#[derive(Default)]
pub(crate) struct AgentDelegation {
    state: SharedState,
}

impl AgentDelegation {
    pub(crate) fn new() -> Self {
        Self::default()
    }
}

fn on_before_tools(state: &SharedState, event: &mut BeforeToolsEvent<'_>) {
    if event.agent().model().stateful() {
        return;
    }
    let names: Vec<String> = event
        .message()
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolUse(tool_use) => Some(tool_use.name.clone()),
            _ => None,
        })
        .collect();
    *lock(state) = Some(DelegationState {
        tool_use_count: names.len(),
        tool_use_id: None,
    });
    let registry = event.agent().tool_registry();
    if names.len() > 1 && names.iter().any(|name| is_delegation_tool(registry, name)) {
        event.set_cancel(MIXED_BATCH_CANCEL);
    }
}

fn on_after_tool_call(state: &SharedState, event: &mut AfterToolCallEvent) {
    let mut guard = lock(state);
    let tool_use_id = &event.tool_use().tool_use_id;
    let delegating = !event.agent().model().stateful()
        && event
            .tool()
            .is_some_and(|tool| tool.is_delegation_tool(DelegationToken(())));
    if !delegating {
        if let Some(state) = guard.as_mut()
            && state.tool_use_id.as_ref() == Some(tool_use_id)
        {
            state.tool_use_id = None;
        }
        return;
    }
    let Some(state) = guard.as_mut() else {
        return;
    };
    state.tool_use_id = (event.result().status != ToolResultStatus::Error).then(|| tool_use_id.clone());
}

fn on_after_tools(state: &SharedState, event: &mut AfterToolsEvent<'_>) {
    if event.agent().model().stateful() {
        return;
    }
    let mut guard = lock(state);
    let Some(state) = guard.as_mut() else {
        return;
    };
    let Some(tool_use_id) = state.tool_use_id.clone() else {
        return;
    };
    let result = event.message().content.iter().find_map(|block| match block {
        ContentBlock::ToolResult(result) if result.tool_use_id == tool_use_id => Some(result),
        _ => None,
    });
    let Some(result) = result.filter(|result| result.status != ToolResultStatus::Error) else {
        state.tool_use_id = None;
        return;
    };
    if event.agent().tool_registry().get(STRUCTURED_OUTPUT_TOOL_NAME).is_some() {
        tracing::debug!("tool_use_id=<{tool_use_id}> | parent requires structured output, skipping delegation");
        return;
    }
    let content = to_content_blocks(result);
    if content.is_empty() || is_blank(&content) {
        tracing::debug!("tool_use_id=<{tool_use_id}> | delegation produced blank content, skipping delegation");
        return;
    }
    drop(guard);
    event.set_end_turn(EndTurn::Content(content));
}

/// Unwraps the sub-agent's events a delegation tool reports as tool progress into native events.
fn unwrap_inner_events(item: StageItem<ExecuteToolStage>) -> StageItem<ExecuteToolStage> {
    let StageItem::Event(AgentStreamEvent::ToolStreamUpdate(update)) = &item else {
        return item;
    };
    let inner = update
        .event
        .data
        .clone()
        .and_then(|data| serde_json::from_value::<AgentStreamEvent>(data).ok());
    match inner {
        Some(event) => StageItem::Event(event),
        None => item,
    }
}

#[async_trait]
impl Plugin for AgentDelegation {
    fn name(&self) -> &str {
        AGENT_DELEGATION_NAME
    }

    async fn init_agent(&self, agent: &mut LocalAgent) -> Result<()> {
        if agent.model().stateful()
            && agent
                .tool_registry()
                .list()
                .iter()
                .any(|tool| tool.is_delegation_tool(DelegationToken(())))
        {
            return Err(Error::other(STATEFUL_DELEGATION_ERROR));
        }
        let state = self.state.clone();
        agent.add_hook(move |event: &mut BeforeToolsEvent<'_>| on_before_tools(&state, event));
        let state = self.state.clone();
        agent.add_hook(move |event: &mut AfterToolCallEvent| on_after_tool_call(&state, event));
        let state = self.state.clone();
        agent.add_hook_with(
            move |event: &mut AfterToolsEvent<'_>| on_after_tools(&state, event),
            HookCallbackOptions {
                order: HookOrder::SDK_LAST,
            },
        );
        let state = self.state.clone();
        agent.add_hook(move |_: &mut BeforeModelCallEvent<'_>| *lock(&state) = None);

        let state = self.state.clone();
        agent.add_middleware(ExecuteToolStage::wrap(move |context, next| {
            let delegating = context
                .tool
                .as_ref()
                .is_some_and(|tool| tool.is_delegation_tool(DelegationToken(())))
                && !context.agent.model().stateful();
            if !delegating {
                return next.call(context);
            }
            let mixed = lock(&state).as_ref().is_some_and(|state| state.tool_use_count > 1);
            if mixed {
                let result = ToolResultBlock::error(
                    context.tool_use.tool_use_id,
                    vec![ToolResultContent::text(MIXED_BATCH_ERROR)],
                );
                return StageStream::from_result(Ok(ExecuteToolResult::new(result)));
            }
            StageStream::new(next.call(context).map(unwrap_inner_events))
        }));
        Ok(())
    }
}

#[cfg(test)]
mod tests;
