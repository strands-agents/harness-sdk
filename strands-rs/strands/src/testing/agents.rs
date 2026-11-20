//! Fixtures for tools, middleware and hooks: [`tool_context`], [`invoke_model_context`],
//! [`execute_tool_context`] and [`HookRecorder`].

use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;

use super::MockModel;
use crate::agent::{Agent, AgentConfig, InvocationState, LocalAgent, ToolAgent};
use crate::cancel::CancelHandle;
use crate::error::Result;
use crate::hooks::{
    AfterInvocationEvent, AfterModelCallEvent, AfterToolCallEvent, AfterToolsEvent, AgentResultEvent,
    BeforeInvocationEvent, BeforeModelCallEvent, BeforeToolCallEvent, BeforeToolsEvent, ContentBlockEvent,
    HookRegistry, InitializedEvent, InterruptEvent, MessageAddedEvent, ModelMessageEvent, ModelStreamUpdateEvent,
    ToolResultEvent, ToolStreamUpdateEvent,
};
use crate::injection::InjectionContext;
use crate::middleware::{ExecuteToolContext, InvokeModelContext};
use crate::plugins::Plugin;
use crate::tools::ToolContext;
use crate::types::{Message, ToolUse};

/// A [`ToolContext`] for running a tool on its own.
///
/// The agent view has the id `mock-agent`, a [`MockModel`], empty state and no tools; interrupts
/// work as in an agent, with ids `tool:<toolUseId>:<name>`.
///
/// ```
/// use serde_json::json;
/// use strands::testing::tool_context;
/// use strands::ToolUse;
///
/// let context = tool_context(ToolUse::new("echo", "t-1", json!({"text": "hi"})));
/// assert_eq!(context.agent().id(), "mock-agent");
/// assert_eq!(context.tool_use().input, json!({"text": "hi"}));
/// ```
#[must_use]
pub fn tool_context(tool_use: ToolUse) -> ToolContext {
    ToolContext::new(tool_use, mock_tool_agent(), InvocationState::new())
}

fn mock_tool_agent() -> ToolAgent {
    ToolAgent::new("mock-agent", "mock-session", Arc::new(MockModel::new()))
}

/// An [`InvokeModelContext`] for calling a model-stage handler's logic on its own: the
/// `mock-agent` view and a [`MockModel`] as in [`tool_context`], `messages`, and no system
/// prompt, tools or tool choice. Set the public fields for anything else.
///
/// ```
/// use strands::Message;
/// use strands::testing::invoke_model_context;
///
/// let context = invoke_model_context(vec![Message::user("Hi")]);
/// assert_eq!(context.agent.id(), "mock-agent");
/// assert_eq!(context.messages.len(), 1);
/// ```
#[must_use]
pub fn invoke_model_context(messages: Vec<Message>) -> InvokeModelContext {
    let agent = mock_tool_agent();
    InvokeModelContext {
        model: agent.model().clone(),
        agent,
        messages,
        system_prompt: None,
        tool_specs: Vec::new(),
        tool_choice: None,
        invocation_state: InvocationState::new(),
        projected_input_tokens: None,
        dynamic_trailing_blocks: None,
        structured_output_schema: None,
        invocation_context: None,
    }
}

/// An [`ExecuteToolContext`] for calling a tool-stage handler's logic on its own: the
/// `mock-agent` view of [`tool_context`], no registered tool and a cancel signal that never
/// fires. Interrupts work as in an agent, with ids `middleware:executeTool:<toolUseId>:<name>`.
///
/// ```
/// use serde_json::json;
/// use strands::testing::execute_tool_context;
/// use strands::ToolUse;
///
/// let context = execute_tool_context(ToolUse::new("delete", "t-1", json!({})));
/// let error = context.interrupt("approve").unwrap_err();
/// assert_eq!(error.interrupts[0].id, "middleware:executeTool:t-1:approve");
/// ```
#[must_use]
pub fn execute_tool_context(tool_use: ToolUse) -> ExecuteToolContext {
    ExecuteToolContext::new(
        mock_tool_agent(),
        None,
        tool_use,
        InvocationState::new(),
        CancelHandle::new().signal(),
    )
}

/// An [`InjectionContext`] for `messages` on a mock agent (id `mock-agent`, empty app state), to
/// test an injection render callback or predicate on its own.
///
/// ```
/// use strands::Message;
/// use strands::injection::InjectionTrigger;
/// use strands::testing::injection_context;
///
/// let trigger = InjectionTrigger::predicate(|context| Ok(context.messages.len() > 1));
/// let context = injection_context(vec![Message::user("hi")]);
/// assert_eq!(context.agent.id(), "mock-agent");
/// # let _ = trigger;
/// ```
#[must_use]
pub fn injection_context(messages: Vec<Message>) -> InjectionContext {
    InjectionContext::new(messages, mock_tool_agent())
}

/// An [`Agent`] on `model`, with the printer off and no tools. Keep a clone of the model to
/// inspect the requests it received.
///
/// ```
/// use strands::testing::{MockModel, test_agent};
///
/// # tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
/// let model = MockModel::new().with_turn("Hello");
/// let mut agent = test_agent(model.clone());
/// let result = agent.invoke("Hi").await?;
/// assert_eq!(result.to_string(), "Hello");
/// assert_eq!(model.requests().len(), 1);
/// # Ok::<(), strands::Error>(())
/// # }).unwrap();
/// ```
#[must_use]
pub fn test_agent(model: MockModel) -> Agent {
    let config = AgentConfig {
        printer: Some(false),
        ..AgentConfig::default()
    };
    Agent::assemble(Arc::new(model), None, config)
}

/// Records the hook events that fire, by event type name, in order.
///
/// Register it on a [`HookRegistry`] with [`register`](Self::register), or pass it to an agent as
/// a [`Plugin`]. Clones share the recording.
///
/// ```
/// use strands::hooks::HookRegistry;
/// use strands::testing::HookRecorder;
///
/// let recorder = HookRecorder::new();
/// let hooks = HookRegistry::new();
/// recorder.register(&hooks);
/// assert_eq!(hooks.len(), 17);
/// assert!(recorder.events().is_empty());
/// ```
#[derive(Clone, Default)]
pub struct HookRecorder {
    events: Arc<Mutex<Vec<String>>>,
}

macro_rules! record_events {
    ($recorder:expr, $registry:expr; $($borrowing:ident),*; $($owned:ident),*) => {
        $(
            let events = $recorder.events.clone();
            $registry.add_hook(move |_: &mut $borrowing<'_>| push(&events, stringify!($borrowing)));
        )*
        $(
            let events = $recorder.events.clone();
            $registry.add_hook(move |_: &mut $owned| push(&events, stringify!($owned)));
        )*
    };
}

fn push(events: &Mutex<Vec<String>>, name: &str) {
    events
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push(name.to_owned());
}

impl HookRecorder {
    /// Creates an empty recorder.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a hook for every one of the 17 events.
    pub fn register(&self, registry: &HookRegistry) {
        record_events!(self, registry;
            InitializedEvent, BeforeInvocationEvent, AfterInvocationEvent, MessageAddedEvent,
            BeforeModelCallEvent, AfterModelCallEvent, ModelStreamUpdateEvent, ContentBlockEvent,
            ModelMessageEvent, BeforeToolsEvent, AfterToolsEvent, AgentResultEvent, InterruptEvent;
            BeforeToolCallEvent, AfterToolCallEvent, ToolStreamUpdateEvent, ToolResultEvent
        );
    }

    /// The names of the events fired so far, such as `BeforeInvocationEvent`.
    #[must_use]
    pub fn events(&self) -> Vec<String> {
        self.events.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// Forgets the recorded events.
    pub fn clear(&self) {
        self.events.lock().unwrap_or_else(PoisonError::into_inner).clear();
    }
}

impl fmt::Debug for HookRecorder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HookRecorder").field("events", &self.events()).finish()
    }
}

#[async_trait]
impl Plugin for HookRecorder {
    fn name(&self) -> &str {
        "strands:hook-recorder"
    }

    async fn init_agent(&self, agent: &mut LocalAgent) -> Result<()> {
        self.register(agent.hooks());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::test_support::{local_agent, tool_agent};

    #[tokio::test]
    async fn records_event_names_in_order() {
        let recorder = HookRecorder::new();
        let mut agent = local_agent();
        recorder.init_agent(&mut agent).await.unwrap();
        let hooks = agent.hooks().clone();
        let mut before = BeforeInvocationEvent::new(&mut agent, InvocationState::new(), Vec::new());
        hooks.invoke(&mut before).await.unwrap();
        let tool_use = ToolUse::new("t", "t-1", json!({}));
        let mut call = BeforeToolCallEvent::new(tool_agent(), InvocationState::new(), tool_use, None);
        hooks.invoke(&mut call).await.unwrap();
        let mut after = AfterInvocationEvent::new(&mut agent, InvocationState::new());
        hooks.invoke(&mut after).await.unwrap();
        assert_eq!(
            recorder.events(),
            ["BeforeInvocationEvent", "BeforeToolCallEvent", "AfterInvocationEvent"]
        );
        recorder.clear();
        assert!(recorder.events().is_empty());
    }
}
